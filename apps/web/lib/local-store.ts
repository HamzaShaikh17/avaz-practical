import Dexie, { type Table } from 'dexie';
import type { Session, SessionEvent } from '@session-replay/shared';

/**
 * Local, client-side persistence for session-replay, backed by IndexedDB
 * (via Dexie) rather than localStorage.
 *
 * Why not localStorage:
 *  - Synchronous API. localStorage.getItem/setItem block the main thread,
 *    and the cost scales with how much you've already stored (some engines
 *    re-serialize the whole key on every write). `events` here is an
 *    append-only log that only grows for the life of a session — by the
 *    time a caregiver has been using this for a while, that's not a handful
 *    of writes, it's thousands. A tap-to-speak interaction can never afford
 *    to wait on that: "never add latency to tap-to-speak" is the whole
 *    point of writing locally first and syncing later, and a synchronous,
 *    linearly-slower-over-time store would quietly undermine that as the
 *    log grows.
 *  - No structured querying. localStorage is a flat string->string map — to
 *    answer "all events for this session, in order" you'd deserialize and
 *    scan everything yourself. IndexedDB gives us real indexes (sessionId,
 *    deviceId, clientTimestamp below) so getEventsForSession/
 *    getSessionsGroupedByDay are actual queries, not linear scans over a
 *    growing blob.
 *  - Storage quota. localStorage is conventionally capped around 5-10MB;
 *    IndexedDB's quota is a much larger, usually origin-storage-percentage
 *    based limit — the difference matters for a log that's meant to
 *    accumulate for the life of the device, not just a session.
 *  - Dexie's API is async by construction (wraps IndexedDB transactions in
 *    promises), which keeps every store function here off the main thread
 *    for exactly the same "don't block tap-to-speak" reason.
 */

interface MetaRow {
  key: string;
  value: string | number;
}

/**
 * Local-only extensions of the wire types, carrying a `synced` flag that
 * lib/sync-engine.ts uses to know what still needs pushing/closing. This is
 * deliberately NOT part of packages/shared/src/types.ts — "has this row
 * been synced" is meaningless to the server and to any other client, it's
 * purely this device's own bookkeeping about its own local copy.
 */
export type LocalEvent = SessionEvent & { synced: boolean };
export type LocalSession = Session & { synced: boolean };

const DEVICE_ID_KEY = 'deviceId';
const DEVICE_SEQ_KEY = 'deviceSeq';
const SYNC_CURSOR_KEY = 'syncCursor';
const LAST_SYNCED_AT_KEY = 'lastSyncedAt';

class LocalStoreDatabase extends Dexie {
  events!: Table<LocalEvent, string>;
  sessions!: Table<LocalSession, string>;
  meta!: Table<MetaRow, string>;

  constructor() {
    super('session-replay');
    this.version(1).stores({
      // Primary key first (no `++` prefix — ids are client-generated
      // UUIDs, not Dexie auto-increment); the rest are indexes we actually
      // query on below.
      events: 'id, sessionId, deviceId, clientTimestamp, [deviceId+deviceSeq]',
      sessions: 'id, deviceId, startedAt, endedAt',
      meta: 'key',
    });
    // v2 adds the `synced` field used by lib/sync-engine.ts. It's NOT
    // declared as a Dexie index below — IndexedDB doesn't support boolean
    // as an indexable key type at all, so getUnsyncedEvents/
    // getClosedSessionsPendingSync filter in JS instead of via `.where()`.
    // That's a full-table scan, which is fine at this data's scale (a
    // single device's own local log); the schema string is unchanged from
    // v1, and this version bump exists purely to run the upgrade migration
    // below for anyone with pre-existing v1 data.
    this.version(2)
      .stores({
        events: 'id, sessionId, deviceId, clientTimestamp, [deviceId+deviceSeq]',
        sessions: 'id, deviceId, startedAt, endedAt',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        await tx.table('events').toCollection().modify({ synced: false });
        await tx.table('sessions').toCollection().modify({ synced: false });
      });
  }
}

