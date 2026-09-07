'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClearBarEvent, TapEvent } from '@session-replay/shared';
import {
  appendEvent,
  closeSession,
  getNextDeviceSeq,
  getOrCreateDeviceId,
  getPendingEventCount,
  startSession,
} from '@/lib/local-store';
import { createSessionLifecycle, type SessionLifecycle } from '@/lib/session-lifecycle';
import { speak } from '@/lib/speak';

interface PhraseTile {
  id: string;
  label: string;
  emoji: string;
}

// Flat grid, no folders — per the assignment, a single flat grid of ~20-24
// tiles is enough to demonstrate the tap surface. Placeholder content only.
const TILES: PhraseTile[] = [
  { id: 'yes', label: 'yes', emoji: '👍' },
  { id: 'no', label: 'no', emoji: '👎' },
  { id: 'more', label: 'more', emoji: '➕' },
  { id: 'all-done', label: 'all done', emoji: '✅' },
  { id: 'i-want', label: 'I want', emoji: '🙋' },
  { id: 'help', label: 'help', emoji: '🆘' },
  { id: 'stop', label: 'stop', emoji: '✋' },
  { id: 'go', label: 'go', emoji: '🚦' },
  { id: 'please', label: 'please', emoji: '🙏' },
  { id: 'thank-you', label: 'thank you', emoji: '🤝' },
  { id: 'i-feel', label: 'I feel', emoji: '💭' },
  { id: 'hurt', label: 'hurt', emoji: '🤕' },
  { id: 'happy', label: 'happy', emoji: '😀' },
  { id: 'sad', label: 'sad', emoji: '😢' },
  { id: 'hungry', label: 'hungry', emoji: '🍽️' },
  { id: 'thirsty', label: 'thirsty', emoji: '🥤' },
  { id: 'bathroom', label: 'bathroom', emoji: '🚻' },
  { id: 'tired', label: 'tired', emoji: '😴' },
  { id: 'play', label: 'play', emoji: '🧸' },
  { id: 'outside', label: 'outside', emoji: '🌳' },
  { id: 'again', label: 'again', emoji: '🔁' },
  { id: 'wait', label: 'wait', emoji: '⏳' },
  { id: 'look', label: 'look', emoji: '👀' },
  { id: 'love-you', label: 'love you', emoji: '❤️' },
];

const TILE_COLORS = [
  'bg-amber-200 hover:bg-amber-300 active:bg-amber-300',
  'bg-sky-200 hover:bg-sky-300 active:bg-sky-300',
  'bg-emerald-200 hover:bg-emerald-300 active:bg-emerald-300',
  'bg-rose-200 hover:bg-rose-300 active:bg-rose-300',
  'bg-violet-200 hover:bg-violet-300 active:bg-violet-300',
  'bg-orange-200 hover:bg-orange-300 active:bg-orange-300',
];

