import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { competitors, type SnapshotRow, snapshots, type SummaryStatus } from '../db/schema.js';
import { classifySnapshot, type Listing, type SnapshotKind } from '../domain/listing.js';

export function listSnapshots(
  db: Db,
  competitorId: string,
  page: { limit: number; before?: number | undefined },
): Promise<SnapshotRow[]> {
  // Newest first. Snapshot ids grow with insertion order, and the
  // (competitor_id, id DESC) index serves this query and its cursor.
  return db
    .select()
    .from(snapshots)
    .where(
      page.before === undefined
        ? eq(snapshots.competitorId, competitorId)
        : and(eq(snapshots.competitorId, competitorId), lt(snapshots.id, page.before)),
    )
    .orderBy(desc(snapshots.id))
    .limit(page.limit);
}

export type AppendResult = { kind: SnapshotKind; snapshotId: number } | { kind: 'gone' };

/**
 * One short transaction: lock the competitor, read its latest snapshot, insert the new one
 * and release the poll lease. A changed snapshot is stored as 'pending', which is what the
 * summary worker picks up.
 */
export function appendSnapshot(
  db: Db,
  competitorId: string,
  listing: Listing,
  contentHash: string,
  fetchedAt: Date,
): Promise<AppendResult> {
  return db.transaction(async (tx): Promise<AppendResult> => {
    // Serialises writers for this competitor and tells us whether it still exists.
    const locked = await tx
      .select({ id: competitors.id })
      .from(competitors)
      .where(eq(competitors.id, competitorId))
      .for('update');
    if (locked.length === 0) return { kind: 'gone' };

    const [previous] = await tx
      .select({ id: snapshots.id, contentHash: snapshots.contentHash })
      .from(snapshots)
      .where(eq(snapshots.competitorId, competitorId))
      .orderBy(desc(snapshots.id))
      .limit(1);

    const kind = classifySnapshot(previous?.contentHash, contentHash);
    const summaryStatus: SummaryStatus = kind === 'changed' ? 'pending' : 'none';

    const [inserted] = await tx
      .insert(snapshots)
      .values({
        competitorId,
        previousId: previous?.id ?? null,
        fetchedAt,
        ...listing,
        contentHash,
        changed: kind === 'changed',
        summaryStatus,
        summaryNextAttemptAt: kind === 'changed' ? fetchedAt : null,
      })
      .returning({ id: snapshots.id });
    if (!inserted) throw new Error('snapshot insert returned no row');

    await tx
      .update(competitors)
      .set({ lastPolledAt: fetchedAt, lastPollError: null, pollLeaseUntil: null })
      .where(eq(competitors.id, competitorId));

    return { kind, snapshotId: inserted.id };
  });
}

export interface ClaimedSummary {
  id: number;
  attempt: number;
}

/**
 * Claims up to `limit` pending snapshots that are due, counting the attempt and pushing
 * `summary_next_attempt_at` past the call's timeout. That lease means a process that dies
 * mid-call leaves the row to be retried later instead of stuck, and a second worker never
 * takes a row that is being summarised.
 */
export async function claimPending(
  db: Db,
  limit: number,
  now: Date,
  leaseMs: number,
): Promise<ClaimedSummary[]> {
  if (limit <= 0) return [];
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const result = await db.execute<{ id: string | number; summary_attempts: number }>(sql`
    UPDATE ${snapshots}
    SET summary_attempts = summary_attempts + 1,
        summary_next_attempt_at = ${leaseUntil.toISOString()}::timestamptz
    WHERE id IN (
      SELECT id FROM ${snapshots}
      WHERE summary_status = 'pending'
        AND summary_next_attempt_at <= ${now.toISOString()}::timestamptz
      ORDER BY summary_next_attempt_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, summary_attempts`);
  return result.rows.map((row) => ({ id: Number(row.id), attempt: row.summary_attempts }));
}

export async function findSnapshot(db: Db, id: number): Promise<SnapshotRow | undefined> {
  return db.query.snapshots.findFirst({ where: eq(snapshots.id, id) });
}

export type SummaryWrite =
  | { kind: 'ready'; summary: string }
  | { kind: 'retry'; nextAttemptAt: Date; error: string }
  | { kind: 'failed'; error: string }
  /** Shutdown interrupted the call: due again now. The attempt stays counted, the call may be billed. */
  | { kind: 'released'; nextAttemptAt: Date };

/**
 * Only the summary_* columns are written, and only while the row is still 'pending', so a
 * slow or failing LLM can neither touch the listing nor overwrite a stored summary.
 * Returns false if the row is gone or no longer pending.
 */
export async function writeSummaryResult(db: Db, id: number, write: SummaryWrite): Promise<boolean> {
  const values = (() => {
    switch (write.kind) {
      case 'ready':
        return {
          summary: write.summary,
          summaryStatus: 'ready' as const,
          summaryError: null,
          summaryNextAttemptAt: null,
        };
      case 'failed':
        return { summaryStatus: 'failed' as const, summaryError: write.error, summaryNextAttemptAt: null };
      case 'retry':
        return { summaryError: write.error, summaryNextAttemptAt: write.nextAttemptAt };
      case 'released':
        return { summaryNextAttemptAt: write.nextAttemptAt };
    }
  })();
  const written = await db
    .update(snapshots)
    .set(values)
    .where(and(eq(snapshots.id, id), eq(snapshots.summaryStatus, 'pending')))
    .returning({ id: snapshots.id });
  return written.length > 0;
}

/** Puts every failed summary back in the queue with a fresh attempt budget. Returns how many. */
export async function requeueFailedSummaries(db: Db, now: Date): Promise<number> {
  const requeued = await db
    .update(snapshots)
    .set({ summaryStatus: 'pending', summaryAttempts: 0, summaryError: null, summaryNextAttemptAt: now })
    .where(eq(snapshots.summaryStatus, 'failed'))
    .returning({ id: snapshots.id });
  return requeued.length;
}
