import { drizzle } from 'drizzle-orm/node-postgres';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import { createDatabase } from './client.js';

// Both src/db/migrate.ts and dist/db/migrate.js sit two levels below server/.
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Arbitrary, but fixed: every migrator of this application takes the same lock. */
const MIGRATION_LOCK_ID = 7_243_911;

/**
 * Applies pending SQL migrations from server/drizzle. Drizzle's migrator takes no lock of its
 * own, so an advisory lock makes concurrent runs wait for each other and then find nothing to do.
 */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

// CLI: `npm run db:migrate`, and the compose `migrate` service.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const database = createDatabase(url, { maxConnections: 1 });
  try {
    await runMigrations(database.pool);
    console.log('migrations applied');
  } finally {
    await database.close();
  }
}
