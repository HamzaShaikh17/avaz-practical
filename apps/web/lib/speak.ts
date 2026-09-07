/**
 * Wraps speechSynthesis.speak with a cancel-first policy: without cancelling
 * whatever's queued/in-flight first, rapid calls (fast taps on the end-user
 * screen, or a fast-forwarded session replay) queue up utterances and play
 * them back-to-back — so the Nth call's audio only starts after N-1 stale
 * ones finish. That's the opposite of "immediate" on the tap surface, and
 * the opposite of "keep pace with playback" during replay. The newest call
 * should always win.
 */
export function speak(text: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return;
  }
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}
