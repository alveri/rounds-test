import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/client.js';
import type { Clock } from '../lib/clock.js';
import type { Loop } from '../lib/loop.js';
import { type Counters, gauge } from '../lib/metrics.js';
import { readQueueStats } from '../repositories/metrics.js';

export interface NamedLoop {
  name: string;
  loop: Loop;
}

export interface OpsDependencies {
  db: Db;
  clock: Clock;
  /** The loops this process runs. A list the composition root may still be filling. */
  loops: readonly NamedLoop[];
  counters: Counters;
  loopStallMs: number;
}

/** Probes fire every few seconds; only their failures belong in the logs. */
const quiet = { logLevel: 'warn' as const };

export function registerOpsRoutes(app: FastifyInstance, deps: OpsDependencies): void {
  const { db, clock, loops, counters, loopStallMs } = deps;

  const ageSeconds = (loop: Loop) => (clock().getTime() - loop.lastTickAt().getTime()) / 1000;

  // Liveness: restart me if this fails. It must not depend on the database, or a database
  // outage would restart every instance. A stuck loop is something a restart can fix.
  app.get('/livez', quiet, async (_request, reply) => {
    const stalled = loops.filter(({ loop }) => ageSeconds(loop) * 1000 > loopStallMs).map(({ name }) => name);
    if (stalled.length > 0) return reply.code(503).send({ status: 'stalled', loops: stalled });
    return { status: 'ok' };
  });

  // Readiness: send me traffic only if this passes.
  const ready = async (_request: unknown, reply: FastifyReply) => {
    try {
      await db.execute(sql`SELECT 1`);
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'database unavailable' });
    }
  };
  app.get('/readyz', quiet, ready);
  app.get('/health', quiet, ready);

  app.get('/metrics', quiet, async (_request, reply) => {
    const stats = await readQueueStats(db, clock());
    const lines = [
      '# TYPE competitorpulse_competitors gauge',
      gauge('competitorpulse_competitors', stats.competitors),
      '# TYPE competitorpulse_competitors_failing gauge',
      gauge('competitorpulse_competitors_failing', stats.competitorsFailing),
      '# TYPE competitorpulse_poll_lag_seconds gauge',
      gauge('competitorpulse_poll_lag_seconds', stats.pollLagSeconds),
      '# TYPE competitorpulse_summaries gauge',
      gauge('competitorpulse_summaries', stats.summariesPending, { status: 'pending' }),
      gauge('competitorpulse_summaries', stats.summariesFailed, { status: 'failed' }),
      '# TYPE competitorpulse_loop_tick_age_seconds gauge',
      ...loops.map(({ name, loop }) => gauge('competitorpulse_loop_tick_age_seconds', ageSeconds(loop), { loop: name })),
      ...counters.render(),
    ];
    return reply.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
  });
}
