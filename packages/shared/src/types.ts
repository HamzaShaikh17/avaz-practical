/**
 * Shared domain types for session-replay.
 * Both apps/web and apps/api import from here so the wire format never drifts.
 *
 * Scope: only two event types are captured — `tile_tap` and `clear_bar`.
 * We deliberately exclude folder navigation, keyboard/tone switches, and other
 * UI events because they don't contribute to "what was communicated," which is
 * the only thing session replay needs to reconstruct. Session replay here is a
 * communication transcript (what phrases were built and spoken), not a full UI
 * interaction recorder — capturing navigation/UI chrome would add volume and
 * privacy surface without adding anything a reviewer needs to understand what
 * was said.
 *
 * Ordering rule:
 * Events are ordered by (sessionId, deviceSeq) within a single device — deviceSeq
 * is a monotonic per-device counter, so it's authoritative for "what happened
 * next" on that device regardless of clock skew. Across devices (e.g. two
 * caregivers' browsers contributing to the same session), events are ordered by
 * clientTimestamp, with deviceId as a final tiebreaker for exact-equal
 * timestamps (a stable, arbitrary-but-deterministic tiebreak).
 *
 * This is a "good enough" rule, not a vector-clock-correct one: there is no
 * server-authoritative clock and no causal handshake between devices, so two
 * devices with skewed clocks can produce a merged order that isn't the "true"
 * causal order. That tradeoff is acceptable here because this is a
 * communication transcript, not a financial ledger — exact millisecond
 * ordering across devices doesn't change what was meaningfully said. Getting
 * the within-device order exactly right (via deviceSeq) is what actually
 * matters for reconstructing a coherent phrase-by-phrase transcript; cross-device
 * interleaving only needs to be "roughly right" for a human reviewer.
 */

/** Event recorded when a user taps a communication tile to build a phrase. */
export type TapEvent = {
  /** Client-generated UUID v4 — this is the idempotency key for sync. */
  id: string;
  type: 'tile_tap';
  /** UUID, generated client-side when a new session starts. */
  sessionId: string;
  /** Persisted per browser install, UUID generated on first load. */
  deviceId: string;
  /** Monotonically increasing per-device counter, used as tiebreaker. */
  deviceSeq: number;
  /** ISO 8601, client clock, may drift across devices. */
  clientTimestamp: string;
  tileId: string;
  phraseText: string;
};

/** Event recorded when a user clears the in-progress phrase bar. */
export type ClearBarEvent = {
  id: string;
  type: 'clear_bar';
  sessionId: string;
  deviceId: string;
  deviceSeq: number;
  clientTimestamp: string;
};

export type SessionEvent = TapEvent | ClearBarEvent;

export type Session = {
  id: string;
  deviceId: string;
  startedAt: string;
  /** null while still open. */
  endedAt: string | null;
};

/** Body of a sync push request: a device flushing locally-recorded events. */
export type SyncPushRequest = {
  deviceId: string;
  events: SessionEvent[];
};

/**
 * Push is idempotent: re-pushing an event with an id already seen by the
 * server is not an error — it's reported back in `duplicates` rather than
 * rejected, so clients can safely retry a push after a network failure.
 */
export type SyncPushResponse = {
  accepted: string[];
  duplicates: string[];
};

/** Query params for a sync pull request. */
export type SyncPullRequest = {
  /** Opaque cursor; omit to pull from the beginning. */
  since?: string;
};

export type SyncPullResponse = {
  events: SessionEvent[];
  sessions: Session[];
  cursor: string;
};
