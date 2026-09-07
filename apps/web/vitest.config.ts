import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Dexie's Node build talks straight to the IndexedDB globals polyfilled
    // by fake-indexeddb/auto below — no DOM/jsdom needed for these tests.
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
  },
});
