import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LocalStoreModule from '../lib/local-store';
import type * as SyncEngineModule from '../lib/sync-engine';

/**
 * Same restart-simulation technique as test/local-store.test.ts:
 * vi.resetModules() + re-import gives fresh module-level singletons
 * (Dexie connection, sync-engine's in-flight flag) while the underlying
 * fake-indexeddb database — and mocked fetch, set up separately per test —
 * are untouched.
 */
async function freshModules(): Promise<{
  store: typeof LocalStoreModule;
  engine: typeof SyncEngineModule;
}> {
  vi.resetModules();
  const [store, engine] = await Promise.all([
    import('../lib/local-store'),
    import('../lib/sync-engine'),
  ]);
  return { store, engine };
}

function deleteUnderlyingDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('session-replay');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  await deleteUnderlyingDb();
  vi.unstubAllGlobals();
});

/** Minimal Response-shaped object — enough for sync-engine's `res.ok` + `res.json()` usage. */
function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

describe('syncNow — push', () => {
  it('pushes an event created offline once connectivity returns, and does not re-push it on a later sync call', async () => {
    const { store, engine } = await freshModules();

    const deviceId = await store.getOrCreateDeviceId();
    const sessionId = await store.startSession();
    await store.appendEvent({
      id: 'evt-offline-1',
      type: 'tile_tap',
      sessionId,
      deviceId,
      deviceSeq: 1,
      clientTimestamp: '2026-09-07T09:00:00.000Z',
      tileId: 'yes',
      phraseText: 'yes',
    });

    // "Created offline" just means: nothing has hit the network yet. The
    // event sits locally with synced: false until syncNow() is called —
    // simulating connectivity returning is simply calling it now.
    const pushRequests: unknown[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/sync/push')) {
        const body = JSON.parse(init!.body as string) as { events: { id: string }[] };
        pushRequests.push(body);
        return jsonResponse({ accepted: body.events.map((e) => e.id), duplicates: [] });
      }
      if (url.includes('/api/sync/pull')) {
        return jsonResponse({ events: [], sessions: [], cursor: '1' });
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { onLine: true });

    const first = await engine.syncNow();
    expect(first.pushed).toBe(1);
    expect(pushRequests).toHaveLength(1);

    // The event is now marked synced locally...
    expect(await store.getUnsyncedEvents()).toEqual([]);

    // ...so a second sync call has nothing left to push, and never even
    // makes a push request — the strongest form of "not duplicated".
    const pushCallCountBeforeSecondSync = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/api/sync/push'),
    ).length;
    const second = await engine.syncNow();
    expect(second.pushed).toBe(0);
    const pushCallCountAfterSecondSync = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/api/sync/push'),
    ).length;
    expect(pushCallCountAfterSecondSync).toBe(pushCallCountBeforeSecondSync);
    expect(pushRequests).toHaveLength(1); // still just the one push request, total
  });

  it('never produces a duplicate transcript line when a push is retried after its server ack was lost', async () => {
    // The scenario this covers: the push request actually succeeded
    // server-side, but the client's connection dropped before it could
    // read the response — so locally the event is still marked unsynced,
    // and a later sync retries pushing it. The server must recognize the
    // id and report it as a duplicate (not an error, not a second row);
    // the client must end up with exactly one local copy either way.
    const { store, engine } = await freshModules();

    const deviceId = await store.getOrCreateDeviceId();
    const sessionId = await store.startSession();
    const event = {
      id: 'evt-lost-ack',
      type: 'tile_tap' as const,
      sessionId,
      deviceId,
      deviceSeq: 1,
      clientTimestamp: '2026-09-07T09:00:00.000Z',
      tileId: 'yes',
      phraseText: 'yes',
    };
    await store.appendEvent(event);

    // Pre-seed the fake server's "already accepted" set with this event's
    // id, standing in for the earlier attempt whose ack the client never
    // saw. The client-side store has no idea this happened — synced is
    // still false locally.
    const acceptedByServer = new Set<string>([event.id]);
    const pushRequestEventIds: string[][] = [];

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/sync/push')) {
        const body = JSON.parse(init!.body as string) as { events: { id: string }[] };
        pushRequestEventIds.push(body.events.map((e) => e.id));
        const accepted: string[] = [];
        const duplicates: string[] = [];
        for (const e of body.events) {
          if (acceptedByServer.has(e.id)) {
            duplicates.push(e.id);
          } else {
            acceptedByServer.add(e.id);
            accepted.push(e.id);
          }
        }
        return jsonResponse({ accepted, duplicates });
      }
      if (url.includes('/api/sync/pull')) {
        // The server already had this event before this sync — a pull
        // echoes it back, same as it would for any already-pushed event.
        return jsonResponse({ events: [event], sessions: [], cursor: '1' });
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { onLine: true });

    const result = await engine.syncNow();

    // The retry did go out over the wire (this device didn't know it was
    // redundant)...
    expect(pushRequestEventIds).toEqual([[event.id]]);
    // ...and resolved via the duplicates path, not an error.
    expect(result.pushed).toBe(1);

    // The critical assertion: exactly one copy of this event ends up in
    // the transcript, whether via the push's duplicate-ack or the pull's
    // upsert-by-id — never two.
    const events = await store.getEventsForSession(sessionId);
    expect(events.filter((e) => e.id === event.id)).toHaveLength(1);
    expect(await store.getUnsyncedEvents()).toEqual([]);
  });

  it('stays offline-silent: no fetch call at all, and pending events remain pending', async () => {
    const { store, engine } = await freshModules();
    const deviceId = await store.getOrCreateDeviceId();
    const sessionId = await store.startSession();
    await store.appendEvent({
      id: 'evt-1',
      type: 'clear_bar',
      sessionId,
      deviceId,
      deviceSeq: 1,
      clientTimestamp: '2026-09-07T09:00:00.000Z',
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { onLine: false });

    const result = await engine.syncNow();

    expect(result).toEqual({ pushed: 0, pulled: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await store.getUnsyncedEvents()).toHaveLength(1);
  });
});