// Module-level singleton: one Dexie connection per page load, reused across
// calls (Dexie's own recommended pattern). A fresh instance only appears
// after the module itself is reloaded — e.g. an actual page reload/app
// restart, or, in tests, `vi.resetModules()` + re-import, which is exactly
// how the tests simulate a restart while keeping the underlying IndexedDB
// database (and its data) intact.
let dbInstance: LocalStoreDatabase | null = null;

function getDb(): LocalStoreDatabase {
  if (!dbInstance) {
    dbInstance = new LocalStoreDatabase();
  }
  return dbInstance;
}

/**
 * Generates and persists a UUID on first run, in the `meta` table.
 *
 * Note this is `Promise<string>`, not the bare `string` you might reach for
 * first: "generate on first run, persisted in IndexedDB" is inherently
 * asynchronous — there's no way to synchronously know whether a value is
 * already in IndexedDB. Every other function in this module is async for
 * the same underlying reason, so an async signature here keeps the module's
 * API internally consistent rather than being the one surprising exception.
 * Callers resolve this once at app bootstrap and hold the value (e.g. in
 * React state/context) for the rest of the session — every hot-path call
 * that needs deviceId (appendEvent, getNextDeviceSeq, startSession) reads
 * from that already-resolved value, not from this function again.
 *
 * Wrapped in an explicit transaction so two concurrent first-run callers
 * (e.g. two components mounting at once) can't each see "no id yet" and
 * mint two different UUIDs — IndexedDB serializes readwrite transactions
 * against the same store, so the second caller's read is guaranteed to see
 * the first caller's write.
 */
export async function getOrCreateDeviceId(): Promise<string> {
  const db = getDb();
  return db.transaction('rw', db.meta, async () => {
    const existing = await db.meta.get(DEVICE_ID_KEY);
    if (existing && typeof existing.value === 'string') {
      return existing.value;
    }
    const id = crypto.randomUUID();
    await db.meta.put({ key: DEVICE_ID_KEY, value: id });
    return id;
  });
}

/**
 * Pure local write — no network I/O anywhere in this module, so "never
 * await anything network-related" holds trivially. Callers fire this off
 * without blocking the tap-to-speak path on it (see the caller-side
 * fire-and-forget wiring on the end-user screen); `put` (not `add`) makes a
 * duplicate call with the same event id a harmless overwrite rather than a
 * thrown constraint error, matching the same idempotent-by-id approach used
 * for the server sync. New events start unsynced — lib/sync-engine.ts is
 * what flips this to true, once the server has confirmed it.
 */
export async function appendEvent(event: SessionEvent): Promise<void> {
  await getDb().events.put({ ...event, synced: false });
}

/**
 * Count of local events not yet confirmed synced — what the dev-only badge
 * on the end-user screen shows (see app/(enduser)/page.tsx). A thin wrapper
 * over getUnsyncedEvents() (defined further down, in the sync-bookkeeping
 * section) so the badge doesn't need to import from lib/sync-engine.ts —
 * the tap surface stays decoupled from sync/caregiver-mode concerns, same
 * as everywhere else in this module.
 */
export async function getPendingEventCount(): Promise<number> {
  return (await getUnsyncedEvents()).length;
}

/**
 * Monotonically increasing per-device counter, persisted in the meta table
 * so it survives restarts. Wrapped in a transaction for the same reason as
 * getOrCreateDeviceId: IndexedDB serializes readwrite transactions against
 * the same store, so concurrent callers each get a distinct, correctly
 * incremented value instead of racing on a plain get-then-put.
 */
export async function getNextDeviceSeq(): Promise<number> {
  const db = getDb();
  return db.transaction('rw', db.meta, async () => {
    const existing = await db.meta.get(DEVICE_SEQ_KEY);
    const next = (typeof existing?.value === 'number' ? existing.value : 0) + 1;
    await db.meta.put({ key: DEVICE_SEQ_KEY, value: next });
    return next;
  });
}

