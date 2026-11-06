import { fileURLToPath } from 'node:url';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { competitors, snapshots } from '../../src/db/schema.js';
import type { Listing } from '../../src/domain/listing.js';
import { claimPending } from '../../src/repositories/snapshots.js';
import { pollOnce } from '../../src/services/polling.js';
import { retryFailedSummaries, type SummaryDeps, summarizeOnce } from '../../src/services/summaries.js';
import type { ListingSource } from '../../src/source/listing-source.js';
import { FixtureSequence, loadFixtures } from '../../src/stub/fixture-sequence.js';
import {
  PermanentSummaryError,
  RateLimitedSummaryError,
  type SummaryClient,
  type SummaryInput,
} from '../../src/summary/summary-client.js';
import { openTestDatabase, resetTables } from '../test-db.js';

const database = openTestDatabase();
const { db } = database;
afterAll(() => database.close());
beforeEach(() => resetTables(database));

const FIXTURES = fileURLToPath(new URL('../../fixtures/listings.json', import.meta.url));
const T0 = new Date('2026-09-10T12:00:00Z');
const LEASE_MS = 60_000;

function manualClock() {
  let now = T0.getTime();
  return { clock: () => new Date(now), advance: (ms: number) => void (now += ms) };
}

/** A SummaryClient whose behaviour each test scripts, recording what it was sent. */
function scriptedClient(behaviour: (input: SummaryInput, signal: AbortSignal) => Promise<string>) {
  const calls: SummaryInput[] = [];
  const client: SummaryClient = {
    summarize(input, signal) {
      calls.push(input);
      return behaviour(input, signal);
    },
  };
  return { client, calls };
}

const v1: Listing = { title: 'Acme CRM', tagline: 'Simple', price: '$39/mo', description: 'Leads.' };
const v2: Listing = { ...v1, price: '$29/mo', description: 'Leads. Free-forever plan.' };

/** Two polls of `acme-crm`: an initial snapshot, then a changed one left pending. */
async function seedChangedSnapshot(clock: () => Date): Promise<number> {
  await db.insert(competitors).values({ id: 'acme-crm' });
  let listing = v1;
  const source: ListingSource = { fetch: async () => listing };
  await pollOnce({ db, source, clock }, 'acme-crm');
  listing = v2;
  const outcome = await pollOnce({ db, source, clock }, 'acme-crm');
  if (outcome.kind !== 'changed') throw new Error(`expected a changed snapshot, got ${outcome.kind}`);
  return outcome.snapshotId;
}

/** One worker tick, run inline: claim what is due and summarise it. */
async function runWorkerTick(deps: SummaryDeps) {
  const claims = await claimPending(db, 10, deps.clock(), LEASE_MS);
  return Promise.all(claims.map((claim) => summarizeOnce(deps, claim)));
}

const row = async (id: number) => {
  const found = await db.query.snapshots.findFirst({ where: eq(snapshots.id, id) });
  if (!found) throw new Error(`snapshot ${id} not found`);
  return found;
};

