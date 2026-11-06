import pg from 'pg';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { TEST_DATABASE_URL } from './test-db.js';

/**
 * Tests use their own database next to the dev one, so truncating tables never
 * wipes data you are looking at in the UI. Created on first run, migrated every run.
 */
export default async function setup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const name = url.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';

  const client = new pg.Client({ connectionString: admin.href });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount === 0) {
      await client.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
    }
  } finally {
    await client.end();
  }

  const database = createDatabase(TEST_DATABASE_URL, { maxConnections: 1 });
  try {
    await runMigrations(database.pool);
  } finally {
    await database.close();
  }
}
