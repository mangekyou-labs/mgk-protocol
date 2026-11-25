import { describe, it, expect, vi } from 'vitest';
import { createFallbackFetch, resolveFallbackUrl, PUBLIC_DEVNET_RPC } from './rpcFallback.js';

const PRIMARY = 'https://rpc.example/?api-key=SECRET';

function stub(...responses: Array<number | Error>) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response('{"jsonrpc":"2.0","id":1,"result":1}', { status: next ?? 200 });
  });
  return { fn, calls };
}

describe('createFallbackFetch', () => {
  it.each([429, 401, 403, 500, 503])('retries on public devnet when primary answers %i', async (status) => {
    const { fn, calls } = stub(status, 200);
    const onFallback = vi.fn();
    const f = createFallbackFetch({ primaryUrl: PRIMARY, fallbackUrl: PUBLIC_DEVNET_RPC, timeoutMs: 1000, fetch: fn, onFallback });
    const res = await f(PRIMARY, { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(calls).toEqual([PRIMARY, PUBLIC_DEVNET_RPC]);
    expect(onFallback).toHaveBeenCalledWith(`primary answered ${status}`);
    expect(JSON.stringify(onFallback.mock.calls)).not.toContain('SECRET');
  });

  it('retries on public devnet when primary throws', async () => {
    const { fn, calls } = stub(new Error('ECONNRESET'), 200);
    const f = createFallbackFetch({ primaryUrl: PRIMARY, fallbackUrl: PUBLIC_DEVNET_RPC, timeoutMs: 1000, fetch: fn });
    expect((await f(PRIMARY)).status).toBe(200);
    expect(calls).toEqual([PRIMARY, PUBLIC_DEVNET_RPC]);
  });

  it('does not fall back on success or client errors', async () => {
    const { fn, calls } = stub(200, 400);
    const f = createFallbackFetch({ primaryUrl: PRIMARY, fallbackUrl: PUBLIC_DEVNET_RPC, timeoutMs: 1000, fetch: fn });
    expect((await f(PRIMARY)).status).toBe(200);
    expect((await f(PRIMARY)).status).toBe(400);
    expect(calls).toEqual([PRIMARY, PRIMARY]);
  });

  it('returns the fallback answer when both fail', async () => {
    const { fn } = stub(429, 503);
    const f = createFallbackFetch({ primaryUrl: PRIMARY, fallbackUrl: PUBLIC_DEVNET_RPC, timeoutMs: 1000, fetch: fn });
    expect((await f(PRIMARY)).status).toBe(503);
  });

  it('does nothing when disabled or when primary is already public devnet', async () => {
    for (const [primary, fallback] of [[PRIMARY, null], [PUBLIC_DEVNET_RPC, PUBLIC_DEVNET_RPC]] as const) {
      const { fn, calls } = stub(429);
      const f = createFallbackFetch({ primaryUrl: primary, fallbackUrl: fallback, timeoutMs: 1000, fetch: fn });
      expect((await f(primary)).status).toBe(429);
      expect(calls).toEqual([primary]);
    }
  });
});

describe('resolveFallbackUrl', () => {
  it('defaults to public devnet, honours off and overrides', () => {
    expect(resolveFallbackUrl(undefined)).toBe(PUBLIC_DEVNET_RPC);
    expect(resolveFallbackUrl('  ')).toBe(PUBLIC_DEVNET_RPC);
    expect(resolveFallbackUrl('OFF')).toBeNull();
    expect(resolveFallbackUrl('https://other.example')).toBe('https://other.example');
  });
});