describe('syncNow — pull', () => {
  it('merges an event from another device into the local store without clobbering a local event in the same session', async () => {
    const { store, engine } = await freshModules();

    const localDeviceId = await store.getOrCreateDeviceId();
    const sessionId = await store.startSession();
    await store.appendEvent({
      id: 'local-evt',
      type: 'tile_tap',
      sessionId,
      deviceId: localDeviceId,
      deviceSeq: 1,
      clientTimestamp: '2026-09-07T09:00:00.000Z',
      tileId: 'yes',
      phraseText: 'yes',
    });

    const otherDeviceId = 'other-device-0000-0000-000000000000';
    const remoteEvent = {
      id: 'remote-evt',
      type: 'tile_tap' as const,
      sessionId, // same session, contributed from a second device
      deviceId: otherDeviceId,
      deviceSeq: 1,
      clientTimestamp: '2026-09-07T09:00:05.000Z',
      tileId: 'more',
      phraseText: 'more',
    };

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/sync/push')) {
        const body = JSON.parse(init!.body as string) as { events: { id: string }[] };
        return jsonResponse({ accepted: body.events.map((e) => e.id), duplicates: [] });
      }
      if (url.includes('/api/sync/pull')) {
        return jsonResponse({ events: [remoteEvent], sessions: [], cursor: '7' });
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { onLine: true });

    const result = await engine.syncNow();
    expect(result.pulled).toBe(1); // 1 event + 0 sessions in the pull response

    const events = await store.getEventsForSession(sessionId);
    expect(events.map((e) => e.id).sort()).toEqual(['local-evt', 'remote-evt']);

    // The local event's own fields are untouched by the merge.
    const localEventAfter = events.find((e) => e.id === 'local-evt');
    expect(localEventAfter).toMatchObject({
      deviceId: localDeviceId,
      phraseText: 'yes',
      deviceSeq: 1,
    });

    // The remote event landed with its own device's identity intact.
    const remoteEventAfter = events.find((e) => e.id === 'remote-evt');
    expect(remoteEventAfter).toMatchObject({
      deviceId: otherDeviceId,
      phraseText: 'more',
    });

    expect(await store.getSyncCursor()).toBe('7');
  });

  it('threads the stored cursor into the next pull and never re-fetches already-pulled events', async () => {
    // Unlike the other tests' canned pull responses, this mock is a genuine
    // (tiny) stateful fake server that actually filters by the `since`
    // query param it receives — so this test fails if syncNow() ever sends
    // the wrong cursor (or none at all) on a follow-up pull, not just if it
    // forgets to store one.
    const { store, engine } = await freshModules();

    interface ServerRow {
      id: string;
      serverSeq: number;
      [key: string]: unknown;
    }
    const serverEvents: ServerRow[] = [];
    let nextServerSeq = 1;
    const sessionId = 'shared-session';
    const otherDeviceId = 'other-device';

    function seedServerEvent(id: string, phraseText: string) {
      serverEvents.push({
        id,
        type: 'tile_tap',
        sessionId,
        deviceId: otherDeviceId,
        deviceSeq: serverEvents.length + 1,
        clientTimestamp: `2026-09-07T09:00:0${serverEvents.length}.000Z`,
        tileId: phraseText,
        phraseText,
        serverSeq: nextServerSeq++,
      });
    }

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/sync/pull')) {
        const since = new URL(url, 'http://localhost').searchParams.get('since');
        const sinceSeq = since ? Number(since) : 0;
        const matching = serverEvents.filter((e) => e.serverSeq > sinceSeq);
        const maxSeq = matching.reduce((max, e) => Math.max(max, e.serverSeq), sinceSeq);
        return jsonResponse({
          events: matching.map(({ serverSeq: _serverSeq, ...event }) => event),
          sessions: [],
          cursor: String(maxSeq),
        });
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { onLine: true });

    // Two events already on the server before this device ever syncs (as
    // if pushed by another device earlier).
    seedServerEvent('remote-1', 'a');
    seedServerEvent('remote-2', 'b');

    // Fresh device, no stored cursor: first pull must return everything.
    const first = await engine.syncNow();
    expect(first.pulled).toBe(2);
    expect(await store.getSyncCursor()).toBe('2');

    // A third event lands on the server only after this device's first sync.
    seedServerEvent('remote-3', 'c');

    const second = await engine.syncNow();
    expect(second.pulled).toBe(1); // only the new one, not the two already-pulled events again

    const pullCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/api/sync/pull'),
    );
    expect(pullCalls).toHaveLength(2);
    // The second pull actually carried the cursor from the first, not a
    // stale/empty one.
    expect(String(pullCalls[1][0])).toContain('since=2');

    const events = await store.getEventsForSession(sessionId);
    expect(events.map((e) => e.id).sort()).toEqual(['remote-1', 'remote-2', 'remote-3']);
    expect(await store.getSyncCursor()).toBe('3');
  });
});
