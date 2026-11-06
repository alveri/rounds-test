import { fileURLToPath } from 'node:url';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { competitors, snapshots } from '../../src/db/schema.js';
import type { Listing } from '../../src/domain/listing.js';
import { claimDue, requestPoll } from '../../src/repositories/competitors.js';
import { pollOnce } from '../../src/services/polling.js';
import { type ListingSource, ListingNotFoundError } from '../../src/source/listing-source.js';
import { FixtureSequence, loadFixtures } from '../../src/stub/fixture-sequence.js';
import { openTestDatabase, resetTables } from '../test-db.js';

const database = openTestDatabase();
const { db } = database;
afterAll(() => database.close());
beforeEach(() => resetTables(database));

const FIXTURES = fileURLToPath(new URL('../../fixtures/listings.json', import.meta.url));
const T0 = new Date('2026-09-10T12:00:00Z');
const INTERVAL = 900;
const LEASE_MS = 40_000;

/** A clock the test moves by hand. */
function manualClock(start = T0) {
  let now = start.getTime();
  return {
    clock: () => new Date(now),
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
  };
}

/** The real fixture sequence, in-process, counting calls. */
async function fixtureSource() {
  const sequence = new FixtureSequence(await loadFixtures(FIXTURES));
  const source: ListingSource & { calls: number } = {
    calls: 0,
    async fetch(id) {
      source.calls += 1;
      const listing = sequence.next(id);
      if (!listing) throw new ListingNotFoundError(id);
      return listing;
    },
  };
  return source;
}

/** A source whose fetches finish only when the test says so, one at a time. */
function heldSource() {
  const pending: Array<(listing: Listing) => void> = [];
  const source: ListingSource = {
    fetch: () => new Promise((resolve) => pending.push(resolve)),
  };
  return {
    source,
    inFlight: () => pending.length,
    finishFetch(price: string) {
      const resolve = pending.shift();
      if (!resolve) throw new Error('no fetch in flight');
      resolve({ title: 't', tagline: 'g', price, description: 'd' });
    },
  };
}

async function addCompetitor(id: string, nextPollAt = T0) {
  await db.insert(competitors).values({ id, createdAt: T0, nextPollAt });
}

const history = (id: string) =>
  db.select().from(snapshots).where(eq(snapshots.competitorId, id)).orderBy(asc(snapshots.id));

describe('pollOnce over the provided acme-crm fixtures', () => {
  it('stores every poll and marks exactly the changed ones pending', async () => {
    const source = await fixtureSource();
    const { clock, advance } = manualClock();
    await addCompetitor('acme-crm');

    const outcomes = [];
    for (let i = 0; i < 6; i++) {
      outcomes.push((await pollOnce({ db, source, clock }, 'acme-crm')).kind);
      advance(INTERVAL);
    }

    expect(outcomes).toEqual(['initial', 'changed', 'changed', 'changed', 'unchanged', 'unchanged']);

    const rows = await history('acme-crm');
    expect(rows.map((r) => r.changed)).toEqual([false, true, true, true, false, false]);
    expect(rows.map((r) => r.summaryStatus)).toEqual(['none', 'pending', 'pending', 'pending', 'none', 'none']);
    expect(rows.map((r) => r.price)).toEqual(['$29/mo', '$39/mo', '$39/mo', '$39/mo', '$39/mo', '$39/mo']);
    expect(rows.map((r) => r.summary)).toEqual([null, null, null, null, null, null]);

    // Each snapshot points at the one before it; the first has nothing to compare with.
    expect(rows.map((r) => r.previousId)).toEqual([null, ...rows.slice(0, -1).map((r) => r.id)]);
    // Pending rows are due for the summary worker straight away.
    expect(rows[1]?.summaryNextAttemptAt?.toISOString()).toBe('2026-09-10T12:15:00.000Z');
    expect(rows.map((r) => r.fetchedAt.toISOString())).toEqual([
      '2026-09-10T12:00:00.000Z',
      '2026-09-10T12:15:00.000Z',
      '2026-09-10T12:30:00.000Z',
      '2026-09-10T12:45:00.000Z',
      '2026-09-10T13:00:00.000Z',
      '2026-09-10T13:15:00.000Z',
    ]);
    expect(source.calls).toBe(6);

    const [competitor] = await db.select().from(competitors);
    expect(competitor?.lastPolledAt?.toISOString()).toBe('2026-09-10T13:15:00.000Z');
  });
});

