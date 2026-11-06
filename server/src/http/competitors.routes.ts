import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { CompetitorService } from '../services/competitors.js';
import { toCompetitorDto, toSnapshotDto } from './dto.js';
import {
  competitorDto,
  competitorParams,
  createCompetitorBody,
  pollScheduledDto,
  snapshotDto,
  snapshotsQuery,
} from './schemas.js';

/** Parse, delegate, shape the reply. Failures are domain errors, mapped to statuses in app.ts. */
export function registerCompetitorRoutes(base: FastifyInstance, competitors: CompetitorService): void {
  const app = base.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/api/competitors',
    { schema: { response: { 200: z.array(competitorDto) } } },
    async () => (await competitors.list()).map(toCompetitorDto),
  );

  app.post(
    '/api/competitors',
    { schema: { body: createCompetitorBody, response: { 201: competitorDto } } },
    async (request, reply) => reply.code(201).send(toCompetitorDto(await competitors.track(request.body.id))),
  );

  app.delete(
    '/api/competitors/:id',
    { schema: { params: competitorParams, response: { 204: z.null() } } },
    async (request, reply) => {
      await competitors.remove(request.params.id);
      return reply.code(204).send(null);
    },
  );

  // Not in the contract: makes the competitor due now, so the next scheduler tick
  // (within a second) polls it. Used for the demo and the end-to-end checks.
  app.post(
    '/api/competitors/:id/poll',
    { schema: { params: competitorParams, response: { 202: pollScheduledDto } } },
    async (request, reply) => {
      await competitors.requestPoll(request.params.id);
      return reply.code(202).send({ id: request.params.id, status: 'poll scheduled' });
    },
  );

  app.get(
    '/api/competitors/:id/snapshots',
    { schema: { params: competitorParams, querystring: snapshotsQuery, response: { 200: z.array(snapshotDto) } } },
    async (request) => (await competitors.timeline(request.params.id, request.query)).map(toSnapshotDto),
  );
}
