import { z } from 'zod';
import { DEFAULT_BACKOFF_MS } from './domain/retry-policy.js';

const positiveInt = z.coerce.number().int().positive();

const envSchema = z.object({
  /** api: HTTP only. worker: poll and summary loops only. all: both, in one process. */
  ROLE: z.enum(['all', 'api', 'worker']).default('all'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_SIZE: positiveInt.default(10),
  DB_CONNECT_TIMEOUT_MS: positiveInt.default(5_000),
  DB_STATEMENT_TIMEOUT_MS: positiveInt.default(30_000),
  PORT: positiveInt.default(3000),
  LOOP_STALL_SECONDS: positiveInt.default(120),

  POLL_INTERVAL_SECONDS: positiveInt.default(900),
  POLL_CONCURRENCY: positiveInt.default(5),
  FETCH_TIMEOUT_MS: positiveInt.default(10_000),
  LISTING_SOURCE_URL: z.url().default('http://localhost:4002'),

  LLM_BASE_URL: z.url().default('http://localhost:4001/v1'),
  LLM_API_KEY: z.string().min(1).default('mock'),
  LLM_MODEL: z.string().min(1).default('mock-llm'),
  LLM_TIMEOUT_MS: positiveInt.default(15_000),
  LLM_MAX_ATTEMPTS: positiveInt.default(8),
  LLM_BACKOFF_SECONDS: z
    .string()
    .regex(/^\d+(,\d+)*$/, 'must be comma-separated seconds, e.g. 5,20,80')
    .optional(),
  LLM_CONCURRENCY: positiveInt.default(4),
});

export type Role = z.infer<typeof envSchema>['ROLE'];

export interface Config {
  role: Role;
  logLevel: string;
  port: number;
  loopStallMs: number;
  db: {
    url: string;
    poolSize: number;
    connectTimeoutMs: number;
    statementTimeoutMs: number;
  };
  poll: {
    intervalSeconds: number;
    concurrency: number;
    fetchTimeoutMs: number;
    sourceUrl: string;
  };
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    maxAttempts: number;
    backoffMs: number[];
    concurrency: number;
  };
}

/** Reads and validates the environment. Throws one error listing every invalid variable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const e = parsed.data;
  return {
    role: e.ROLE,
    logLevel: e.LOG_LEVEL,
    port: e.PORT,
    loopStallMs: e.LOOP_STALL_SECONDS * 1000,
    db: {
      url: e.DATABASE_URL,
      poolSize: e.DB_POOL_SIZE,
      connectTimeoutMs: e.DB_CONNECT_TIMEOUT_MS,
      statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
    },
    poll: {
      intervalSeconds: e.POLL_INTERVAL_SECONDS,
      concurrency: e.POLL_CONCURRENCY,
      fetchTimeoutMs: e.FETCH_TIMEOUT_MS,
      sourceUrl: e.LISTING_SOURCE_URL,
    },
    llm: {
      baseUrl: e.LLM_BASE_URL,
      apiKey: e.LLM_API_KEY,
      model: e.LLM_MODEL,
      timeoutMs: e.LLM_TIMEOUT_MS,
      maxAttempts: e.LLM_MAX_ATTEMPTS,
      backoffMs: e.LLM_BACKOFF_SECONDS?.split(',').map((seconds) => Number(seconds) * 1000) ?? DEFAULT_BACKOFF_MS,
      concurrency: e.LLM_CONCURRENCY,
    },
  };
}
