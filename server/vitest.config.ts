import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Integration tests share one database; running files in parallel would let one
    // file's TRUNCATE race another file's inserts.
    fileParallelism: false,
  },
});
