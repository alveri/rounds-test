import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { competitors, snapshots } from '../../src/db/schema.js';
import { buildApp, type NamedLoop } from '../../src/http/app.js';
import type { Db } from '../../src/db/client.js';
import { Counters } from '../../src/lib/metrics.js';
import { openTestDatabase, resetTables } from '../test-db.js';

const database = openTestDatabase();
const { db } = database;
afterAll(() => database.close());
beforeEach(() => resetTables(database));

const NOW = new Date('2026-09-10T12:00:00Z');
const clock = () => NOW;
const STALL_MS = 120_000;

const loopThatTicked = (name: string, secondsAgo: number): NamedLoop => ({
  name,
  loop: { stop: async () => {}, lastTickAt: () => new Date(NOW.getTime() - secondsAgo * 1000) },
});

describe('GET /livez', () => {
  it('passes while the loops tick and names a stalled one', async () => {
    const healthy = buildApp({ db, clock, loopStallMs: STALL_MS, loops: [loopThatTicked('poll', 1)] });
    expect((await healthy.inject({ url: '/livez' })).statusCode).toBe(200);

    const stuck = buildApp({
      db,
      clock,
      loopStallMs: STALL_MS,
      loops: [loopThatTicked('poll', 1), loopThatTicked('summary', 121)],
    });
    const res = await stuck.inject({ url: '/livez' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'stalled', loops: ['summary'] });
  });

  it('does not touch the database, so an outage does not restart every instance', async () => {
    const noDb = new Proxy({}, { get: () => { throw new Error('database touched'); } }) as Db;
    const app = buildApp({ db: noDb, clock, loops: [] });

    expect((await app.inject({ url: '/livez' })).statusCode).toBe(200);
  });
});

describe('GET /readyz', () => {
  it('reflects the database', async () => {
    const ready = buildApp({ db, clock });
    expect((await ready.inject({ url: '/readyz' })).statusCode).toBe(200);

    const down = { execute: () => Promise.reject(new Error('connection refused')) } as unknown as Db;
    const unready = buildApp({ db: down, clock });
    const res = await unready.inject({ url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'database unavailable' });
  });
});

describe('GET /metrics', () => {
  it('reports queue depth, poll lag, loop age and counters in the Prometheus format', async () => {
    await db.insert(competitors).values([
      { id: 'late', nextPollAt: new Date(NOW.getTime() - 90_000), lastPollError: 'boom' },
      { id: 'future', nextPollAt: new Date(NOW.getTime() + 90_000) },
    ]);
    const row = {
      competitorId: 'late',
      fetchedAt: NOW,
      title: 't',
      tagline: 'g',
      price: 'p',
      description: 'd',
      contentHash: 'h',
      changed: true,
    };
    await db.insert(snapshots).values([
      { ...row, summaryStatus: 'pending' },
      { ...row, summaryStatus: 'pending' },
      { ...row, summaryStatus: 'failed' },
      { ...row, summaryStatus: 'ready' },
    ]);
    const counters = new Counters();
    counters.inc('competitorpulse_summary_attempts_total', { outcome: 'ready' });
    counters.inc('competitorpulse_summary_attempts_total', { outcome: 'ready' });
    const app = buildApp({ db, clock, counters, loops: [loopThatTicked('poll', 3)] });

    const res = await app.inject({ url: '/metrics' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    const lines = res.body.split('\n');
    expect(lines).toEqual(
      expect.arrayContaining([
        'competitorpulse_competitors 2',
        'competitorpulse_competitors_failing 1',
        'competitorpulse_poll_lag_seconds 90',
        'competitorpulse_summaries{status="pending"} 2',
        'competitorpulse_summaries{status="failed"} 1',
        'competitorpulse_loop_tick_age_seconds{loop="poll"} 3',
        '# TYPE competitorpulse_summary_attempts_total counter',
        'competitorpulse_summary_attempts_total{outcome="ready"} 2',
      ]),
    );
  });

  it('reports no lag when nothing is overdue', async () => {
    await db.insert(competitors).values({ id: 'future', nextPollAt: new Date(NOW.getTime() + 90_000) });
    const res = await buildApp({ db, clock }).inject({ url: '/metrics' });
    expect(res.body).toContain('competitorpulse_poll_lag_seconds 0\n');
  });
});

describe('ROLE=worker', () => {
  it('serves the probes and metrics but not the API', async () => {
    const app = buildApp({ db, clock, serveApi: false });
    expect((await app.inject({ url: '/livez' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/metrics' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/competitors' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/openapi.json' })).statusCode).toBe(404);
  });
});

describe('GET /openapi.json', () => {
  it('describes the contract endpoints', async () => {
    const res = await buildApp({ db, clock }).inject({ url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const paths = (res.json() as { paths: Record<string, unknown> }).paths;
    expect(Object.keys(paths)).toEqual(
      expect.arrayContaining(['/api/competitors', '/api/competitors/{id}', '/api/competitors/{id}/snapshots']),
    );
  });
});
