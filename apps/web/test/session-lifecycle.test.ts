import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionLifecycle } from '../lib/session-lifecycle';

const IDLE_TIMEOUT_MS = 20_000;

/** A startSession() stub that hands out predictable, incrementing ids. */
function makeStartSession() {
  let n = 0;
  return vi.fn(async () => {
    n += 1;
    return `session-${n}`;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('session segmentation', () => {
  it('keeps taps within 20s in the same session', async () => {
    const startSession = makeStartSession();
    const closeSession = vi.fn(async () => {});
    const lifecycle = createSessionLifecycle({
      startSession,
      closeSession,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
    });

    // Tap 1
    lifecycle.touch();
    const first = await lifecycle.ensureSession();

    // Tap 2, 5s later — well within the 20s window.
    await vi.advanceTimersByTimeAsync(5_000);
    lifecycle.touch();
    const second = await lifecycle.ensureSession();

    // Tap 3, another 15s later (20s since tap 1, but only 15s since tap 2 —
    // touch() re-arms the timer on every tap, so this must still count as
    // activity within the window measured from the *last* tap).
    await vi.advanceTimersByTimeAsync(15_000);
    lifecycle.touch();
    const third = await lifecycle.ensureSession();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('starts a new session once 20s of inactivity elapses', async () => {
    const startSession = makeStartSession();
    const closeSession = vi.fn(async () => {});
    const lifecycle = createSessionLifecycle({
      startSession,
      closeSession,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
    });

    lifecycle.touch();
    const first = await lifecycle.ensureSession();

    // No further activity for the full idle window — the idle timer itself
    // fires forceClose().
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith(first);
    expect(lifecycle.getCurrentSessionId()).toBeNull();

    // Next tap, after the idle close, starts a genuinely new session.
    lifecycle.touch();
    const second = await lifecycle.ensureSession();

    expect(second).not.toBe(first);
    expect(startSession).toHaveBeenCalledTimes(2);
  });

  it('force-closes on demand (visibilitychange/pagehide) even well under 20s', async () => {
    const startSession = makeStartSession();
    const closeSession = vi.fn(async () => {});
    const lifecycle = createSessionLifecycle({
      startSession,
      closeSession,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
    });

    lifecycle.touch();
    const first = await lifecycle.ensureSession();

    // Only 5s in — nowhere near the 20s idle timeout — but the app is
    // backgrounded/torn down, so the page component calls forceClose()
    // directly (this is what its visibilitychange/pagehide handlers do).
    await vi.advanceTimersByTimeAsync(5_000);
    lifecycle.forceClose();

    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith(first);
    expect(lifecycle.getCurrentSessionId()).toBeNull();

    // The idle timer that was pending for the old session must not also
    // fire later and close whatever session comes next.
    lifecycle.touch();
    const second = await lifecycle.ensureSession();
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 5_000 - 1); // when the *old* timer would have fired
    expect(closeSession).toHaveBeenCalledTimes(1); // still just the one force-close, not a stray second call
    expect(lifecycle.getCurrentSessionId()).toBe(second);
  });

  it('does not start a second session for two taps racing before the first startSession() resolves', async () => {
    let resolveStart!: (id: string) => void;
    const startSession = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const closeSession = vi.fn(async () => {});
    const lifecycle = createSessionLifecycle({
      startSession,
      closeSession,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
    });

    lifecycle.touch();
    const p1 = lifecycle.ensureSession();
    lifecycle.touch();
    const p2 = lifecycle.ensureSession(); // lands before startSession() has resolved at all

    resolveStart('session-1');
    const [id1, id2] = await Promise.all([p1, p2]);

    expect(id1).toBe('session-1');
    expect(id2).toBe('session-1');
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it('reports session-close failures via onError without throwing', async () => {
    const startSession = makeStartSession();
    const closeSession = vi.fn(async () => {
      throw new Error('local db write failed');
    });
    const onError = vi.fn();
    const lifecycle = createSessionLifecycle({
      startSession,
      closeSession,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      onError,
    });

    lifecycle.touch();
    await lifecycle.ensureSession();
    lifecycle.forceClose();
    // closeSession() is fire-and-forget — let its rejection propagate to onError.
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  });
});
