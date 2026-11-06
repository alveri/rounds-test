import { sql } from 'drizzle-orm';
import { createDatabase, type Database } from '../src/db/client.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://competitorpulse:competitorpulse@localhost:5433/competitorpulse_test';

export function openTestDatabase(): Database {
  return createDatabase(TEST_DATABASE_URL, { maxConnections: 5 });
}

/** Every integration test starts from empty tables. */
export async function resetTables(database: Database): Promise<void> {
  await database.db.execute(sql`TRUNCATE snapshots, competitors RESTART IDENTITY CASCADE`);
}
