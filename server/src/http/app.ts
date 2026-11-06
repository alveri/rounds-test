import fastifyStatic from '@fastify/static';
import fastifySwagger from '@fastify/swagger';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Db } from '../db/client.js';
import { AlreadyTrackedError, NotTrackedError } from '../domain/errors.js';
import type { Clock } from '../lib/clock.js';
import { Counters } from '../lib/metrics.js';
import { CompetitorService } from '../services/competitors.js';
import { registerCompetitorRoutes } from './competitors.routes.js';
import { type NamedLoop, registerOpsRoutes } from './ops.routes.js';
import { registerSummaryRoutes } from './summaries.routes.js';

export type { NamedLoop } from './ops.routes.js';

export interface AppDependencies {
  db: Db;
  clock?: Clock;
  /** Directory of the built web app (web/dist). Omitted in tests and API-only runs. */
  staticDir?: string | undefined;
  /** False for ROLE=worker: only the probes and metrics are served. */
  serveApi?: boolean;
  loops?: readonly NamedLoop[];
  counters?: Counters;
  loopStallMs?: number;
}

export function buildApp(deps: AppDependencies, options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(options);
  const clock = deps.clock ?? (() => new Date());

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof NotTrackedError) return reply.code(404).send({ error: error.message });
    if (error instanceof AlreadyTrackedError) return reply.code(409).send({ error: error.message });
    if (hasZodFastifySchemaValidationErrors(error)) {
      const message = error.validation.map((issue) => issue.message).join('; ');
      return reply.code(400).send({ error: message });
    }
    if (isResponseSerializationError(error)) {
      request.log.error(error);
      return reply.code(500).send({ error: 'internal server error' });
    }
    // Fastify's own client errors: malformed JSON, wrong content type, body too large.
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (error as Error).message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'internal server error' });
  });

  const { staticDir } = deps;
  if (staticDir) {
    // The built React app is served from the same origin as the API, so no CORS is needed.
    // Files are looked up per request (not listed once at startup), so a rebuilt bundle is
    // served without a restart.
    void app.register(fastifyStatic, { root: staticDir });
  }

  app.setNotFoundHandler((request, reply) => {
    // Client-side routes such as /competitors/acme-crm load the SPA shell. A missing file
    // (anything with an extension, e.g. a stale /assets/index-abc.js) stays a 404: answering
    // it with HTML would make the browser fail to parse it and render a blank page.
    const path = request.url.split('?')[0] ?? '';
    const isPage =
      request.method === 'GET' &&
      !path.startsWith('/api/') &&
      !/\.[a-z0-9]+$/i.test(path);
    if (staticDir && isPage) return reply.sendFile('index.html');
    return reply.code(404).send({ error: `no route for ${request.method} ${request.url}` });
  });

  registerOpsRoutes(app, {
    db: deps.db,
    clock,
    loops: deps.loops ?? [],
    counters: deps.counters ?? new Counters(),
    loopStallMs: deps.loopStallMs ?? 120_000,
  });

  if (deps.serveApi ?? true) {
    // Swagger collects routes as they are added, so they are registered after it has loaded.
    void app.register(fastifySwagger, {
      openapi: { info: { title: 'CompetitorPulse API', version: '0.1.0' } },
      transform: jsonSchemaTransform,
    });
    void app.register(async (api) => {
      registerCompetitorRoutes(api, new CompetitorService(deps.db, clock));
      registerSummaryRoutes(api, deps.db, clock);
      api.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());
    });
  }

  return app;
}
