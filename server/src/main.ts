import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createDatabase } from './db/client.js';
import { buildApp, type NamedLoop } from './http/app.js';
import { Counters } from './lib/metrics.js';
import { HttpListingSource } from './source/http-listing-source.js';
import { OpenAiSummaryClient } from './summary/openai-summary-client.js';
import { startPolling } from './workers/poll-worker.js';
import { startSummaryWorker } from './workers/summary-worker.js';

// Composition root. ROLE decides what this process runs: the HTTP API, the poll and summary
// loops, or all of them. They share nothing but the database, so they can scale separately.
// Every role serves /livez, /readyz and /metrics. Migrations are a separate deploy step.
const config = loadConfig();
const database = createDatabase(config.db.url, {
  maxConnections: config.db.poolSize,
  connectTimeoutMs: config.db.connectTimeoutMs,
  statementTimeoutMs: config.db.statementTimeoutMs,
});

const clock = () => new Date();
const serveApi = config.role !== 'worker';
const runWorkers = config.role !== 'api';

// src/main.ts and dist/main.js both sit two levels below the repository root.
const webDist = process.env.WEB_DIST ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
const staticDir = serveApi && existsSync(join(webDist, 'index.html')) ? webDist : undefined;

const loops: NamedLoop[] = [];
const counters = new Counters();
const app = buildApp(
  { db: database.db, clock, staticDir, serveApi, loops, counters, loopStallMs: config.loopStallMs },
  { logger: { level: config.logLevel } },
);

if (runWorkers) {
  const log = app.log;
  loops.push({
    name: 'poll',
    loop: startPolling({
      db: database.db,
      source: new HttpListingSource({
        baseUrl: config.poll.sourceUrl,
        timeoutMs: config.poll.fetchTimeoutMs,
      }),
      clock,
      intervalSeconds: config.poll.intervalSeconds,
      concurrency: config.poll.concurrency,
      fetchTimeoutMs: config.poll.fetchTimeoutMs,
      log: log.child({ component: 'poll' }),
      counters,
    }),
  });
  loops.push({
    name: 'summary',
    loop: startSummaryWorker({
      db: database.db,
      client: new OpenAiSummaryClient({
        baseUrl: config.llm.baseUrl,
        apiKey: config.llm.apiKey,
        model: config.llm.model,
      }),
      clock,
      timeoutMs: config.llm.timeoutMs,
      maxAttempts: config.llm.maxAttempts,
      backoffMs: config.llm.backoffMs,
      concurrency: config.llm.concurrency,
      log: log.child({ component: 'summary' }),
      counters,
    }),
  });
}

app.log.info(
  {
    role: config.role,
    web: staticDir ?? null,
    poll: { intervalSeconds: config.poll.intervalSeconds, concurrency: config.poll.concurrency, source: config.poll.sourceUrl },
    llm: {
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      timeoutMs: config.llm.timeoutMs,
      maxAttempts: config.llm.maxAttempts,
      concurrency: config.llm.concurrency,
    },
  },
  'starting',
);

await app.listen({ port: config.port, host: '0.0.0.0' });

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'stop claiming work, finish in-flight polls, close');
  await Promise.all(loops.map(({ loop }) => loop.stop()));
  await app.close();
  await database.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
