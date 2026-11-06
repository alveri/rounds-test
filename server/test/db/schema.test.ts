import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { competitors, snapshots } from '../../src/db/schema.js';
import { openTestDatabase, resetTables } from '../test-db.js';

const database = openTestDatabase();
const { db } = database;

afterAll(() => database.close());
beforeEach(() => resetTables(database));

const listing = {
  title: 'Acme CRM',
  tagline: 'Simple CRM for small teams',
  price: '$29/mo',
  description: 'Track leads and deals in one place.',
  contentHash: 'h1',
};

describe('database schema after migrations', () => {
  it('has the indexes the poller, worker and timeline rely on', async () => {
    const result = await db.execute<{ indexname: string }>(
      sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`,
    );
    const names = result.rows.map((r) => r.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'competitors_due_idx',
        'snapshots_pending_idx',
        'snapshots_previous_idx',
        'snapshots_failed_idx',
        'snapshots_timeline_idx',
      ]),
    );
  });

  it('defaults a new competitor to be polled now and a snapshot to summary "none"', async () => {
    const [competitor] = await db.insert(competitors).values({ id: 'acme-crm' }).returning();
    expect(competitor?.nextPollAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    const [snapshot] = await db
      .insert(snapshots)
      .values({ competitorId: 'acme-crm', fetchedAt: new Date(), changed: false, ...listing })
      .returning();
    expect(snapshot?.summaryStatus).toBe('none');
    expect(snapshot?.summaryAttempts).toBe(0);
  });

  it('deleting a competitor deletes its history', async () => {
    await db.insert(competitors).values({ id: 'acme-crm' });
    const [first] = await db
      .insert(snapshots)
      .values({ competitorId: 'acme-crm', fetchedAt: new Date(), changed: false, ...listing })
      .returning();
    await db.insert(snapshots).values({
      competitorId: 'acme-crm',
      previousId: first?.id,
      fetchedAt: new Date(),
      changed: true,
      summaryStatus: 'pending',
      ...listing,
      contentHash: 'h2',
    });

    await db.delete(competitors).where(eq(competitors.id, 'acme-crm'));

    const left = await db.select().from(snapshots);
    expect(left).toHaveLength(0);
  });

  it('rejects a snapshot for an unknown competitor', async () => {
    await expect(
      db
        .insert(snapshots)
        .values({ competitorId: 'nobody', fetchedAt: new Date(), changed: false, ...listing }),
    ).rejects.toThrow();
  });
});