describe('summarizeOnce', () => {
  it('stores the summary and sends the previous and new listing with the changed fields', async () => {
    const { clock } = manualClock();
    const id = await seedChangedSnapshot(clock);
    const { client, calls } = scriptedClient(async () => 'Price dropped from $39/mo to $29/mo.');

    const outcomes = await runWorkerTick({ db, client, clock, timeoutMs: 1000, maxAttempts: 3 });

    expect(outcomes).toEqual([{ kind: 'ready' }]);
    expect(await row(id)).toMatchObject({
      summaryStatus: 'ready',
      summary: 'Price dropped from $39/mo to $29/mo.',
      summaryAttempts: 1,
      summaryError: null,
      summaryNextAttemptAt: null,
    });
    expect(calls).toEqual([
      {
        competitorId: 'acme-crm',
        previous: v1,
        current: v2,
        changes: [
          { field: 'price', before: '$39/mo', after: '$29/mo' },
          { field: 'description', before: 'Leads.', after: 'Leads. Free-forever plan.' },
        ],
      },
    ]);
  });

  it('retries with backoff and marks the summary failed after the last attempt, leaving the listing intact', async () => {
    const { clock, advance } = manualClock();
    const id = await seedChangedSnapshot(clock);
    const before = await row(id);
    const { client, calls } = scriptedClient(async () => {
      throw new Error('500 mock-llm-server: injected failure');
    });
    const deps = { db, client, clock, timeoutMs: 1000, maxAttempts: 3, backoffMs: [5_000, 20_000], random: () => 0 };

    expect((await runWorkerTick(deps))[0]).toMatchObject({ kind: 'retry' });
    expect(await row(id)).toMatchObject({ summaryStatus: 'pending', summaryAttempts: 1 });

    advance(4_000);
    expect(await runWorkerTick(deps)).toEqual([]); // not due yet: backoff is 5 s
    advance(1_000);
    expect((await runWorkerTick(deps))[0]).toMatchObject({ kind: 'retry' });
    advance(19_000);
    expect(await runWorkerTick(deps)).toEqual([]); // second backoff is 20 s
    advance(1_000);
    expect((await runWorkerTick(deps))[0]).toMatchObject({ kind: 'failed' });

    const after = await row(id);
    expect(after).toMatchObject({
      summaryStatus: 'failed',
      summary: null,
      summaryAttempts: 3,
      summaryNextAttemptAt: null,
      summaryError: expect.stringMatching(/injected failure \(attempt 3\/3\)/),
    });
    // The snapshot itself is untouched.
    for (const field of ['title', 'tagline', 'price', 'description', 'fetchedAt', 'changed', 'contentHash'] as const) {
      expect(after[field]).toEqual(before[field]);
    }
    expect(calls).toHaveLength(3);

    advance(3_600_000);
    expect(await runWorkerTick(deps)).toEqual([]); // failed rows are never picked up again
  });

  it('aborts a hanging LLM call at the timeout', async () => {
    const { clock } = manualClock();
    const id = await seedChangedSnapshot(clock);
    const { client } = scriptedClient(
      (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );

    const started = Date.now();
    const [outcome] = await runWorkerTick({ db, client, clock, timeoutMs: 100, maxAttempts: 3 });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(outcome).toMatchObject({ kind: 'retry', error: 'LLM call timed out after 100 ms' });
    expect(await row(id)).toMatchObject({ summaryStatus: 'pending', summaryError: 'LLM call timed out after 100 ms' });
  });

  it('never overwrites a summary that is already stored', async () => {
    const { clock } = manualClock();
    const id = await seedChangedSnapshot(clock);
    const [claim] = await claimPending(db, 10, clock(), LEASE_MS);
    if (!claim) throw new Error('nothing claimed');
    // Another worker finished this row while ours was still calling the LLM.
    await db.update(snapshots).set({ summaryStatus: 'ready', summary: 'first' }).where(eq(snapshots.id, id));
    const { client } = scriptedClient(async () => 'second');

    const outcome = await summarizeOnce({ db, client, clock, timeoutMs: 1000, maxAttempts: 3 }, claim);

    expect(outcome).toEqual({ kind: 'skipped' });
    expect((await row(id)).summary).toBe('first');
  });

  it('makes the row due again when shutdown interrupts the call, with the attempt still counted', async () => {
    const { clock } = manualClock();
    const id = await seedChangedSnapshot(clock);
    const shutdown = new AbortController();
    const { client } = scriptedClient(
      (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          shutdown.abort();
        }),
    );
    const [claim] = await claimPending(db, 10, clock(), LEASE_MS);
    if (!claim) throw new Error('nothing claimed');

    const outcome = await summarizeOnce(
      { db, client, clock, timeoutMs: 10_000, maxAttempts: 3 },
      claim,
      shutdown.signal,
    );

    expect(outcome).toEqual({ kind: 'released' });
    expect(await row(id)).toMatchObject({ summaryStatus: 'pending', summaryAttempts: 1 });
    expect(await claimPending(db, 10, clock(), LEASE_MS)).toEqual([{ id, attempt: 2 }]);
  });

  it('writes nothing when the competitor was deleted during the call', async () => {
    const { clock } = manualClock();
    await seedChangedSnapshot(clock);
    const { client } = scriptedClient(async () => {
      await db.delete(competitors).where(eq(competitors.id, 'acme-crm'));
      return 'too late';
    });

    expect(await runWorkerTick({ db, client, clock, timeoutMs: 1000, maxAttempts: 3 })).toEqual([
      { kind: 'skipped' },
    ]);
  });
});

