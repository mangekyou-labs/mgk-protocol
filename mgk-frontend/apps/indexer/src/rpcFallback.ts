/**
 * Public devnet fallback for the indexer's JSON-RPC traffic.
 *
 * The dedicated provider (RPC_URL) is used first. When it rate-limits
 * (429), rejects its key (401/403), errors (5xx) or is unreachable, the same
 * request is retried once on the public devnet endpoint so a drained or
 * revoked key degrades the indexer instead of taking it offline.
 */
export const PUBLIC_DEVNET_RPC = 'https://api.devnet.solana.com';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export function shouldFallBack(status: number): boolean {
  return status === 429 || status === 401 || status === 403 || status >= 500;
}

/**
 * Resolve the fallback endpoint. Unset means public devnet; "off" disables
 * the fallback; any other value is used as-is.
 */
export function resolveFallbackUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return PUBLIC_DEVNET_RPC;
  if (value.toLowerCase() === 'off') return null;
  return value;
}

export function createFallbackFetch(opts: {
  primaryUrl: string;
  fallbackUrl: string | null;
  timeoutMs: number;
  fetch?: Fetch;
  onFallback?: (reason: string) => void;
}): Fetch {
  const doFetch: Fetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const fallbackUrl = opts.fallbackUrl === opts.primaryUrl ? null : opts.fallbackUrl;

  return async (url, init) => {
    const attempt = (target: string) =>
      doFetch(target, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) });

    let reason: string;
    try {
      const res = await attempt(url);
      if (!fallbackUrl || url !== opts.primaryUrl || !shouldFallBack(res.status)) return res;
      reason = `primary answered ${res.status}`;
      // Only a fallback answer is returned from here; release the primary body.
      await res.body?.cancel().catch(() => undefined);
    } catch (err) {
      if (!fallbackUrl || url !== opts.primaryUrl) throw err;
      reason = 'primary unreachable';
    }
    // Never log the URL: the primary carries an API key.
    opts.onFallback?.(reason);
    return attempt(fallbackUrl);
  };
}
