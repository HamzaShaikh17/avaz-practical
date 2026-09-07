import type {
  SessionEvent,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
} from '@session-replay/shared';
import {
  getClosedSessionsPendingSync,
  getLastSyncedAt,
  getOrCreateDeviceId,
  getSyncCursor,
  getUnsyncedEvents,
  markEventsSynced,
  markSessionsSynced,
  setLastSyncedAt,
  setSyncCursor,
  upsertEvents,
  upsertSessions,
} from './local-store';

/**
 * Reconciles the local Dexie store with the backend from Phase 2/3.
 *
 * This never runs synchronously with a tap — see app/(enduser)/page.tsx,
 * which only ever calls lib/local-store.ts directly. The only callers of
 * syncNow() are the background triggers wired up by startBackgroundSync()
 * below, plus the caregiver-mode "Sync now" button
 * (app/(caregiver)/sessions/page.tsx). That's the whole answer to "must add
 * no perceptible delay": sync is opportunistic background traffic, never on
 * the critical path of anything the end user does.
 *
 * Note on what gets pushed: /api/sync/push (Phase 3) only accepts `events`
 * in its body — there's no endpoint to push a session directly. The server
 * learns a session exists implicitly, from the first event that references
 * it (see Phase 3's push handler), and learns it's closed only via the
 * dedicated POST /api/sync/sessions/:id/close. So "push local changes"
 * below is really two calls: batch-push unsynced events, then call close
 * for any locally-closed session that hasn't been confirmed synced yet. A
 * still-open local session needs no explicit call of its own — pulling
 * will hand it back to us (server-created from our own pushed events) and
 * upsertSessions marks it synced then.
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const SYNC_INTERVAL_MS = 30_000;

export interface SyncResult {
  pushed: number;
  pulled: number;
}

export interface SyncStatus {
  lastSyncedAt: string | null;
  pendingCount: number;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} failed with status ${res.status}`);
  }
  return (await res.json()) as T;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`);
  if (!res.ok) {
    throw new Error(`GET ${path} failed with status ${res.status}`);
  }
  return (await res.json()) as T;
}

function isOffline(): boolean {
  // navigator is undefined outside a browser (SSR, vitest's node
  // environment) — treat "no signal either way" as online rather than
  // permanently refusing to sync there.
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

interface StepResult {
  count: number;
  ok: boolean;
}

/**
 * Push step. Never throws — a failure here (offline, server down, whatever)
 * is swallowed and logged, per "fail silently, retry on the next trigger,
 * no error toasts, ever". Nothing is rolled back on failure because nothing
 * local was mutated for anything that didn't get a successful server
 * response in the first place.
 */
async function pushLocalChanges(): Promise<StepResult> {
  try {
    let count = 0;

    const unsyncedEvents = await getUnsyncedEvents();
    if (unsyncedEvents.length > 0) {
      const deviceId = await getOrCreateDeviceId();
      // Strip the local-only `synced` field — the server's wire type has no
      // such field, and it shouldn't see this device's internal bookkeeping.
      const events: SessionEvent[] = unsyncedEvents.map(({ synced: _synced, ...event }) => event);
      const request: SyncPushRequest = { deviceId, events };
      const response = await postJson<SyncPushResponse>('/api/sync/push', request);
      // Both accepted and duplicate ids mean "the server has it now" — see
      // Phase 3: push is idempotent by id, a duplicate isn't an error.
      const confirmedIds = [...response.accepted, ...response.duplicates];
      await markEventsSynced(confirmedIds);
      count += confirmedIds.length;
    }

    const sessionsToClose = await getClosedSessionsPendingSync();
    for (const session of sessionsToClose) {
      if (session.endedAt === null) continue; // getClosedSessionsPendingSync already filters this; guard for TS
      try {
        await postJson(`/api/sync/sessions/${session.id}/close`, { endedAt: session.endedAt });
        await markSessionsSynced([session.id]);
        count += 1;
      } catch (err) {
        // One session's close failing shouldn't stop the rest of this
        // batch from being attempted.
        console.error(`Failed to sync close for session ${session.id}`, err);
      }
    }

    return { count, ok: true };
  } catch (err) {
    console.error('Sync push failed', err);
    return { count: 0, ok: false };
  }
}