export default function EndUserTapSurface() {
  const [sentence, setSentence] = useState<string[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);

  // Segmentation (idle timeout + explicit-boundary force-close) lives in
  // lib/session-lifecycle.ts — see that module for the rule and why it's
  // extracted. Ref, not state: session bookkeeping shouldn't trigger
  // re-renders.
  const lifecycleRef = useRef<SessionLifecycle | null>(null);
  const getLifecycle = useCallback((): SessionLifecycle => {
    if (!lifecycleRef.current) {
      lifecycleRef.current = createSessionLifecycle({ startSession, closeSession });
    }
    return lifecycleRef.current;
  }, []);

  // Explicit-boundary half of the segmentation rule: close immediately when
  // the app is backgrounded or the tab/page is torn down, rather than
  // waiting out the idle timer.
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        getLifecycle().forceClose();
      }
    }
    function handlePageHide() {
      getLifecycle().forceClose();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
      getLifecycle().dispose();
    };
  }, [getLifecycle]);

  // Dev badge's starting count. Only reflects reality at mount time — if a
  // sync completes in another tab/route while this page stays mounted, this
  // won't reactively drop (no cross-tab IndexedDB change notification is
  // wired up); navigating away and back (e.g. to caregiver mode and back)
  // remounts this page and re-reads the true count.
  useEffect(() => {
    getPendingEventCount()
      .then(setQueuedCount)
      .catch((err) => console.error('Failed to load initial pending event count', err));
  }, []);

  async function recordTapEvent(tile: PhraseTile, clientTimestamp: string) {
    try {
      const [deviceId, sessionId] = await Promise.all([
        getOrCreateDeviceId(),
        getLifecycle().ensureSession(),
      ]);
      const deviceSeq = await getNextDeviceSeq();
      const event: TapEvent = {
        id: crypto.randomUUID(),
        type: 'tile_tap',
        sessionId,
        deviceId,
        deviceSeq,
        clientTimestamp,
        tileId: tile.id,
        phraseText: tile.label,
      };
      await appendEvent(event);
      setQueuedCount((c) => c + 1);
    } catch (err) {
      // logging must never be in the critical path of tap-to-speak — this
      // function only ever runs after the sentence bar update and
      // speechSynthesis.speak() call below have already been dispatched, and
      // nothing it does may surface to the UI. A failed local write is lost
      // silently from the user's perspective (loudly, to the console).
      console.error('Failed to record tap event', err);
    }
  }

  async function recordClearEvent(clientTimestamp: string) {
    try {
      const [deviceId, sessionId] = await Promise.all([
        getOrCreateDeviceId(),
        getLifecycle().ensureSession(),
      ]);
      const deviceSeq = await getNextDeviceSeq();
      const event: ClearBarEvent = {
        id: crypto.randomUUID(),
        type: 'clear_bar',
        sessionId,
        deviceId,
        deviceSeq,
        clientTimestamp,
      };
      await appendEvent(event);
      setQueuedCount((c) => c + 1);
    } catch (err) {
      // Same rule as recordTapEvent: never in the critical path, never
      // surfaced to the UI.
      console.error('Failed to record clear-bar event', err);
    }
  }

  function handleTileTap(tile: PhraseTile) {
    const clientTimestamp = new Date().toISOString();

    // ---- Critical path: synchronous, no I/O, no awaits. ----
    setSentence((prev) => [...prev, tile.label]);
    speak(tile.label);
    getLifecycle().touch();

    // ---- Everything below is fire-and-forget local persistence. ----
    void recordTapEvent(tile, clientTimestamp);
  }

  function handleClearBar() {
    const clientTimestamp = new Date().toISOString();

    setSentence([]);
    getLifecycle().touch();

    void recordClearEvent(clientTimestamp);
  }

  return (
    <main className="flex h-screen flex-col gap-4 bg-slate-100 p-4">
      <div className="flex items-center gap-3 rounded-2xl border-2 border-slate-300 bg-white p-4 shadow-sm">
        <div className="min-h-[2.5rem] flex-1 text-3xl font-medium text-slate-800">
          {sentence.length > 0 ? (
            sentence.join(' ')
          ) : (
            <span className="text-slate-400">Tap a tile to build a sentence…</span>
          )}
        </div>
        <button
          type="button"
          onClick={handleClearBar}
          disabled={sentence.length === 0}
          className="shrink-0 touch-manipulation rounded-xl bg-red-500 px-5 py-3 text-lg font-semibold text-white transition-colors active:bg-red-600 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          Clear
        </button>
      </div>

      <div className="grid flex-1 grid-cols-4 gap-3 overflow-y-auto sm:grid-cols-6">
        {TILES.map((tile, i) => (
          <button
            key={tile.id}
            type="button"
            onClick={() => handleTileTap(tile)}
            className={`flex touch-manipulation select-none flex-col items-center justify-center gap-1 rounded-2xl p-3 text-center shadow-sm transition-transform active:scale-95 ${TILE_COLORS[i % TILE_COLORS.length]}`}
          >
            <span className="text-4xl" aria-hidden>
              {tile.emoji}
            </span>
            <span className="text-lg font-semibold text-slate-800">{tile.label}</span>
          </button>
        ))}
      </div>

      {process.env.NODE_ENV === 'development' && (
        <div className="pointer-events-none fixed bottom-2 right-2 rounded-full bg-black/70 px-3 py-1 font-mono text-xs text-white">
          pending sync: {queuedCount}
        </div>
      )}

      {/*
        Deliberately small/low-contrast, opposite corner from the dev
        badge — not a real caregiver-mode gate (a real product would put
        this behind a PIN or hold-gesture so a child using the tap surface
        can't wander into it), just enough that a soft/client-side Next.js
        navigation to /sessions is possible without typing a URL. That
        matters offline: a fresh address-bar navigation needs a network
        round-trip and fails with no connection, but an in-app <Link> to an
        already-visited route can complete from the client-side router
        cache alone.
      */}
      <Link
        href="/sessions"
        className="fixed left-2 top-2 rounded-full bg-black/10 px-3 py-1 text-xs text-slate-500 hover:bg-black/20"
      >
        Caregiver mode →
      </Link>
    </main>
  );
}
