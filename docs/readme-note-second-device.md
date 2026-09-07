# Draft README note: what "second device" means in this submission

> The following is drafted for you to fold into the final README — not
> wired in automatically. Suggested placement: wherever the README
> describes the sync/multi-device story, or as a short callout near
> `docs/demo.md`.

---

**A note on "second device":** throughout this project — including the demo
in `docs/demo.md` — a second device is implemented as a second browser
profile (a different browser, or a fresh Incognito/Private window) talking
to the same backend instance, rather than two physically separate devices
or two separately deployed backends.

That's a faithful simulation of the sync behavior actually being tested,
for two reasons:

1. **`deviceId` is the unit of identity the sync protocol operates on, not
   the physical hardware.** Every event carries a `deviceId` that's
   generated once and persisted in that browser profile's own IndexedDB
   (`getOrCreateDeviceId` in `apps/web/lib/local-store.ts`). The server-side
   push/pull/ordering logic (`apps/api`) only ever reasons about events,
   sessions, and `deviceId` strings over HTTP — it has no way to know or
   care whether the client sending them is a phone, a tablet, or a browser
   tab. A second Incognito window has its own origin storage, so it mints
   its own `deviceId` exactly as a second physical device would; from the
   server's point of view, the two are indistinguishable.
2. **What a second physical device would add is out of scope for what's
   being tested here.** OS-level background sync scheduling, native push
   notifications, and hardware speech-synthesis quality aren't part of what
   this project built, and aren't what a take-home reviewer is checking.
   What *is* being tested — idempotent push-by-id, cursor-based pull,
   cross-device event merge into one session without duplication or loss,
   deviceSeq/clientTimestamp ordering — is entirely a function of HTTP
   requests carrying a `deviceId` and a batch of events. A second browser
   profile reproduces that exactly, because that's genuinely all the
   protocol sees.

The one thing a second browser profile *can't* simulate is truly
independent, flaky network conditions on two physical devices at once — but
the sync engine's offline/retry/idempotency behavior is already covered
directly with mocked network failures in
`apps/web/test/sync-engine.test.ts`, so the manual demo focuses on what a
human clicking through the UI can usefully show: correct data flow and
merge behavior end to end against the real API, not network fault
injection.