describe('pollOnce failure paths', () => {
  it('records a source error without creating a snapshot, and clears it on the next success', async () => {
    const { clock } = manualClock();
    await addCompetitor('does-not-exist');
    const source = await fixtureSource();

    const outcome = await pollOnce({ db, source, clock }, 'does-not-exist');

    expect(outcome).toEqual({ kind: 'error', message: expect.stringMatching(/does not know/) });
    expect(await history('does-not-exist')).toHaveLength(0);
    const [failed] = await db.select().from(competitors);
    expect(failed?.lastPollError).toMatch(/does not know/);

    const listing: Listing = { title: 't', tagline: 'g', price: 'p', description: 'd' };
    await pollOnce({ db, source: { fetch: async () => listing }, clock }, 'does-not-exist');
    const [recovered] = await db.select().from(competitors);
    expect(recovered?.lastPollError).toBeNull();
  });

  it('discards the result when the competitor is deleted during the fetch', async () => {
    const { clock } = manualClock();
    await addCompetitor('acme-crm');
    const source: ListingSource = {
      async fetch() {
        await db.delete(competitors).where(eq(competitors.id, 'acme-crm'));
        return { title: 't', tagline: 'g', price: 'p', description: 'd' };
      },
    };

    expect(await pollOnce({ db, source, clock }, 'acme-crm')).toEqual({ kind: 'gone' });
    expect(await db.select().from(snapshots)).toHaveLength(0);
  });

  it('treats whitespace-only differences as unchanged', async () => {
    const { clock } = manualClock();
    await addCompetitor('acme-crm');
    const listing: Listing = { title: 'Acme', tagline: 'CRM', price: '$29/mo', description: 'Leads.' };
    await pollOnce({ db, source: { fetch: async () => listing }, clock }, 'acme-crm');
    const padded = { ...listing, price: '  $29/mo\n' };

    const outcome = await pollOnce({ db, source: { fetch: async () => padded }, clock }, 'acme-crm');

    expect(outcome.kind).toBe('unchanged');
  });
});

describe('claimDue', () => {
  it('claims due competitors once and schedules them one interval ahead', async () => {
    await addCompetitor('a', new Date('2026-09-10T11:00:00Z'));
    await addCompetitor('b', T0);
    await addCompetitor('c', new Date('2026-09-10T12:05:00Z')); // not due yet

    const claimed = await claimDue(db, 10, INTERVAL, T0, LEASE_MS);
    expect(claimed.sort()).toEqual(['a', 'b']);
    expect(await claimDue(db, 10, INTERVAL, T0, LEASE_MS)).toEqual([]);

    const rows = await db.select().from(competitors).orderBy(asc(competitors.id));
    expect(rows.map((r) => r.nextPollAt.toISOString())).toEqual([
      '2026-09-10T12:15:00.000Z',
      '2026-09-10T12:15:00.000Z',
      '2026-09-10T12:05:00.000Z',
    ]);
  });

  it('polls a long-overdue competitor once, not once per missed interval', async () => {
    await addCompetitor('a', new Date('2026-09-09T12:00:00Z')); // a day of downtime

    expect(await claimDue(db, 10, INTERVAL, T0, LEASE_MS)).toEqual(['a']);
    expect(await claimDue(db, 10, INTERVAL, T0, LEASE_MS)).toEqual([]);
  });

  it('respects the limit, oldest due first', async () => {
    await addCompetitor('late', new Date('2026-09-10T11:59:00Z'));
    await addCompetitor('later', T0);
    await addCompetitor('earliest', new Date('2026-09-10T11:00:00Z'));

    expect(await claimDue(db, 2, INTERVAL, T0, LEASE_MS)).toEqual(expect.arrayContaining(['earliest', 'late']));
    expect(await claimDue(db, 0, INTERVAL, T0, LEASE_MS)).toEqual([]);
  });

  it('never hands the same competitor to two concurrent claimers', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `c${i}`);
    await db.insert(competitors).values(ids.map((id) => ({ id, nextPollAt: T0 })));

    const results = await Promise.all(Array.from({ length: 4 }, () => claimDue(db, 15, INTERVAL, T0, LEASE_MS)));

    const all = results.flat();
    expect(all).toHaveLength(ids.length);
    expect(new Set(all).size).toBe(ids.length);
  });
});

