import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export interface Database {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  maxConnections?: number;
  /** Bounds waiting for a connection, so an exhausted pool fails instead of hanging a tick. */
  connectTimeoutMs?: number;
  /** Bounds each statement, so a stuck query cannot hold a pool slot for ever. */
  statementTimeoutMs?: number;
}

export function createDatabase(url: string, options: DatabaseOptions = {}): Database {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.maxConnections ?? 10,
    ...(options.connectTimeoutMs === undefined ? {} : { connectionTimeoutMillis: options.connectTimeoutMs }),
    ...(options.statementTimeoutMs === undefined ? {} : { statement_timeout: options.statementTimeoutMs }),
  });
  // An idle client losing its connection must not crash the process; the pool replaces it.
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
