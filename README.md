# session-replay

An offline-first AAC (augmentative and alternative communication) tap surface, with a local-first event log that syncs to a backend and a caregiver mode to review and replay sessions.

## 1. Setup

**Prerequisites:** Node.js ≥ 18.18 (see `engines` in the root `package.json`), npm. No database server to install — the backend is SQLite via Prisma, and the client store is IndexedDB in the browser. The web app needs no environment variables (`NEXT_PUBLIC_API_URL` defaults to `http://localhost:4000` if unset — see `apps/web/lib/sync-engine.ts`); the API needs `DATABASE_URL`, which is `.gitignore`d like any `.env`, so copy the example first.

```bash
git clone <repo>
cd session-replay
npm install                       # installs and links all three workspaces
cp apps/api/.env.example apps/api/.env   # DATABASE_URL + PORT — required, see above
npm run seed                      # apps/api/prisma: drops + recreates the SQLite db, empty
npm run dev                       # runs apps/web and apps/api together
```

`npm run dev` builds `packages/shared` first (an npm `predev` hook), then starts both apps concurrently via `concurrently`:

- **apps/web** — Next.js, `http://localhost:3000`
- **apps/api** — Express, `http://localhost:4000` (`GET /health` → `{"status":"ok"}`)

Open `http://localhost:3000` for the end-user tap surface, or `http://localhost:3000/sessions` for caregiver mode (there's also a small "Caregiver mode →" link in the tap surface's top-left corner).

**Resetting the backend's data** between runs: `npm run seed` (root) or `npm run seed -w @session-replay/api` — runs `prisma migrate reset --force`, which drops and recreates `apps/api/prisma/dev.db` from the migration history. **Resetting a browser profile's local data:** DevTools → Application → Storage → "Clear site data" for `localhost:3000`, or just use a fresh Incognito window (see `docs/demo.md` for the full cross-device demo walkthrough, which uses both of these).

**Other commands:** `npm run build` (all three workspaces), `npm test` (vitest — 8 api tests, 18 web tests), `npm run lint`, `npm run format`.

**Time to get running:** `npm install` is the only slow step (dependency download); everything else is instant. Well under 10 minutes on a normal connection.

---

## 2. Design

### Assumptions on questions the assignment left open

Every item below is the assumption actually implemented, with the reasoning taken from the comment already sitting next to the code — not restated from memory.

**Which UI interactions count as an "event."** Only two: tapping a tile (`tile_tap`) and clearing the sentence bar (`clear_bar`). From `packages/shared/src/types.ts`:

> We deliberately exclude folder navigation, keyboard/tone switches, and other UI events because they don't contribute to "what was communicated," which is the only thing session replay needs to reconstruct. Session replay here is a communication transcript … not a full UI interaction recorder — capturing navigation/UI chrome would add volume and privacy surface without adding anything a reviewer needs to understand what was said.

**How to order events from multiple devices in one session.** Within a device, `deviceSeq` (a monotonic per-device counter) is authoritative. Across devices, sort by `clientTimestamp`, with `deviceId` as a tiebreak for an exact tie. From the same file:

> This is a "good enough" rule, not a vector-clock-correct one: there is no server-authoritative clock and no causal handshake between devices, so two devices with skewed clocks can produce a merged order that isn't the "true" causal order. That tradeoff is acceptable here because this is a communication transcript, not a financial ledger — exact millisecond ordering across devices doesn't change what was meaningfully said.

**Where a session boundary falls.** 20 seconds of inactivity, or an explicit `visibilitychange`/`pagehide` event, whichever comes first (`apps/web/lib/session-lifecycle.ts`):

> Why 20s specifically: long enough that normal thinking/scanning time between taps doesn't fragment a real communication attempt into several sessions, but short enough that a genuine pause (put the device down, walk away) closes the turn rather than letting one session silently span hours of unrelated activity.

**What the sync push endpoint actually carries.** Only events — not sessions directly (`apps/web/lib/sync-engine.ts`):

> `/api/sync/push` only accepts `events` in its body — there's no endpoint to push a session directly. The server learns a session exists implicitly, from the first event that references it, and learns it's closed only via the dedicated `POST /api/sync/sessions/:id/close`. … A still-open local session needs no explicit call of its own — pulling will hand it back to us (server-created from our own pushed events).

**How the pull cursor stays correct when a session is edited, not just created.** A shared `SyncSeq` counter table stamps `serverSeq` on both `Session` and `SessionEvent` rows, re-minted on update (`apps/api/prisma/schema.prisma`):

> The pull contract is "created OR UPDATED after cursor": a Session can be mutated later (`POST .../close` sets `endedAt`), and that update needs to become visible to a client that already pulled past the session's original row. SQLite also only allows one native AUTOINCREMENT column per table … Instead, `serverSeq` on both tables is a plain Int stamped from one shared counter … minted once when a row is created, and re-minted whenever it's meaningfully updated.

**How a caregiver reviews playback timing.** Scaled, not literal — see "Alternatives" below.

### Architecture

