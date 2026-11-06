import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/db/client.js';
import { TEST_DATABASE_URL } from '../test-db.js';

describe('createDatabase', () => {
  it('aborts a statement that runs past the timeout', async () => {
    const database = createDatabase(TEST_DATABASE_URL, { maxConnections: 1, statementTimeoutMs: 50 });
    try {
      await expect(database.pool.query('SELECT pg_sleep(5)')).rejects.toThrow(/statement timeout/);
    } finally {
      await database.close();
    }
  });

  it('fails instead of waiting for ever when the pool is exhausted', async () => {
    const database = createDatabase(TEST_DATABASE_URL, { maxConnections: 1, connectTimeoutMs: 50 });
    const held = await database.pool.connect();
    try {
      await expect(database.pool.query('SELECT 1')).rejects.toThrow(/timeout/i);
    } finally {
      held.release();
      await database.close();
    }
  });
});
