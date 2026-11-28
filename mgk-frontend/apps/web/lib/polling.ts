/**
 * Shared refresh semantics for polled reads.
 *
 * A single failed poll is usually a rate limit or a dropped request, so the
 * UI keeps the last good value and stays quiet. Only after this many
 * consecutive failures does a reader report an error (and, where the value
 * would otherwise be stale, drop it to "unknown").
 */
export const FAILURE_THRESHOLD = 3;

/** Shown in place of raw transport errors (429s, 5xx, fetch failures). */
export const NETWORK_BUSY = 'Network busy, retrying…';

const TRANSPORT_ERROR =
  /\b(429|5\d\d)\b|jsonrpc|too many requests|failed to fetch|fetch failed|network ?error|timed? ?out|timeout|\bE(?:CONN\w+|TIMEDOUT)\b|service unavailable|bad gateway/i;

/**
 * Maps raw RPC/transport failures to a short user-facing line. Domain errors
 * (wrong cluster, owner mismatch, decode failures) pass through unchanged
 * because they describe something the user can act on.
 */
export function friendlyRpcError(message: string | null | undefined): string | null {
  if (!message) return null;
  return TRANSPORT_ERROR.test(message) ? NETWORK_BUSY : message;
}

/**
 * Runs `tick` every `intervalMs` while the page is visible. Hidden tabs skip
 * their ticks (each poll costs indexer bandwidth and RPC credits), and the
 * tab catches up with one tick as soon as it is shown again. Returns the
 * cleanup that stops the interval and the listener.
 */
export function pollWhileVisible(tick: () => void, intervalMs: number): () => void {
  // No `document` outside the browser (node tests, SSR): poll unconditionally.
  const doc = typeof document === 'undefined' ? null : document;
  const handle = setInterval(() => {
    if (!doc?.hidden) tick();
  }, intervalMs);
  const onVisibility = () => {
    if (!doc?.hidden) tick();
  };
  doc?.addEventListener('visibilitychange', onVisibility);
  return () => {
    clearInterval(handle);
    doc?.removeEventListener('visibilitychange', onVisibility);
  };
}