/** Creates a new local Session row (startedAt = now, unsynced) and returns its id. */
export async function startSession(): Promise<string> {
  const db = getDb();
  const deviceId = await getOrCreateDeviceId();
  const id = crypto.randomUUID();
  const session: LocalSession = {
    id,
    deviceId,
    startedAt: new Date().toISOString(),
    endedAt: null,
    synced: false,
  };
  await db.sessions.put(session);
  return id;
}

/**
 * Sets endedAt locally. Idempotent, mirroring the server close endpoint's
 * semantics: a session that's already closed (or that doesn't exist
 * locally) is left untouched rather than overwritten.
 */
export async function closeSession(sessionId: string): Promise<void> {
  const db = getDb();
  const session = await db.sessions.get(sessionId);
  if (!session || session.endedAt) {
    return;
  }
  await db.sessions.update(sessionId, { endedAt: new Date().toISOString() });
}

/** A single session by id, or undefined if it doesn't exist locally. */
export async function getSession(sessionId: string): Promise<Session | undefined> {
  return getDb().sessions.get(sessionId);
}

/**
 * A session plus the derived fields the caregiver session list actually
 * renders — computed once, over one pass of the events table, rather than
 * per-row queries (see getSessionsGroupedByDay).
 */
export type SessionSummary = Session & {
  /** Count of tile_tap events in this session — "number of phrases spoken". clear_bar events don't count. */
  phraseCount: number;
  /** True only if the session row itself, and every one of its events, are synced. */
  fullySynced: boolean;
};

export interface SessionsByDay {
  /** Local calendar day, 'YYYY-MM-DD', derived from each session's startedAt. */
  day: string;
  sessions: SessionSummary[];
}

/**
 * Local calendar day, not UTC: a caregiver's "today" is their device's
 * local date, and new Date(iso).toISOString() would misfile sessions near
 * midnight for anyone west of UTC. Exported so UI code (e.g. the caregiver
 * session list's "Today"/"Yesterday" headings) can compare against the same
 * day-key computation rather than reimplementing it.
 */
export function toLocalDayKey(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Sessions grouped by local calendar day (most recent day, and most recent
 * session within a day, first) — the caregiver session list's data source.
 * Computes phraseCount/fullySynced for every session in one pass over the
 * events table rather than one query per session.
 */
export async function getSessionsGroupedByDay(): Promise<SessionsByDay[]> {
  const db = getDb();
  const [sessions, events] = await Promise.all([
    db.sessions.orderBy('startedAt').reverse().toArray(),
    db.events.toArray(),
  ]);

  const phraseCountBySessionId = new Map<string, number>();
  const hasUnsyncedEventBySessionId = new Set<string>();
  for (const event of events) {
    if (event.type === 'tile_tap') {
      phraseCountBySessionId.set(
        event.sessionId,
        (phraseCountBySessionId.get(event.sessionId) ?? 0) + 1,
      );
    }
    if (!event.synced) {
      hasUnsyncedEventBySessionId.add(event.sessionId);
    }
  }

  const groups = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const summary: SessionSummary = {
      id: session.id,
      deviceId: session.deviceId,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      phraseCount: phraseCountBySessionId.get(session.id) ?? 0,
      fullySynced: session.synced && !hasUnsyncedEventBySessionId.has(session.id),
    };
    const day = toLocalDayKey(session.startedAt);
    const existing = groups.get(day);
    if (existing) {
      existing.push(summary);
    } else {
      groups.set(day, [summary]);
    }
  }

  // Map iteration order follows insertion order, and `sessions` was already
  // newest-first, so this comes out newest-day-first with no extra sort.
  return [...groups.entries()].map(([day, daySessions]) => ({ day, sessions: daySessions }));
}

/**
 * Events for one session, sorted per the ordering rule in
 * packages/shared/src/types.ts: within a device, deviceSeq; across devices,
 * clientTimestamp with deviceId as the tiebreak for equal timestamps. ISO
 * 8601 strings compare correctly with plain `<`/`>`, so no Date parsing is
 * needed for the primary sort key.
 */
