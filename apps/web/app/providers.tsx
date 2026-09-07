'use client';

import { useEffect } from 'react';
import { startBackgroundSync } from '@/lib/sync-engine';

/**
 * Wires up the background half of sync for the whole app (see
 * lib/sync-engine.ts's startBackgroundSync doc comment): once on the
 * browser's 'online' event, and every 30s while online. Lives here, in a
 * client component mounted once by the root layout, rather than in either
 * screen — it needs to run regardless of whether the end user or a
 * caregiver currently has the app open, not restart every time someone
 * navigates between them.
 *
 * The explicit trigger (a caregiver's "Sync now" button) is separate and
 * calls syncNow() directly — see app/(caregiver)/sessions/page.tsx.
 */
export function BackgroundSyncProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    return startBackgroundSync();
  }, []);

  return <>{children}</>;
}