describe('claimPending', () => {
  it('leases a row so a concurrent claim cannot take it, and frees it when the lease expires', async () => {
    const { clock, advance } = manualClock();
    const id = await seedChangedSnapshot(clock);

    const [a, b] = await Promise.all([
      claimPending(db, 10, clock(), LEASE_MS),
      claimPending(db, 10, clock(), LEASE_MS),
    ]);
    expect([...(a ?? []), ...(b ?? [])]).toEqual([{ id, attempt: 1 }]);

    // The process died mid-call: after the lease the row is due again.
    advance(LEASE_MS - 1);
    expect(await claimPending(db, 10, clock(), LEASE_MS)).toEqual([]);
    advance(1);
    expect(await claimPending(db, 10, clock(), LEASE_MS)).toEqual([{ id, attempt: 2 }]);
  });
});

describe('retry decisions', () => {
  it('fails at once on a permanent error, without spending the rest of the budget', async () => {
    const { clock } = manualClock();
    const id = await seedChangedSnapshot(clock);
    const { client, calls } = scriptedClient(async () => {
      throw new PermanentSummaryError('401 bad key');
    });

    const outcomes = await runWorkerTick({ db, client, clock, timeoutMs: 1000, maxAttempts: 8 });

    expect(outcomes).toEqual([{ kind: 'failed', error: '401 bad key' }]);
    expect(calls).toHaveLength(1);
    expect(await row(id)).toMatchObject({ summaryStatus: 'failed', summaryAttempts: 1 });
  });

  it('waits as long as the provider asks when it is rate limited', async () => {
    const { clock } = manualClock();
    await seedChangedSnapshot(clock);
    const { client } = scriptedClient(async () => {
      throw new RateLimitedSummaryError('429', 60_000);
    });
    const deps = { db, client, clock, timeoutMs: 1000, maxAttempts: 8, backoffMs: [5_000, 3_600_000], random: () => 0 };

    const [outcome] = await runWorkerTick(deps);

    expect(outcome).toMatchObject({ kind: 'retry', nextAttemptAt: new Date(T0.getTime() + 60_000) });
  });

  it('spreads retries with jitter', async () => {
    const { clock } = manualClock();
    await seedChangedSnapshot(clock);
    const { client } = scriptedClient(async () => {
      throw new Error('500');
    });
    const deps = { db, client, clock, timeoutMs: 1000, maxAttempts: 8, backoffMs: [10_000], random: () => 0.5 };

    const [outcome] = await runWorkerTick(deps);

    expect(outcome).toMatchObject({ kind: 'retry', nextAttemptAt: new Date(T0.getTime() + 11_000) });
  });
});

describe('retryFailedSummaries', () => {
  it('requeues failed summaries with a fresh budget, and nothing else', async () => {
    const { clock, advance } = manualClock();
    const id = await seedChangedSnapshot(clock);
    const failing = scriptedClient(async () => {
      throw new PermanentSummaryError('401 bad key');
    });
    await runWorkerTick({ db, client: failing.client, clock, timeoutMs: 1000, maxAttempts: 3 });
    expect(await row(id)).toMatchObject({ summaryStatus: 'failed' });

    advance(1_000);
    expect(await retryFailedSummaries(db, clock)).toBe(1);
    expect(await row(id)).toMatchObject({ summaryStatus: 'pending', summaryAttempts: 0, summaryError: null });
    expect(await retryFailedSummaries(db, clock)).toBe(0);

    const working = scriptedClient(async () => 'Price dropped.');
    expect(await runWorkerTick({ db, client: working.client, clock, timeoutMs: 1000, maxAttempts: 3 })).toEqual([
      { kind: 'ready' },
    ]);
    expect(await retryFailedSummaries(db, clock)).toBe(0); // a ready summary is never requeued
    expect(await row(id)).toMatchObject({ summaryStatus: 'ready', summary: 'Price dropped.' });
  });
});

