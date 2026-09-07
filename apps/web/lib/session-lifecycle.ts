/**
 * Session segmentation, extracted from app/(enduser)/page.tsx so it's
 * testable without rendering React/DOM: this is the highest-risk logic on
 * the tap surface (get it wrong and a transcript is silently fragmented or
 * merged incorrectly), so it lives as a small, pure, dependency-injected
 * state machine rather than component-scoped refs and callbacks.
 *
 * Rule being implemented (see also the comment in
 * packages/shared/src/types.ts): a session is one coherent "conversation
 * turn". It ends on whichever comes first —
 *   - IDLE_TIMEOUT_MS of inactivity (implicit boundary: the device was left
 *     open but nobody's using it), or
 *   - an explicit boundary: the tab/app is backgrounded or torn down
 *     (visibilitychange -> hidden, or pagehide) — forceClose() is called
 *     directly for this, bypassing the idle timer entirely, even if far
 *     less than IDLE_TIMEOUT_MS has passed since the last tap.
 * The next tap after either kind of close starts a brand-new session.
 *
 * Why 20s specifically: long enough that normal thinking/scanning time
 * between taps doesn't fragment a real communication attempt into several
 * sessions, but short enough that a genuine pause (put the device down,
 * walk away) closes the turn rather than letting one session silently span
 * hours of unrelated activity.
 */

const DEFAULT_IDLE_TIMEOUT_MS = 20_000;

export interface SessionLifecycleDeps {
  startSession: () => Promise<string>;
  closeSession: (sessionId: string) => Promise<void>;
  idleTimeoutMs?: number;
  onError?: (err: unknown) => void;
}

export interface SessionLifecycle {
  /**
   * Call on every tap/clear — synchronous, cheap (just re-arms the idle
   * timer). Belongs in the tap-to-speak critical path alongside the
   * sentence-bar update and speechSynthesis.speak(), same as the rest of
   * this module's design: never await anything here.
   */
  touch: () => void;
  /**
   * Resolves the current session, starting one if this is the first
   * activity since mount or since the last close. Async (a local DB write
   * on first call) — call from the fire-and-forget tail, not the critical
   * path. Concurrent calls before the first startSession() resolves share
   * one in-flight promise rather than each starting their own session.
   */
  ensureSession: () => Promise<string>;
  /**
   * Ends the current session immediately, regardless of the idle timer —
   * the idle-timeout callback and the visibilitychange/pagehide handlers
   * both call this directly. No-ops if there's no active session.
   */
  forceClose: () => void;
  /** Clears the idle timer without closing a session — call on unmount. */
  dispose: () => void;
  /** For tests/inspection only. */
  getCurrentSessionId: () => string | null;
}

export function createSessionLifecycle(deps: SessionLifecycleDeps): SessionLifecycle {
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const onError = deps.onError ?? ((err: unknown) => console.error('Session lifecycle error', err));

  let sessionId: string | null = null;
  let sessionIdPromise: Promise<string> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function ensureSession(): Promise<string> {
    if (sessionId) {
      return Promise.resolve(sessionId);
    }
    if (!sessionIdPromise) {
      sessionIdPromise = deps.startSession().then((id) => {
        sessionId = id;
        return id;
      });
    }
    return sessionIdPromise;
  }

  function forceClose(): void {
    const id = sessionId;
    sessionId = null;
    sessionIdPromise = null;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (id) {
      void deps.closeSession(id).catch(onError);
    }
  }

  function touch(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(forceClose, idleTimeoutMs);
  }

  function dispose(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  return {
    touch,
    ensureSession,
    forceClose,
    dispose,
    getCurrentSessionId: () => sessionId,
  };
}
