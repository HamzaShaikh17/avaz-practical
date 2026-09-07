'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { Session, SessionEvent } from '@session-replay/shared';
import { getEventsForSession, getSession } from '@/lib/local-store';
import { speak } from '@/lib/speak';

type PlaybackSpeed = '1x' | '2x' | 'instant';

/**
 * Playback pacing here is *normalized* timing, not *faithful* timing: the
 * real gap between two taps is scaled by the chosen speed, then clamped
 * into [MIN_GAP_MS, MAX_GAP_MS] before the next phrase speaks.
 *
 * Faithfully replaying a 3-minute pause between taps isn't useful for a
 * caregiver reviewing a session — nobody wants to sit through it, and the
 * max cap keeps a review session moving. But preserving *relative* pacing
 * (a burst of taps in quick succession vs. long, hesitant gaps) is
 * genuinely informative for a therapist reading the transcript — that's
 * evidence of fluency or hesitation, not noise to smooth away — which is
 * why this scales the real gap rather than just using a flat delay. The min
 * cap exists so a real rapid-fire burst — or "instant" speed, which divides
 * every gap toward zero — doesn't collapse below what's actually audible.
 */
const MIN_GAP_MS = 400;
const MAX_GAP_MS = 4000;
const SPEED_MULTIPLIERS: Record<PlaybackSpeed, number> = { '1x': 1, '2x': 2, instant: Infinity };

function scaledGapMs(fromIso: string, toIso: string, speed: PlaybackSpeed): number {
  const rawGapMs = new Date(toIso).getTime() - new Date(fromIso).getTime();
  const scaled = Math.max(0, rawGapMs) / SPEED_MULTIPLIERS[speed];
  return Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, scaled));
}

/** An interruptible delay: cancelling resolves the promise immediately instead of waiting out the timer. */
interface CancelToken {
  cancelled: boolean;
  onCancel?: () => void;
}

function sleep(ms: number, token: CancelToken): Promise<void> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(resolve, ms);
    token.onCancel = () => {
      clearTimeout(timeoutId);
      resolve();
    };
  });
}

function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

export default function SessionReplayPage({ params }: { params: { id: string } }) {
  const sessionId = params.id;

  const [session, setSession] = useState<Session | undefined>(undefined);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>('1x');

  // Playback reads speed from a ref, not the `speed` closure captured when
  // playFrom() started, so changing the selector mid-playback affects the
  // very next gap instead of only taking effect on the next Play press.
  const speedRef = useRef(speed);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  const cancelRef = useRef<CancelToken | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [sessionRow, sessionEvents] = await Promise.all([
          getSession(sessionId),
          getEventsForSession(sessionId),
        ]);
        if (cancelled) return;
        setSession(sessionRow);
        setEvents(sessionEvents);
      } catch (err) {
        console.error('Failed to load session', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Stop any in-flight playback loop and speech on unmount (navigating away
  // mid-playback shouldn't leave an utterance queue running in the background).
  useEffect(() => {
    return () => {
      cancelRef.current?.onCancel?.();
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  function stopPlayback() {
    if (cancelRef.current) {
      cancelRef.current.cancelled = true;
      cancelRef.current.onCancel?.();
      cancelRef.current = null;
    }
    setIsPlaying(false);
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }

  async function playFrom(startIndex: number) {
    const token: CancelToken = { cancelled: false };
    cancelRef.current = token;
    setIsPlaying(true);

    for (let i = startIndex; i < events.length; i++) {
      if (token.cancelled) return;
      setCurrentIndex(i);

      const event = events[i];
      if (event.type === 'tile_tap') {
        speak(event.phraseText);
      }

      const next = events[i + 1];
      if (next) {
        const gap = scaledGapMs(event.clientTimestamp, next.clientTimestamp, speedRef.current);
        await sleep(gap, token);
        if (token.cancelled) return;
      }
    }

    cancelRef.current = null;
    setIsPlaying(false);
  }

  function handlePlayPause() {
    if (isPlaying) {
      stopPlayback();
      return;
    }
    if (events.length === 0) return;
    // Resume where paused; restart from the top if playback had finished
    // (or never started).
    const startIndex = currentIndex < 0 || currentIndex >= events.length - 1 ? 0 : currentIndex;
    void playFrom(startIndex);
  }

  function handleStepForward() {
    if (events.length === 0 || currentIndex >= events.length - 1) return;
    stopPlayback();
    const next = currentIndex + 1;
    setCurrentIndex(next);
    const event = events[next];
    if (event.type === 'tile_tap') speak(event.phraseText);
  }

  function handleStepBack() {
    if (events.length === 0 || currentIndex <= 0) return;
    stopPlayback();
    const prev = currentIndex - 1;
    setCurrentIndex(prev);
    const event = events[prev];
    if (event.type === 'tile_tap') speak(event.phraseText);
  }

  if (loading) {
    return (
      <main className="mx-auto min-h-screen max-w-2xl bg-slate-50 p-6">
        <p className="text-slate-500">Loading…</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="mx-auto min-h-screen max-w-2xl bg-slate-50 p-6">
        <Link href="/sessions" className="text-sm text-indigo-600 underline">
          ← Back to sessions
        </Link>
        <p className="mt-4 text-slate-500">This session isn&apos;t available on this device.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-2xl bg-slate-50 p-6">
      <Link href="/sessions" className="text-sm text-indigo-600 underline">
        ← Back to sessions
      </Link>

      <h1 className="mt-2 text-2xl font-bold text-slate-900">
        Session — {formatClockTime(session.startedAt)}
      </h1>

      <div className="sticky top-2 z-10 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <button
          type="button"
          onClick={handleStepBack}
          disabled={events.length === 0 || currentIndex <= 0}
          className="rounded-lg bg-slate-200 px-3 py-2 font-medium text-slate-700 transition-colors hover:bg-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          ⏮ Back
        </button>
        <button
          type="button"
          onClick={handlePlayPause}
          disabled={events.length === 0}
          className="rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isPlaying ? '⏸ Pause' : '▶ Play'}
        </button>
        <button
          type="button"
          onClick={handleStepForward}
          disabled={events.length === 0 || currentIndex >= events.length - 1}
          className="rounded-lg bg-slate-200 px-3 py-2 font-medium text-slate-700 transition-colors hover:bg-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Forward ⏭
        </button>

        <label className="ml-auto flex items-center gap-2 text-sm text-slate-600">
          Speed
          <select
            value={speed}
            onChange={(e) => setSpeed(e.target.value as PlaybackSpeed)}
            className="rounded-lg border border-slate-300 px-2 py-1"
          >
            <option value="1x">1x</option>
            <option value="2x">2x</option>
            <option value="instant">Instant</option>
          </select>
        </label>
      </div>

      <ol className="mt-4 space-y-1 rounded-xl border border-slate-200 bg-white p-3">
        {events.length === 0 && (
          <p className="text-slate-500">No events recorded for this session.</p>
        )}
        {events.map((event, i) => (
          <li
            key={event.id}
            className={`rounded-lg px-3 py-2 transition-colors ${
              i === currentIndex ? 'bg-amber-200' : ''
            }`}
          >
            <div className="flex items-baseline gap-3">
              <span className="w-20 shrink-0 font-mono text-xs text-slate-400">
                {formatClockTime(event.clientTimestamp)}
              </span>
              {event.type === 'tile_tap' ? (
                <span className="text-lg text-slate-800">{event.phraseText}</span>
              ) : (
                <span className="italic text-slate-400">— cleared —</span>
              )}
            </div>
          </li>
        ))}
      </ol>
    </main>
  );
}
