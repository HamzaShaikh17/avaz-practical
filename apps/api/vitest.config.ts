import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    // Relative to prisma/schema.prisma's directory, same as global-setup.ts.
    env: {
      DATABASE_URL: 'file:./test.db',
    },
    // All test files share one SQLite file; keep them serial to avoid
    // SQLITE_BUSY from concurrent writers.
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 20000,
  },
});
