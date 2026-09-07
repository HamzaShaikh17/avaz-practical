import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LocalStoreModule from '../lib/local-store';

/**
 * Re-imports lib/local-store.ts as a brand new module instance, simulating
 * an app restart: `vi.resetModules()` clears vitest's module registry, so
 * the next import re-runs the module top-to-bottom, creating a fresh
 * `dbInstance` singleton (a new Dexie *connection*) — while the underlying
 * fake-indexeddb database it connects to is untouched, exactly like a real
 * page reload reconnecting to the same on-disk IndexedDB database.
 */
async function freshLocalStore(): Promise<typeof LocalStoreModule> {
  vi.resetModules();
  return import('../lib/local-store');
}

function deleteUnderlyingDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('session-replay');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

// Each test gets a clean underlying database — restarts are simulated
// *within* a test via freshLocalStore(), not across tests.
beforeEach(async () => {
  await deleteUnderlyingDb();
});

describe('getNextDeviceSeq', () => {
  it('increments monotonically across calls', async () => {
    const store = await freshLocalStore();
    expect(await store.getNextDeviceSeq()).toBe(1);
    expect(await store.getNextDeviceSeq()).toBe(2);
    expect(await store.getNextDeviceSeq()).toBe(3);
  });

  it('persists across a simulated restart (fresh Dexie connection, same underlying db)', async () => {
    const before = await freshLocalStore();
    expect(await before.getNextDeviceSeq()).toBe(1);
    expect(await before.getNextDeviceSeq()).toBe(2);

    const afterRestart = await freshLocalStore();
    expect(await afterRestart.getNextDeviceSeq()).toBe(3);
    expect(await afterRestart.getNextDeviceSeq()).toBe(4);
  });

  it('does not reset just because a fresh connection has never called it before', async () => {
    const before = await freshLocalStore();
    await before.getNextDeviceSeq(); // 1
    await before.getNextDeviceSeq(); // 2
    await before.getNextDeviceSeq(); // 3

    const afterRestart = await freshLocalStore();
    // First call on the new connection continues the persisted count
    // rather than starting back at 1.
    expect(await afterRestart.getNextDeviceSeq()).toBe(4);
  });
});

describe('getOrCreateDeviceId', () => {
  it('returns the same id across a simulated restart', async () => {
    const before = await freshLocalStore();
    const idBeforeRestart = await before.getOrCreateDeviceId();

    const afterRestart = await freshLocalStore();
    const idAfterRestart = await afterRestart.getOrCreateDeviceId();

    expect(idAfterRestart).toBe(idBeforeRestart);
  });
});

