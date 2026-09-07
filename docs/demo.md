# Demo: offline capture + cross-device sync

A walkthrough for reviewers to see session-replay's offline-first local store
and cross-device sync working end to end. Every step below was actually run
(Playwright driving real Chromium, two separate browser contexts as two
"devices", real DevTools-style offline throttling) against this codebase
before being written down — see the note at the bottom on the one place
where reality didn't match the naive expectation, and why.

If you just want the one-line version: **local capture and caregiver
browsing never touch the network; sync only happens through the explicit
"Sync now" button, the `online` browser event, or a 30s background
interval.**

## Prerequisites — clean slate

```bash
npm install                 # first time only
npm run seed                # wipes apps/api's SQLite db, leaves it empty
npm run dev                 # web on :3000, api on :4000
```

`npm run seed` runs `prisma migrate reset --force` under the hood — it drops
and recreates the SQLite database from the migration history, so you get a
guaranteed-empty backend regardless of what's been pushed to it before.

For the browser side, each **browser profile** (see "What 'second device'
means" below) needs its own clean IndexedDB. To reset one between demo runs:

- Chrome/Edge DevTools → **Application** tab → **Storage** (left sidebar) →
  **Clear site data**, with `http://localhost:3000` as the active tab. Or,
  more surgically: **Application** → **IndexedDB** → right-click the
  `session-replay` database → **Delete database**.
- Alternatively, just use a fresh Incognito/Private window each time — its
  storage is discarded when the window closes, so there's nothing to reset.

## Part 1 — capture and browse fully offline (one profile)

1. Open `http://localhost:3000/` in Browser Profile A (or a fresh Incognito
   window). Click through to **Caregiver mode** once and back — this just
   warms the app shell for both routes in the browser's cache, the same
   one-time thing any non-PWA site needs on a first visit. (If you've used
   the app in this profile before, e.g. from an earlier demo run, you can
   skip this — it's already warm.)
2. Open DevTools → **Network** tab → set **Throttling** to **Offline**.
   This is airplane mode: `navigator.onLine` becomes `false` and every
   `fetch` starts throwing.
3. On the end-user tap surface, tap out a phrase sequence — e.g. **I
   want → more → please**. Watch the small dev-only badge in the
   bottom-right corner count up: `pending sync: 1`, `2`, `3`. That's
   `lib/local-store.ts`'s `appendEvent` writing straight to IndexedDB; there
   is no network code anywhere in that path.
4. Click **Caregiver mode →** (top-left corner) — still offline. The session
   list loads from IndexedDB and shows today's session: **"ongoing · 3
   phrases · Pending sync"**. This is the local list/summary logic in
   `getSessionsGroupedByDay()`, again zero network calls.

At this point you've proven: tap-to-speak capture and the caregiver
session **list** are both fully local. (Opening this *specific, brand-new*
session's own replay page is the one exception — see the note at the very
end of this doc for exactly why, and how to see it work.)

## Part 2 — reconnect and sync

5. Set DevTools Network throttling back to **Online** (or **No throttling**).
6. Either click **Sync now** on `/sessions`, or just wait — the app also
   syncs automatically the moment the browser fires its `online` event (see
   `apps/web/app/providers.tsx`), so simply reconnecting is enough; give it
   a couple of seconds.
7. Refresh (or revisit) the session list: the badge changes from **"Pending
   sync"** to **"Synced"**. Navigate back to `/` and check the dev badge —
   it now reads `pending sync: 0`.

## Part 3 — a second device (a second browser profile)

8. Open `http://localhost:3000/` in Browser Profile B — a genuinely
   different browser (e.g. Firefox if A was Chrome), or a brand-new
   Incognito/Private window. This is what gives it a different `deviceId`
   (see "What 'second device' means" below) — no special setup needed
   beyond "open a fresh profile".
9. Go straight to `http://localhost:3000/sessions` on Profile B. It's empty
   — "No sessions recorded yet on this device" — which is expected: nothing
   has synced to this profile yet.
10. Click **Sync now**.
11. Profile A's session now appears in Profile B's list, with the correct
    phrase count. Click into it: the transcript replays **I want → more →
    please**, in the right order, and Play/Step/Speed all work exactly like
    they did in Profile A.

## Part 4 (optional) — two devices, no duplication

12. On Profile A's tap surface, tap 1-2 more phrases (a fresh session is
    fine — each profile always starts its own local session; there's no UI
    affordance to force two devices into literally one shared session,
    though the sync engine handles that merge correctly too — it's covered
    directly by `apps/web/test/sync-engine.test.ts`, not by clicking
    through the UI).
13. On Profile B's tap surface, tap 1-2 phrases of your own.
14. Click **Sync now** on both profiles' `/sessions` pages (order doesn't
    matter).
15. Confirm: both profiles' session lists now show **all** sessions from
    **both** devices — Profile A's original session, Profile A's new one,
    and Profile B's new one — each exactly once, all marked **Synced**, no
    duplicates, nothing missing.

## What actually happens on reconnect, mechanically

`syncNow()` (`apps/web/lib/sync-engine.ts`) does one push-then-pull cycle:
POST the unsynced local events (and any locally-closed-but-unconfirmed
session) to `/api/sync/push`, mark whatever the server acknowledges as
synced locally; then GET `/api/sync/pull?since=<cursor>` and upsert
whatever comes back into the local store **by id** — which is exactly what
makes step 15 work without duplication: an event that originated on this
device and gets echoed back by the pull is just an overwrite-with-itself,
and an event from the other device is a new row.

## The one caveat: a brand-new session's replay page needs one online visit

Step 4 above works fully offline. If you try to click *into* that
brand-new session's own replay page (`/sessions/<id>`) while still offline,
it'll fail — you'll see this in the console:

```
Failed to fetch RSC payload for http://localhost:3000/sessions/<id>.
Falling back to browser navigation. TypeError: Failed to fetch
```

This is **not** a gap in the offline-first data layer — every byte of that
page's content lives in IndexedDB already and `getEventsForSession` doesn't
touch the network. It's that this app has no service worker, so Next.js's
client router needs one network round trip to fetch that *specific* page's
code/RSC payload the first time it's ever visited — same as any non-PWA
site opening a URL it's never loaded before. The session **list** page
doesn't have this problem because you already visited `/sessions` once in
step 1, before going offline; a session created *while offline* is, by
definition, a URL nobody has visited yet.

To see full offline replay (transcript, Play/Pause/Step/Speed) in action:
reconnect briefly, open that session's replay page once, then go back
offline — from that point on, revisiting it and using every control on it
is 100% local (confirmed: we drove Play while offline against an
already-opened replay page and it worked, no network calls, transcript
highlight tracked the real inter-tap timing correctly). A service worker
that precaches the app shell would close this one gap entirely; it wasn't
in scope here.
