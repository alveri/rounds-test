import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { type CompetitorRow, competitors } from '../db/schema.js';

export function listCompetitors(db: Db): Promise<CompetitorRow[]> {
  return db.select().from(competitors).orderBy(asc(competitors.createdAt), asc(competitors.id));
}

/** Returns the new row, or undefined if the id is already tracked. */
export async function insertCompetitor(db: Db, id: string): Promise<CompetitorRow | undefined> {
  // next_poll_at defaults to now(): the first snapshot is taken on the next scheduler tick.
  const [row] = await db.insert(competitors).values({ id }).onConflictDoNothing({ target: competitors.id }).returning();
  return row;
}

/** Snapshots go with it (ON DELETE CASCADE). Returns false if the id was not tracked. */
export async function deleteCompetitor(db: Db, id: string): Promise<boolean> {
  const deleted = await db.delete(competitors).where(eq(competitors.id, id)).returning({ id: competitors.id });
  return deleted.length > 0;
}

export async function competitorExists(db: Db, id: string): Promise<boolean> {
  const found = await db.select({ id: competitors.id }).from(competitors).where(eq(competitors.id, id));
  return found.length > 0;
}

/**
 * Claims up to `limit` competitors whose poll is due and has no live lease, moves their
 * `next_poll_at` one interval ahead and takes the lease, all in one statement.
 *
 * The lease is separate from the schedule because the schedule can move back ("Check now").
 * At most one poll per competitor is in flight, which matters because every fetch consumes
 * a version from the source and snapshots must be stored in the order they were fetched.
 * `pollOnce` releases the lease; if the process dies first, it expires after `leaseMs`.
 *
 * A competitor overdue by many intervals (after downtime) is polled once, not once per
 * missed interval.
 */
export async function claimDue(
  db: Db,
  limit: number,
  intervalSeconds: number,
  now: Date,
  leaseMs: number,
): Promise<string[]> {
  if (limit <= 0) return [];
  const next = new Date(now.getTime() + intervalSeconds * 1000);
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const result = await db.execute<{ id: string }>(sql`
    UPDATE ${competitors}
    SET next_poll_at = ${next.toISOString()}::timestamptz,
        poll_lease_until = ${leaseUntil.toISOString()}::timestamptz
    WHERE id IN (
      SELECT id FROM ${competitors}
      WHERE next_poll_at <= ${now.toISOString()}::timestamptz
        AND (poll_lease_until IS NULL OR poll_lease_until <= ${now.toISOString()}::timestamptz)
      ORDER BY next_poll_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`);
  return result.rows.map((row) => row.id);
}

/**
 * Makes a competitor due now, so the next tick polls it, or, if a poll is in flight, the
 * first tick after that poll finishes. Returns false if it is not tracked.
 */
export async function requestPoll(db: Db, competitorId: string, now: Date): Promise<boolean> {
  const updated = await db
    .update(competitors)
    .set({ nextPollAt: now })
    .where(eq(competitors.id, competitorId))
    .returning({ id: competitors.id });
  return updated.length > 0;
}

/** Records a failed fetch and releases the lease. */
export async function recordPollError(db: Db, competitorId: string, message: string, at: Date): Promise<void> {
  await db
    .update(competitors)
    .set({ lastPolledAt: at, lastPollError: message, pollLeaseUntil: null })
    .where(eq(competitors.id, competitorId));
}