describe('requestPoll', () => {
  it('makes a competitor due now and reports untracked ids', async () => {
    await addCompetitor('acme-crm', new Date('2026-09-10T13:00:00Z'));

    expect(await requestPoll(db, 'acme-crm', T0)).toBe(true);
    expect(await claimDue(db, 10, INTERVAL, T0, LEASE_MS)).toEqual(['acme-crm']);
    expect(await requestPoll(db, 'nobody', T0)).toBe(false);
  });
});

describe('the poll lease', () => {
  it('"Check now" during a slow fetch waits for it, so snapshots keep the fetch order', async () => {
    const { clock } = manualClock();
    const held = heldSource();
    const { source } = held;
    await addCompetitor('acme-crm');

    expect(await claimDue(db, 10, INTERVAL, clock(), LEASE_MS)).toEqual(['acme-crm']);
    const slowPoll = pollOnce({ db, source, clock }, 'acme-crm');

    // The user clicks "Check now" mid-fetch: it must not start a second, overlapping poll.
    await requestPoll(db, 'acme-crm', clock());
    expect(await claimDue(db, 10, INTERVAL, clock(), LEASE_MS)).toEqual([]);
    expect(held.inFlight()).toBe(1);

    held.finishFetch('$1');
    await slowPoll;

    // The click is not lost: the competitor is claimed as soon as the first poll is done.
    expect(await claimDue(db, 10, INTERVAL, clock(), LEASE_MS)).toEqual(['acme-crm']);
    const secondPoll = pollOnce({ db, source, clock }, 'acme-crm');
    held.finishFetch('$2');
    await secondPoll;

    expect((await history('acme-crm')).map((r) => r.price)).toEqual(['$1', '$2']);
  });

  it('keeps an interval shorter than the fetch from starting an overlapping poll', async () => {
    const { clock, advance } = manualClock();
    const shortInterval = 5;
    await addCompetitor('acme-crm');

    expect(await claimDue(db, 10, shortInterval, clock(), LEASE_MS)).toEqual(['acme-crm']);
    advance(shortInterval);
    expect(await claimDue(db, 10, shortInterval, clock(), LEASE_MS)).toEqual([]);
  });

  it('expires, so a competitor is not stuck after the process dies mid-fetch', async () => {
    const { clock, advance } = manualClock();
    await addCompetitor('acme-crm');
    expect(await claimDue(db, 10, INTERVAL, clock(), LEASE_MS)).toEqual(['acme-crm']);
    // No pollOnce follows: the process is gone.
    await requestPoll(db, 'acme-crm', clock());

    advance(LEASE_MS / 1000 - 1);
    expect(await claimDue(db, 10, INTERVAL, clock(), LEASE_MS)).toEqual([]);
    advance(1);
    expect(await claimDue(db, 10, INTERVAL, clock(), LEASE_MS)).toEqual(['acme-crm']);
  });

  it('is released when the fetch fails', async () => {
    const { clock } = manualClock();
    const source: ListingSource = {
      fetch: () => Promise.reject(new ListingNotFoundError('acme-crm')),
    };
    await addCompetitor('acme-crm');
    await claimDue(db, 10, INTERVAL, clock(), LEASE_MS);

    expect((await pollOnce({ db, source, clock }, 'acme-crm')).kind).toBe('error');

    const [row] = await db.select().from(competitors);
    expect(row?.pollLeaseUntil).toBeNull();
  });
});