describe('sessions and events', () => {
  it('startSession/appendEvent/getEventsForSession round-trip, ordered by the Phase 1 rule', async () => {
    const store = await freshLocalStore();
    const deviceId = await store.getOrCreateDeviceId();
    const sessionId = await store.startSession();

    // Out of order on purpose: deviceSeq 2 pushed before deviceSeq 1's
    // event, to confirm getEventsForSession re-sorts rather than trusting
    // insertion order.
    await store.appendEvent({
      id: 'event-2',
      type: 'tile_tap',
      sessionId,
      deviceId,
      deviceSeq: 2,
      clientTimestamp: '2026-09-07T08:00:02.000Z',
      tileId: 'tile-b',
      phraseText: 'b',
    });
    await store.appendEvent({
      id: 'event-1',
      type: 'tile_tap',
      sessionId,
      deviceId,
      deviceSeq: 1,
      clientTimestamp: '2026-09-07T08:00:01.000Z',
      tileId: 'tile-a',
      phraseText: 'a',
    });

    const events = await store.getEventsForSession(sessionId);
    expect(events.map((e) => e.id)).toEqual(['event-1', 'event-2']);
  });

  it('orders events from two devices with overlapping timestamps per the Phase 1 rule', async () => {
    // Rule under test (packages/shared/src/types.ts): within a device,
    // deviceSeq; across devices, clientTimestamp, with deviceId as the
    // final tiebreak for an exact timestamp tie.
    const store = await freshLocalStore();
    const sessionId = await store.startSession();
    const deviceA = 'device-a';
    const deviceB = 'device-b'; // lexicographically after deviceA — used for the tiebreak case below

    const a1 = {
      id: 'a1',
      type: 'tile_tap' as const,
      sessionId,
      deviceId: deviceA,
      deviceSeq: 1,
      clientTimestamp: '2026-09-07T08:00:00.000Z',
      tileId: 'tile-a1',
      phraseText: 'a1',
    };
    // Genuinely interleaves with device A's own sequence: later than a1,
    // earlier than a2.
    const b1 = {
      id: 'b1',
      type: 'tile_tap' as const,
      sessionId,
      deviceId: deviceB,
      deviceSeq: 1,
      clientTimestamp: '2026-09-07T08:00:02.000Z',
      tileId: 'tile-b1',
      phraseText: 'b1',
    };
    // a2 and b2 share the exact same clientTimestamp — an honest
    // cross-device tie, resolved by deviceId (deviceA < deviceB).
    const a2 = {
      id: 'a2',
      type: 'tile_tap' as const,
      sessionId,
      deviceId: deviceA,
      deviceSeq: 2,
      clientTimestamp: '2026-09-07T08:00:05.000Z',
      tileId: 'tile-a2',
      phraseText: 'a2',
    };
    const b2 = {
      id: 'b2',
      type: 'tile_tap' as const,
      sessionId,
      deviceId: deviceB,
      deviceSeq: 2,
      clientTimestamp: '2026-09-07T08:00:05.000Z',
      tileId: 'tile-b2',
      phraseText: 'b2',
    };

    // Inserted in a scrambled order, deliberately not matching the correct
    // output order, so this can only pass if getEventsForSession actually
    // sorts rather than trusting insertion/push order.
    for (const event of [b2, a1, b1, a2]) {
      await store.appendEvent(event);
    }

    const events = await store.getEventsForSession(sessionId);
    expect(events.map((e) => e.id)).toEqual(['a1', 'b1', 'a2', 'b2']);
  });

  it('breaks a same-device, same-timestamp tie by deviceSeq', async () => {
    // Rare (two taps landing in the same millisecond on one device), but
    // the ordering rule's final tiebreak specifically covers it.
    const store = await freshLocalStore();
    const sessionId = await store.startSession();
    const deviceId = 'device-a';
    const sameTimestamp = '2026-09-07T08:00:00.000Z';

    await store.appendEvent({
      id: 'second',
      type: 'tile_tap',
      sessionId,
      deviceId,
      deviceSeq: 2,
      clientTimestamp: sameTimestamp,
      tileId: 'tile-2',
      phraseText: 'second',
    });
    await store.appendEvent({
      id: 'first',
      type: 'tile_tap',
      sessionId,
      deviceId,
      deviceSeq: 1,
      clientTimestamp: sameTimestamp,
      tileId: 'tile-1',
      phraseText: 'first',
    });

    const events = await store.getEventsForSession(sessionId);
    expect(events.map((e) => e.id)).toEqual(['first', 'second']);
  });

  it('closeSession sets endedAt and is idempotent', async () => {
    const store = await freshLocalStore();
    const sessionId = await store.startSession();

    await store.closeSession(sessionId);
    const [{ sessions }] = await store.getSessionsGroupedByDay();
    const firstEndedAt = sessions.find((s) => s.id === sessionId)?.endedAt;
    expect(firstEndedAt).not.toBeNull();

    // A second close should not move endedAt.
    await store.closeSession(sessionId);
    const [{ sessions: sessionsAfter }] = await store.getSessionsGroupedByDay();
    expect(sessionsAfter.find((s) => s.id === sessionId)?.endedAt).toBe(firstEndedAt);
  });
});