/**
 * Pull step. Same never-throws contract as pushLocalChanges. Upserts by id,
 * which is what naturally merges another device's events into this
 * session's history without touching this device's own rows (see
 * local-store.ts's upsertEvents doc comment).
 */
async function pullRemoteChanges(): Promise<StepResult> {
  try {
    const cursor = await getSyncCursor();
    const query = cursor ? `?since=${encodeURIComponent(cursor)}` : '';
    const response = await getJson<SyncPullResponse>(`/api/sync/pull${query}`);

    await upsertEvents(response.events);
    await upsertSessions(response.sessions);
    await setSyncCursor(response.cursor);

    return { count: response.events.length + response.sessions.length, ok: true };
  } catch (err) {
    console.error('Sync pull failed', err);
    return { count: 0, ok: false };
  }
}

let syncInFlight = false;

/**
 * One full push-then-pull cycle. Safe to call re-entrantly (from the online
 * listener, the interval, and a caregiver's "Sync now" button all firing
 * close together) — a call that lands while one is already running is a
 * no-op rather than doubling up on network traffic.
 */
export async function syncNow(): Promise<SyncResult> {
  if (syncInFlight) {
    return { pushed: 0, pulled: 0 };
  }
  if (isOffline()) {
    // Fail silently and let the next trigger retry — no error toasts on
    // the end-user tap surface, ever.
    return { pushed: 0, pulled: 0 };
  }

  syncInFlight = true;
  try {
    // Independent steps, each swallowing its own errors: a pull failure
    // must not roll back the push's already-confirmed synced flags (the
    // server has those events regardless of whether the pull that followed
    // succeeded), and a push failure shouldn't block attempting a pull.
    const pushResult = await pushLocalChanges();
    const pullResult = await pullRemoteChanges();

    if (pushResult.ok || pullResult.ok) {
      await setLastSyncedAt(new Date().toISOString());
    }

    return { pushed: pushResult.count, pulled: pullResult.count };
  } finally {
    syncInFlight = false;
  }
}

/** For a caregiver-mode status display: last synced time + how much is still queued. */
export async function getSyncStatus(): Promise<SyncStatus> {
  const [lastSyncedAt, unsyncedEvents, sessionsPendingClose] = await Promise.all([
    getLastSyncedAt(),
    getUnsyncedEvents(),
    getClosedSessionsPendingSync(),
  ]);
  return {
    lastSyncedAt,
    pendingCount: unsyncedEvents.length + sessionsPendingClose.length,
  };
}

interface BackgroundSyncHandle {
  intervalId: ReturnType<typeof setInterval>;
  onOnline: () => void;
}

let backgroundHandle: BackgroundSyncHandle | null = null;

/**
 * Wires up the two background triggers: once on 'online', and every
 * intervalMs while online (each tick re-checks online status itself and
 * skips if so — syncNow()'s own in-flight guard handles the "already
 * syncing" skip). A caregiver's explicit "Sync now" button should just call
 * syncNow() directly, not this.
 *
 * Idempotent (a second call while already running is a no-op) and returns a
 * stop function, so a component can safely call this in a mount effect and
 * call the returned function in its cleanup.
 */
export function startBackgroundSync(intervalMs: number = SYNC_INTERVAL_MS): () => void {
  if (backgroundHandle) {
    return stopBackgroundSync;
  }

  const onOnline = () => {
    void syncNow();
  };
  window.addEventListener('online', onOnline);

  const intervalId = setInterval(() => {
    if (isOffline()) {
      return;
    }
    void syncNow();
  }, intervalMs);

  backgroundHandle = { intervalId, onOnline };
  return stopBackgroundSync;
}

export function stopBackgroundSync(): void {
  if (!backgroundHandle) return;
  window.removeEventListener('online', backgroundHandle.onOnline);
  clearInterval(backgroundHandle.intervalId);
  backgroundHandle = null;
}