```
             apps/web (browser)
┌──────────────────────────────────────────┐
│  end-user tap surface                    │
│  caregiver mode                          │
└─────────────────────┬────────────────────┘
                      │  tap -> sentence-bar update + speak() are
                      │  synchronous; local-store write is fire-and-forget
                      v
┌──────────────────────────────────────────┐
│  local Dexie store (IndexedDB)           │
│  events . sessions . meta                │
│  source of truth for THIS device         │
└─────────────────────┬────────────────────┘
                      │  read unsynced / write pulled
                      v
┌──────────────────────────────────────────┐
│  sync engine                             │
│  triggers only: online event, 30s        │
│  interval, caregiver Sync now button     │
│  -- never a tap                          │
└─────────────────────┬────────────────────┘
                      │  HTTP -- the ONLY network calls apps/web makes
                      │  push: batch, idempotent by id
                      │  pull: cursor-based, upsert by id
                      v
             apps/api (Express)
┌──────────────────────────────────────────┐
│  POST /api/sync/push                     │
│  GET  /api/sync/pull                     │
│  GET  /api/sessions[/:id]                │
└─────────────────────┬────────────────────┘
                      │  Prisma
                      v
┌──────────────────────────────────────────┐
│  SQLite -- system of record              │
│  across all devices                      │
└──────────────────────────────────────────┘
```

Why split it this way: the client can't treat the backend as its source of truth, because tap-to-speak has to work with zero network and zero latency — by the time a request to a server could round-trip, the phrase should already be spoken. So the local Dexie store has to be authoritative for *this device's own experience*, written to directly and immediately. But a single device's local store can't be the source of truth for the *system* — it has no way to know what other devices captured, or resolve two devices both writing into the same session. That's what the backend is for: not a cache in front of the client, but the one place where events from every device actually converge into one merged, ordered transcript. The sync engine is the seam between those two roles, and it only ever runs in the background specifically so the "local store is authoritative for this device" half of that split never gets compromised by waiting on the "backend is authoritative for the merge" half.

### Data model

`packages/shared/src/types.ts` defines the wire types both apps import, so the format can't drift:

- `TapEvent = { id, type: 'tile_tap', sessionId, deviceId, deviceSeq, clientTimestamp, tileId, phraseText }`
- `ClearBarEvent` — same envelope, no `tileId`/`phraseText`
- `SessionEvent = TapEvent | ClearBarEvent`
- `Session = { id, deviceId, startedAt, endedAt: string | null }`