export async function getEventsForSession(sessionId: string): Promise<SessionEvent[]> {
  const db = getDb();
  const events = await db.events.where('sessionId').equals(sessionId).toArray();

  return events.sort((a, b) => {
    if (a.clientTimestamp !== b.clientTimestamp) {
      return a.clientTimestamp < b.clientTimestamp ? -1 : 1;
    }
    if (a.deviceId !== b.deviceId) {
      return a.deviceId < b.deviceId ? -1 : 1;
    }
    return a.deviceSeq - b.deviceSeq;
  });
}

// ---------------------------------------------------------------------------
// Sync bookkeeping — used by lib/sync-engine.ts. Kept here (not in the sync
// engine itself) so all Dexie access stays behind this one module, same as
// everything above.
// ---------------------------------------------------------------------------

/** Local events not yet confirmed synced to the server. */
export async function getUnsyncedEvents(): Promise<LocalEvent[]> {
  return getDb()
    .events.filter((e) => !e.synced)
    .toArray();
}

/** Marks the given event ids as synced. No-ops on an empty list (no wasted transaction). */
export async function markEventsSynced(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  await db.transaction('rw', db.events, async () => {
    for (const id of ids) {
      await db.events.update(id, { synced: true });
    }
  });
}

/**
 * Locally-closed sessions (endedAt set) whose close hasn't been confirmed
 * to the server yet. Deliberately narrower than "all unsynced sessions":
 * the server learns a session exists implicitly, the moment any of its
 * events gets pushed (see lib/sync-engine.ts) — there's nothing to
 * proactively push for a still-open session, only a close to report once
 * one happens.
 */
export async function getClosedSessionsPendingSync(): Promise<LocalSession[]> {
  return getDb()
    .sessions.filter((s) => !s.synced && s.endedAt !== null)
    .toArray();
}

/** Marks the given session ids as synced. No-ops on an empty list. */
export async function markSessionsSynced(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  await db.transaction('rw', db.sessions, async () => {
    for (const id of ids) {
      await db.sessions.update(id, { synced: true });
    }
  });
}

/**
 * Upserts server-sourced events by id — this is what naturally dedupes an
 * event that originated on a different device (a new id just inserts) while
 * being a safe no-op/overwrite for an id this device already has (its own
 * event, echoed back by a pull). Always stored as synced: true, since by
 * definition the server just told us about it.
 */
export async function upsertEvents(events: SessionEvent[]): Promise<void> {
  if (events.length === 0) return;
  const rows: LocalEvent[] = events.map((e) => ({ ...e, synced: true }));
  await getDb().events.bulkPut(rows);
}

/** Same idea as upsertEvents, for sessions. */
export async function upsertSessions(sessions: Session[]): Promise<void> {
  if (sessions.length === 0) return;
  const rows: LocalSession[] = sessions.map((s) => ({ ...s, synced: true }));
  await getDb().sessions.bulkPut(rows);
}

/** Opaque pull cursor from the last successful GET /api/sync/pull. */
export async function getSyncCursor(): Promise<string | undefined> {
  const row = await getDb().meta.get(SYNC_CURSOR_KEY);
  return typeof row?.value === 'string' ? row.value : undefined;
}

export async function setSyncCursor(cursor: string): Promise<void> {
  await getDb().meta.put({ key: SYNC_CURSOR_KEY, value: cursor });
}

/** ISO timestamp of the last sync cycle that made any successful progress, for caregiver status display. */
export async function getLastSyncedAt(): Promise<string | null> {
  const row = await getDb().meta.get(LAST_SYNCED_AT_KEY);
  return typeof row?.value === 'string' ? row.value : null;
}

export async function setLastSyncedAt(iso: string): Promise<void> {
  await getDb().meta.put({ key: LAST_SYNCED_AT_KEY, value: iso });
}
