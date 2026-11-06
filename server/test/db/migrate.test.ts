import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { TEST_DATABASE_URL } from '../test-db.js';

/** A database of its own: this test needs one with no migrations applied yet. */
const NAME = 'competitorpulse_migrate_test';

async function admin(statement: string): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = '/postgres';
  const client = new pg.Client({ connectionString: url.href });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  await admin(`DROP DATABASE IF EXISTS ${NAME}`);
  await admin(`CREATE DATABASE ${NAME}`);
});
afterAll(() => admin(`DROP DATABASE IF EXISTS ${NAME}`));

describe('runMigrations', () => {
  it('lets two replicas start together on an empty database', async () => {
    const url = new URL(TEST_DATABASE_URL);
    url.pathname = `/${NAME}`;
    const a = createDatabase(url.href, { maxConnections: 1 });
    const b = createDatabase(url.href, { maxConnections: 1 });
    try {
      await Promise.all([runMigrations(a.pool), runMigrations(b.pool)]);

      const applied = await a.pool.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
      expect(applied.rows[0].n).toBe(3);
      const lock = await a.pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'");
      expect(lock.rows[0].n).toBe(0);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });
});
