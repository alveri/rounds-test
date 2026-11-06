import { errorMessage, type Logger } from '../lib/logger.js';
import { type Loop, startLoop, TaskSet } from '../lib/loop.js';
import type { Counters } from '../lib/metrics.js';
import { claimDue } from '../repositories/competitors.js';
import { type PollDeps, pollOnce, type PollOutcome } from '../services/polling.js';

/** Added to the fetch timeout: the lease must outlive the fetch and the write that follows it. */
const POLL_LEASE_MARGIN_MS = 30_000;

export interface PollingOptions extends PollDeps {
  intervalSeconds: number;
  concurrency: number;
  fetchTimeoutMs: number;
  tickMs?: number;
  log: Logger;
  counters?: Counters;
}

/**
 * Every tick claims only as many due competitors as there are free slots, and runs each
 * poll in the background. A slow source holds one slot (bounded by its fetch timeout)
 * without stopping the loop from serving the others.
 */
export function startPolling(options: PollingOptions): Loop {
  const { db, clock, intervalSeconds, concurrency, fetchTimeoutMs, log, counters } = options;
  const inFlight = new TaskSet();
  const leaseMs = fetchTimeoutMs + POLL_LEASE_MARGIN_MS;

  const loop = startLoop(
    'poll',
    options.tickMs ?? 1000,
    async () => {
      const ids = await claimDue(db, concurrency - inFlight.size, intervalSeconds, clock(), leaseMs);
      for (const competitorId of ids) {
        inFlight.add(
          pollOnce(options, competitorId).then(
            (outcome) => {
              counters?.inc('competitorpulse_polls_total', { outcome: outcome.kind });
              logOutcome(log, competitorId, outcome);
            },
            (err: unknown) => {
              counters?.inc('competitorpulse_polls_total', { outcome: 'crashed' });
              log.error({ competitorId, err: errorMessage(err) }, 'poll crashed');
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
      await inFlight.drain();
    },
    lastTickAt: () => loop.lastTickAt(),
  };
}

function logOutcome(log: Logger, competitorId: string, outcome: PollOutcome): void {
  if (outcome.kind === 'error') log.warn({ competitorId, err: outcome.message }, 'poll failed');
  else if (outcome.kind === 'gone') log.info({ competitorId }, 'deleted during fetch, result discarded');
  else log.info({ competitorId, kind: outcome.kind, snapshotId: outcome.snapshotId }, 'snapshot stored');
}
