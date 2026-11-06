import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Db } from '../db/client.js';
import type { Clock } from '../lib/clock.js';
import { retryFailedSummaries } from '../services/summaries.js';
import { requeuedDto } from './schemas.js';

export function registerSummaryRoutes(base: FastifyInstance, db: Db, clock: Clock): void {
  const app = base.withTypeProvider<ZodTypeProvider>();

  // Not in the contract: recovery after an LLM outage or a bad API key. Each requeued
  // summary gets a fresh attempt budget, so this can cost up to LLM_MAX_ATTEMPTS calls each.
  app.post(
    '/api/summaries/retry-failed',
    { schema: { response: { 200: requeuedDto } } },
    async () => ({ requeued: await retryFailedSummaries(db, clock) }),
  );
}
