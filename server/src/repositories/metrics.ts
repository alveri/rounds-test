import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';

export interface QueueStats {
  competitors: number;
  competitorsFailing: number;
  /** How far behind schedule the most overdue competitor is. */
  pollLagSeconds: number;
  summariesPending: number;
  summariesFailed: number;
}

/** Cheap enough to run on every scrape: small table, partial indexes on the snapshot counts. */
export async function readQueueStats(db: Db, now: Date): Promise<QueueStats> {
  const at = now.toISOString();
  const result = await db.execute<Record<keyof QueueStats, string | number>>(sql`
    SELECT
      (SELECT count(*) FROM competitors) AS "competitors",
      (SELECT count(*) FROM competitors WHERE last_poll_error IS NOT NULL) AS "competitorsFailing",
      (SELECT coalesce(extract(epoch FROM ${at}::timestamptz - min(next_poll_at)), 0)
         FROM competitors WHERE next_poll_at <= ${at}::timestamptz) AS "pollLagSeconds",
      (SELECT count(*) FROM snapshots WHERE summary_status = 'pending') AS "summariesPending",
      (SELECT count(*) FROM snapshots WHERE summary_status = 'failed') AS "summariesFailed"`);
  const row = result.rows[0];
  if (!row) throw new Error('queue stats query returned no row');
  return {
    competitors: Number(row.competitors),
    competitorsFailing: Number(row.competitorsFailing),
    pollLagSeconds: Number(row.pollLagSeconds),
    summariesPending: Number(row.summariesPending),
    summariesFailed: Number(row.summariesFailed),
  };
}
