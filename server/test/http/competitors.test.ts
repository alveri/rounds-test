import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { competitors, snapshots } from '../../src/db/schema.js';
import { buildApp } from '../../src/http/app.js';
import type { SnapshotDto } from '../../src/http/dto.js';
import { openTestDatabase, resetTables } from '../test-db.js';

const database = openTestDatabase();
const { db } = database;
const app = buildApp({ db });

afterAll(async () => {
  await app.close();
  await database.close();
});
beforeEach(() => resetTables(database));

const track = (id: string) => app.inject({ method: 'POST', url: '/api/competitors', payload: { id } });

describe('POST /api/competitors', () => {
  it('returns 201 and lists the competitor', async () => {
    const res = await track('acme-crm');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: 'acme-crm' });

    const list = await app.inject({ method: 'GET', url: '/api/competitors' });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([expect.objectContaining({ id: 'acme-crm', lastPolledAt: null })]);
  });

  it('returns 409 for an id that is already tracked', async () => {
    await track('acme-crm');
    const res = await track('acme-crm');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already tracked/);
  });

  it.each([
    ['uppercase', 'Acme-CRM'],
    ['spaces', 'acme crm'],
    ['leading dash', '-acme'],
    ['empty', ''],
    ['too long', 'a'.repeat(65)],
    ['path characters', '../etc'],
  ])('returns 400 for an invalid id (%s)', async (_case, id) => {
    const res = await track(id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/lowercase letters/);
  });

  it('returns 400 for a missing or malformed body', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/competitors', payload: {} })).statusCode).toBe(400);
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/competitors',
      headers: { 'content-type': 'application/json' },
      payload: '{"id":',
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('accepts an id the listing source does not know (polling reports it later)', async () => {
    expect((await track('does-not-exist')).statusCode).toBe(201);
  });
});

describe('DELETE /api/competitors/:id', () => {
  it('returns 204, removes it from the list and deletes its history', async () => {
    await track('acme-crm');
    await db.insert(snapshots).values(snapshotRow('acme-crm', 1));

    const res = await app.inject({ method: 'DELETE', url: '/api/competitors/acme-crm' });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    expect((await app.inject({ method: 'GET', url: '/api/competitors' })).json()).toEqual([]);
    expect(await db.select().from(snapshots)).toHaveLength(0);
  });

  it('returns 404 for an id that is not tracked', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/competitors/acme-crm' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/competitors/:id/snapshots', () => {
  it('returns the contract fields, newest first', async () => {
    await db.insert(competitors).values({ id: 'acme-crm' });
    const [first] = await db.insert(snapshots).values(snapshotRow('acme-crm', 1)).returning();
    await db.insert(snapshots).values({
      ...snapshotRow('acme-crm', 2),
      previousId: first?.id,
      price: '$39/mo',
      changed: true,
      summaryStatus: 'ready',
      summary: 'Price rose from $29/mo to $39/mo.',
    });

    const res = await app.inject({ method: 'GET', url: '/api/competitors/acme-crm/snapshots' });
    expect(res.statusCode).toBe(200);
    const body = res.json<SnapshotDto[]>();

    expect(body).toEqual([
      {
        id: expect.any(Number),
        fetchedAt: '2026-09-10T12:15:00.000Z',
        title: 'Acme CRM',
        tagline: 'Simple CRM for small teams',
        price: '$39/mo',
        description: 'Track leads and deals in one place.',
        changed: true,
        summary: 'Price rose from $29/mo to $39/mo.',
        summaryStatus: 'ready',
        initial: false,
      },
      {
        id: expect.any(Number),
        fetchedAt: '2026-09-10T12:00:00.000Z',
        title: 'Acme CRM',
        tagline: 'Simple CRM for small teams',
        price: '$29/mo',
        description: 'Track leads and deals in one place.',
        changed: false,
        summary: null,
        summaryStatus: 'none',
        initial: true,
      },
    ]);
  });

  it('hides any summary text that is not ready', async () => {
    await db.insert(competitors).values({ id: 'acme-crm' });
    await db
      .insert(snapshots)
      .values({ ...snapshotRow('acme-crm', 1), changed: true, summaryStatus: 'failed', summary: 'partial' });

    const [snapshot] = (await app.inject({ method: 'GET', url: '/api/competitors/acme-crm/snapshots' })).json<
      SnapshotDto[]
    >();
    expect(snapshot).toMatchObject({ summary: null, summaryStatus: 'failed' });
  });

  it('pages with limit and before', async () => {
    await db.insert(competitors).values({ id: 'acme-crm' });
    await db.insert(snapshots).values([1, 2, 3, 4, 5].map((n) => snapshotRow('acme-crm', n)));

    const page1 = (
      await app.inject({ method: 'GET', url: '/api/competitors/acme-crm/snapshots?limit=2' })
    ).json<SnapshotDto[]>();
    expect(page1.map((s) => s.fetchedAt)).toEqual(['2026-09-10T13:00:00.000Z', '2026-09-10T12:45:00.000Z']);

    const page2 = (
      await app.inject({
        method: 'GET',
        url: `/api/competitors/acme-crm/snapshots?limit=2&before=${page1.at(-1)?.id}`,
      })
    ).json<SnapshotDto[]>();
    expect(page2.map((s) => s.fetchedAt)).toEqual(['2026-09-10T12:30:00.000Z', '2026-09-10T12:15:00.000Z']);

    const bad = await app.inject({ method: 'GET', url: '/api/competitors/acme-crm/snapshots?limit=0' });
    expect(bad.statusCode).toBe(400);
  });

  it('returns an empty array before the first poll and 404 for an untracked id', async () => {
    await track('acme-crm');
    const empty = await app.inject({ method: 'GET', url: '/api/competitors/acme-crm/snapshots' });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);

    const missing = await app.inject({ method: 'GET', url: '/api/competitors/nobody/snapshots' });
    expect(missing.statusCode).toBe(404);
  });
});

describe('POST /api/competitors/:id/poll', () => {
  it('returns 202 for a tracked id and 404 otherwise', async () => {
    await track('acme-crm');
    const ok = await app.inject({ method: 'POST', url: '/api/competitors/acme-crm/poll' });
    expect(ok.statusCode).toBe(202);
    const missing = await app.inject({ method: 'POST', url: '/api/competitors/nobody/poll' });
    expect(missing.statusCode).toBe(404);
  });
});

describe('POST /api/summaries/retry-failed', () => {
  it('requeues failed summaries and reports how many', async () => {
    await track('acme-crm');
    await db.insert(snapshots).values({ ...snapshotRow('acme-crm', 1), changed: true, summaryStatus: 'failed' });

    const res = await app.inject({ method: 'POST', url: '/api/summaries/retry-failed' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ requeued: 1 });
    const [row] = await db.select().from(snapshots);
    expect(row?.summaryStatus).toBe('pending');
  });
});

describe('GET /health', () => {
  it('returns 200 when the database answers', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});

/** n-th snapshot, 15 minutes apart starting 2026-09-10T12:00Z. */
function snapshotRow(competitorId: string, n: number) {
  return {
    competitorId,
    fetchedAt: new Date(Date.UTC(2026, 8, 10, 12, 15 * (n - 1))),
    title: 'Acme CRM',
    tagline: 'Simple CRM for small teams',
    price: '$29/mo',
    description: 'Track leads and deals in one place.',
    contentHash: `h${n}`,
    changed: false,
  };
}