describe('the attempt budget when the process dies mid-call', () => {
  /** A claim with no result: the LLM call started and the process was killed. */
  async function crashDuringCall(advance: (ms: number) => void, clock: () => Date) {
    expect(await claimPending(db, 10, clock(), LEASE_MS)).toHaveLength(1);
    advance(LEASE_MS);
  }

  it('fails the row without another LLM call once every attempt is used up', async () => {
    const { clock, advance } = manualClock();
    const id = await seedChangedSnapshot(clock);
    const { client, calls } = scriptedClient(async () => 'too late');
    const deps = { db, client, clock, timeoutMs: 1000, maxAttempts: 3 };

    for (let attempt = 0; attempt < 3; attempt++) await crashDuringCall(advance, clock);

    expect(await runWorkerTick(deps)).toEqual([
      { kind: 'failed', error: expect.stringMatching(/no result after 3 attempts/) },
    ]);
    expect(calls).toHaveLength(0);
    expect(await row(id)).toMatchObject({
      summaryStatus: 'failed',
      summary: null,
      summaryNextAttemptAt: null,
      summaryError: expect.stringMatching(/no result after 3 attempts/),
    });

    advance(3_600_000);
    expect(await runWorkerTick(deps)).toEqual([]);
  });

  it('still makes the last allowed call after earlier crashes', async () => {
    const { clock, advance } = manualClock();
    const id = await seedChangedSnapshot(clock);
    const { client, calls } = scriptedClient(async () => 'Price dropped.');
    const deps = { db, client, clock, timeoutMs: 1000, maxAttempts: 3 };

    for (let attempt = 0; attempt < 2; attempt++) await crashDuringCall(advance, clock);

    expect(await runWorkerTick(deps)).toEqual([{ kind: 'ready' }]);
    expect(calls).toHaveLength(1);
    expect(await row(id)).toMatchObject({ summaryStatus: 'ready', summary: 'Price dropped.' });
  });
});

describe('LLM cost over the provided fixtures', () => {
  it('calls the LLM once per change and never for unchanged or initial snapshots', async () => {
    const { clock, advance } = manualClock();
    const sequence = new FixtureSequence(await loadFixtures(FIXTURES));
    const source: ListingSource = {
      fetch: async (id) => {
        const listing = sequence.next(id);
        if (!listing) throw new Error(`unknown ${id}`);
        return listing;
      },
    };
    const { client, calls } = scriptedClient(async (input) => `changed: ${input.changes.map((c) => c.field).join(', ')}`);
    const ids = ['acme-crm', 'north-analytics', 'ferry-pay'];
    await db.insert(competitors).values(ids.map((id) => ({ id })));

    for (let poll = 0; poll < 8; poll++) {
      for (const id of ids) await pollOnce({ db, source, clock }, id);
      await runWorkerTick({ db, client, clock, timeoutMs: 1000, maxAttempts: 3 });
      advance(900_000);
    }

    // 8 polls each = 24 snapshots; 3 real changes per competitor = 9 LLM calls.
    const rows = await db.select().from(snapshots).orderBy(asc(snapshots.id));
    expect(rows).toHaveLength(24);
    expect(calls).toHaveLength(9);
    expect(rows.filter((r) => r.summaryStatus === 'ready')).toHaveLength(9);
    expect(rows.filter((r) => r.changed)).toHaveLength(9);
    expect(rows.filter((r) => !r.changed).every((r) => r.summaryStatus === 'none' && r.summary === null)).toBe(true);
  });
});
