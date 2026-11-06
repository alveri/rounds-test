import type { Db } from '../db/client.js';
import type { SnapshotRow } from '../db/schema.js';
import { diffListings, type Listing } from '../domain/listing.js';
import { DEFAULT_BACKOFF_MS, retryDelayMs } from '../domain/retry-policy.js';
import type { Clock } from '../lib/clock.js';
import { errorMessage } from '../lib/logger.js';
import {
  type ClaimedSummary,
  findSnapshot,
  requeueFailedSummaries,
  type SummaryWrite,
  writeSummaryResult,
} from '../repositories/snapshots.js';
import { PermanentSummaryError, RateLimitedSummaryError, type SummaryClient } from '../summary/summary-client.js';

export interface SummaryDeps {
  db: Db;
  client: SummaryClient;
  clock: Clock;
  timeoutMs: number;
  maxAttempts: number;
  backoffMs?: readonly number[];
  /** Source of backoff jitter. Tests pass `() => 0` to get exact delays. */
  random?: () => number;
}

export type SummaryOutcome =
  | { kind: 'ready' }
  | { kind: 'retry'; nextAttemptAt: Date; error: string }
  | { kind: 'failed'; error: string }
  /** Shutdown interrupted the call; the row is due again. */
  | { kind: 'released' }
  /** The snapshot is gone (competitor deleted) or no longer pending. Nothing written. */
  | { kind: 'skipped' };

/** Generates and stores the summary for one claimed snapshot. */
export async function summarizeOnce(
  deps: SummaryDeps,
  claim: ClaimedSummary,
  shutdown?: AbortSignal,
): Promise<SummaryOutcome> {
  const { db, client, clock, timeoutMs, maxAttempts } = deps;

  const write = async (outcome: SummaryWrite): Promise<SummaryOutcome> => {
    if (!(await writeSummaryResult(db, claim.id, outcome))) return { kind: 'skipped' };
    if (outcome.kind === 'ready') return { kind: 'ready' };
    if (outcome.kind === 'released') return { kind: 'released' };
    return outcome;
  };

  // Every claim counts an attempt, but only a call that returns can reach the check in the
  // catch below. Without this one, a process that dies mid-call would retry without limit.
  if (claim.attempt > maxAttempts) {
    return write({
      kind: 'failed',
      error: `no result after ${maxAttempts} attempts: the process stopped during the call`,
    });
  }

  const current = await findSnapshot(db, claim.id);
  if (!current || current.summaryStatus !== 'pending') return { kind: 'skipped' };
  const previous = current.previousId === null ? undefined : await findSnapshot(db, current.previousId);
  if (!previous) return write({ kind: 'failed', error: 'previous snapshot not found' });

  const before = toListing(previous);
  const after = toListing(current);
  const changes = diffListings(before, after);
  if (changes.length === 0) {
    return write({ kind: 'failed', error: 'snapshot marked changed but no field differs' });
  }

  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = shutdown ? AbortSignal.any([timeout, shutdown]) : timeout;
  try {
    const summary = await client.summarize(
      { competitorId: current.competitorId, previous: before, current: after, changes },
      signal,
    );
    return await write({ kind: 'ready', summary });
  } catch (err) {
    if (shutdown?.aborted && !timeout.aborted) {
      return write({ kind: 'released', nextAttemptAt: clock() });
    }
    if (err instanceof PermanentSummaryError) return write({ kind: 'failed', error: err.message });

    const error = timeout.aborted ? `LLM call timed out after ${timeoutMs} ms` : errorMessage(err);
    if (claim.attempt >= maxAttempts) {
      return write({ kind: 'failed', error: `${error} (attempt ${claim.attempt}/${maxAttempts})` });
    }
    const pause = retryDelayMs(
      claim.attempt,
      deps.backoffMs ?? DEFAULT_BACKOFF_MS,
      deps.random ?? Math.random,
      err instanceof RateLimitedSummaryError ? err.retryAfterMs : 0,
    );
    return write({ kind: 'retry', nextAttemptAt: new Date(clock().getTime() + pause), error });
  }
}

/** Recovery after an outage or a bad API key: every failed summary gets a fresh attempt budget. */
export function retryFailedSummaries(db: Db, clock: Clock): Promise<number> {
  return requeueFailedSummaries(db, clock());
}

function toListing(row: SnapshotRow): Listing {
  return { title: row.title, tagline: row.tagline, price: row.price, description: row.description };
}