Sync/conflict approach: **push is idempotent by `id`** — `POST /api/sync/push` upserts each event by its client-generated UUID; an id the server already has comes back in `duplicates`, not as an error, so a client can always safely retry (`apps/api/src/routes/sync.ts`). **Pull is cursor-based and merges by upsert** — `GET /api/sync/pull?since=<cursor>` returns everything with a `serverSeq` past the cursor, and the client applies it with `bulkPut` keyed by `id` (`apps/web/lib/local-store.ts`'s `upsertEvents`). There is no separate "conflict resolution" step because there's nothing to resolve: two devices' events always have different ids, so merging is just insertion, never overwrite of one device's data by another's.

What happens, concretely, to two overlapping/out-of-order events from different devices in the same session: both get pushed independently (each device only knows its own `deviceSeq`), both land in the `SessionEvent` table under the same `sessionId`, and `getEventsForSession` — or the server's equivalent `GET /api/sessions/:id/events` — sorts the merged set by the ordering rule above (`clientTimestamp`, then `deviceId`, then `deviceSeq`) every time it's read. This isn't just asserted — it's covered by:

- `apps/web/test/local-store.test.ts` — *"orders events from two devices with overlapping timestamps per the Phase 1 rule"* and *"breaks a same-device, same-timestamp tie by deviceSeq"*
- `apps/api/test/sessions.test.ts` — the same two scenarios, against the real HTTP endpoint and SQLite
- `apps/web/test/sync-engine.test.ts` — *"merges an event from another device into the local store without clobbering a local event in the same session"* and *"never produces a duplicate transcript line when a push is retried after its server ack was lost"*

### Alternatives considered and rejected

**localStorage instead of IndexedDB for the local store.** Rejected — `apps/web/lib/local-store.ts`:

> localStorage.getItem/setItem block the main thread, and the cost scales with how much you've already stored … `events` here is an append-only log that only grows for the life of a session … A tap-to-speak interaction can never afford to wait on that … a synchronous, linearly-slower-over-time store would quietly undermine that as the log grows.

Plus no structured querying (a flat string map vs. real IndexedDB indexes) and a much smaller storage quota for a log meant to accumulate for the device's whole lifetime.

**A CRDT/vector-clock scheme for cross-device event ordering.** Rejected in favor of the `clientTimestamp` + `deviceId` + `deviceSeq` rule above, for the same reason quoted in "Assumptions": there's no server-authoritative clock or causal handshake to make a vector clock meaningful here, and the actual requirement — a coherent, roughly-right transcript for a human reviewer — doesn't need causal correctness, only "good enough" cross-device interleaving with exact within-device ordering. A CRDT would add real implementation and reasoning complexity (vector clocks per device, merge logic, clock reconciliation) to correctly solve a problem — perfectly reconstructing causal order across devices with skewed clocks — that this system doesn't actually have, since it's a communication transcript, not a ledger.

### End-user experience: the no-latency decisions

The whole design of the tap surface is built around one rule, stated directly in `app/(enduser)/page.tsx`'s tap handler: *"logging must never be in the critical path of tap-to-speak."* Concretely:

- **The sentence bar updates and `speechSynthesis.speak()` fires synchronously**, before anything else happens — `handleTileTap`'s "critical path" section does only `setSentence`, `speak()`, and arming the idle timer; no `await`, no I/O.
- **`speak()` cancels any in-flight utterance first** (`lib/speak.ts`), specifically so a burst of fast taps doesn't queue up stale audio behind the newest one — "the opposite of 'immediate' on the tap surface."
- **The local event-log write is fire-and-forget**, dispatched only after the two steps above, wrapped in try/catch that only logs to the console — never surfaces to the UI: *"A failed local write is lost silently from the user's perspective (loudly, to the console)."*
- **Sync never runs synchronously with a tap.** `syncNow()` is only ever called from three places, none of them a tap handler: the browser's `online` event, a 30s background interval (both wired up in `app/providers.tsx`), and the caregiver-mode "Sync now" button. `lib/sync-engine.ts`: *"sync is opportunistic background traffic, never on the critical path of anything the end user does."*
- **No error UI exists on the tap surface at all** — a failed local write, a failed sync, being fully offline, are all silent from the end user's point of view. Caregiver mode is the only place sync status (last synced time, pending count, per-session sync badges) is ever shown.

---

## 3. What's next

With two more days, in rough priority order:

1. **Real device/profile identity instead of one hardcoded board.** Today every browser gets the same 24-tile placeholder board (`TILES` in `app/(enduser)/page.tsx`) and `deviceId` is just an anonymous UUID minted on first load — there's no concept of "whose board this is" or per-user customization. Real accounts/profiles would need to attach to `deviceId` server-side and drive which board a device loads.
2. **A retention/delete policy for sessions.** Right now nothing ever expires — every tap lives forever in both IndexedDB and SQLite. This is explicitly not just a technical decision: a session transcript is a real record of what someone communicated, potentially about their own health, needs, or private life, and how long that's kept (and who can delete it) is a data-sensitivity and consent question that belongs to whoever owns the product, not something to default silently in code.
3. **Clock-skew-aware ordering**, replacing the "good enough" `clientTimestamp` tiebreak. The current rule (see "Alternatives" above) accepts that two devices with meaningfully skewed clocks can produce a merged order that isn't truly causal. A lightweight fix short of a full CRDT — e.g. having the server stamp an approximate clock-offset estimate per device on each push, and using corrected timestamps for cross-device sort — would meaningfully improve correctness without the complexity of full vector clocks.
4. **TTS voice/rate matching between live tap-to-speak and replay.** `lib/speak.ts` just calls `new SpeechSynthesisUtterance(text)` with browser defaults every time — replaying a session on a different device/browser (different available voices) won't sound like the original interaction. Recording the voice/rate/pitch actually used at tap time and trying to match it (or at least surfacing "recorded voice unavailable, playing with X instead") on replay would make caregiver review more trustworthy.
5. **A visible conflict/merge UI for caregivers**, instead of always silently upserting. The sync engine's upsert-by-id merge is correct and tested, but a caregiver currently has no way to see *that* a merge happened — e.g. that a session has contributions from two devices, or that a session was closed by one device while another kept adding events to it. Surfacing that (even just a "multiple devices contributed to this session" badge) would make the offline-first behavior legible instead of invisible.

---

## A note on AI tool use

This project was built with Claude Code (Claude Sonnet 5) end-to-end, across a sequence of scoped requests — scaffold the monorepo; define the shared event/session types and ordering rule; build the Express API; build the Dexie local store; build the end-user tap surface; build the sync engine; build caregiver mode; write the cross-device demo docs and seed script; and finally, audit and fill test-coverage gaps in the riskiest logic (segmentation, ordering, sync idempotency, pull-cursor correctness). Each request specified the behavior and constraints in detail; the code, code comments, tests, and this README were AI-drafted directly from those specs, including the judgment calls documented inline above (event scope, ordering rule, the 20s window, the SyncSeq design, etc.) where the spec left something open.

None of it was accepted un-verified. Concretely: every phase ended with an actual `build`/`lint`/`test` run, not just written code; several bugs were caught and fixed this way rather than by inspection alone — an `Edit` that accidentally deleted the Prisma `datasource` block (caught by the next `prisma migrate` failing), a route collision between two Next.js pages resolving to the same URL, an ESLint config pointing at the wrong tsconfig once test files existed, and a Next.js dev-mode client-router limitation discovered only by actually driving the offline demo in a real headless browser (Playwright) rather than assuming it would work. The backend was exercised with real `curl` requests against a running server, not just unit tests; the frontend flows (tap-to-speak, offline capture, cross-device sync, session replay) were driven end-to-end in real Chromium sessions — including simulating two separate "devices" as two browser contexts and screenshotting the results — before being called done. Each phase's output was reviewed and directed by the requester before the next phase built on top of it.
