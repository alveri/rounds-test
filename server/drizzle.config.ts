import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` diffs schema.ts against server/drizzle and needs no database.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
