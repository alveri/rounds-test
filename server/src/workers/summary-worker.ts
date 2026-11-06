import { errorMessage, type Logger } from '../lib/logger.js';
import { type Loop, startLoop, TaskSet } from '../lib/loop.js';
import type { Counters } from '../lib/metrics.js';
import { type ClaimedSummary, claimPending } from '../repositories/snapshots.js';
import { type SummaryDeps, summarizeOnce, type SummaryOutcome } from '../services/summaries.js';

export interface SummaryWorkerOptions extends SummaryDeps {
  concurrency: number;
  tickMs?: number;
  log: Logger;
  counters?: Counters;
}

/**
 * Picks up pending snapshots every tick, at most `concurrency` LLM calls at once. Runs
 * independently of polling: a hanging LLM only fills these slots, never the poll loop.
 */
export function startSummaryWorker(options: SummaryWorkerOptions): Loop {
  const { db, clock, concurrency, timeoutMs, log, counters } = options;
  const inFlight = new TaskSet();
  const shutdown = new AbortController();
  const leaseMs = timeoutMs + 30_000;

  const loop = startLoop(
    'summary',
    options.tickMs ?? 1000,
    async () => {
      const claims = await claimPending(db, concurrency - inFlight.size, clock(), leaseMs);
      for (const claim of claims) {
        inFlight.add(
          summarizeOnce(options, claim, shutdown.signal).then(
            (outcome) => {
              counters?.inc('competitorpulse_summary_attempts_total', { outcome: outcome.kind });
              logOutcome(log, claim, outcome);
            },
            (err: unknown) => {
              counters?.inc('competitorpulse_summary_attempts_total', { outcome: 'crashed' });
              log.error({ snapshotId: claim.id, attempt: claim.attempt, err: errorMessage(err) }, 'summary crashed');
            },
          ),
        );
      }
    },
    log,
  );

  return {
    async stop() {
      await loop.stop();
      shutdown.abort();
      await inFlight.drain();
    },
    lastTickAt: () => loop.lastTickAt(),
  };
}

function logOutcome(log: Logger, claim: ClaimedSummary, outcome: SummaryOutcome): void {
  const fields = { snapshotId: claim.id, attempt: claim.attempt };
  switch (outcome.kind) {
    case 'ready':
      return log.info(fields, 'summary ready');
    case 'retry':
      return log.warn(
        { ...fields, err: outcome.error, nextAttemptAt: outcome.nextAttemptAt.toISOString() },
        'summary attempt failed, will retry',
      );
    case 'failed':
      return log.warn({ ...fields, err: outcome.error }, 'summary failed for good');
    case 'released':
      return log.info(fields, 'interrupted by shutdown, released for retry');
    case 'skipped':
      return log.info(fields, 'summary skipped: deleted or no longer pending');
  }
}
