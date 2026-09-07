// Polyfills the global `indexedDB` / `IDBKeyRange` that Dexie needs, since
// vitest's `node` environment has no real IndexedDB implementation.
import 'fake-indexeddb/auto';
