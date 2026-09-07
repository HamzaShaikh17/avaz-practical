'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { getSessionsGroupedByDay, toLocalDayKey, type SessionsByDay } from '@/lib/local-store';
import { syncNow } from '@/lib/sync-engine';

function formatDayHeading(dayKey: string): string {
  const todayKey = toLocalDayKey(new Date().toISOString());
  const yesterdayKey = toLocalDayKey(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  if (dayKey === todayKey) return 'Today';
  if (dayKey === yesterdayKey) return 'Yesterday';
  // Parse YYYY-MM-DD as local date parts (not `new Date(dayKey)`, which
  // Date parses as UTC midnight and could roll back a day when displayed).
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function formatStartTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatDuration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return 'ongoing';
  const totalSeconds = Math.max(
    0,
    Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000),
  );
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export default function SessionsListPage() {
  const [dayGroups, setDayGroups] = useState<SessionsByDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const loadSessions = useCallback(async () => {
    try {
      const groups = await getSessionsGroupedByDay();
      setDayGroups(groups);
    } catch (err) {
      console.error('Failed to load sessions', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  async function handleSyncNow() {
    setSyncing(true);
    try {
      // Caregiver mode is the one explicit trigger on top of the
      // background ones (online event, 30s interval) — see
      // lib/sync-engine.ts. This is also the one place in the app allowed
      // to show a spinner: unlike the tap surface, this screen isn't
      // time-critical.
      await syncNow();
      await loadSessions();
    } finally {
      setSyncing(false);
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-2xl bg-slate-50 p-6">
      <Link href="/" className="text-sm text-indigo-600 underline">
        ← Back to tap surface
      </Link>
      <div className="mb-6 mt-2 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Sessions</h1>
        <button
          type="button"
          onClick={handleSyncNow}
          disabled={syncing}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {syncing && (
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
              aria-hidden
            />
          )}
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      {loading && <p className="text-slate-500">Loading…</p>}

      {!loading && dayGroups.length === 0 && (
        <p className="text-slate-500">No sessions recorded yet on this device.</p>
      )}

      {dayGroups.map((group) => (
        <section key={group.day} className="mb-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            {formatDayHeading(group.day)}
          </h2>
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
            {group.sessions.map((session) => (
              <li key={session.id}>
                <Link
                  href={`/sessions/${session.id}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-slate-50"
                >
                  <div>
                    <div className="font-medium text-slate-900">
                      {formatStartTime(session.startedAt)}
                    </div>
                    <div className="text-sm text-slate-500">
                      {formatDuration(session.startedAt, session.endedAt)} · {session.phraseCount}{' '}
                      {session.phraseCount === 1 ? 'phrase' : 'phrases'}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
                      session.fullySynced
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-amber-100 text-amber-700'
                    }`}
                  >
                    {session.fullySynced ? 'Synced' : 'Pending sync'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
