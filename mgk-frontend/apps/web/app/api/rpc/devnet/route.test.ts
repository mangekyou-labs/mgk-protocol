import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const A = 'https://a.example/?api-key=secret-a';
const B = 'https://b.example/?api-key=secret-b';

function rpcRequest(body: unknown, init: RequestInit = {}): Request {
  return new Request('http://localhost/api/rpc/devnet', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

const call = (method: string, id = 1) => ({ jsonrpc: '2.0', id, method, params: [] });

function upstreamReturning(...responses: Array<Response | Error>) {
  const fetcher = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) fetcher.mockRejectedValueOnce(r);
    else fetcher.mockResolvedValueOnce(r);
  }
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id: 1, result });

async function loadRoute() {
  vi.resetModules();
  return import('./route');
}

beforeEach(() => {
  vi.stubEnv('RPC_UPSTREAMS', `${A},${B}`);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('POST /api/rpc/devnet', () => {
  it('forwards an allowlisted call to an upstream and returns its body', async () => {
    const fetcher = upstreamReturning(ok(123));
    const { POST } = await loadRoute();
    const res = await POST(rpcRequest(call('getSlot')));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: 123 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(A);
    expect(JSON.parse(init.body as string)).toEqual(call('getSlot'));
  });

  it('rejects methods outside the allowlist without touching an upstream', async () => {
    const fetcher = upstreamReturning();
    const { POST } = await loadRoute();
    const res = await POST(rpcRequest(call('getProgramAccounts')));
    expect(res.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['unset', undefined],
    ['empty', ' , '],
  ])('uses public devnet when RPC_UPSTREAMS is %s', async (_label, value) => {
    vi.stubEnv('RPC_UPSTREAMS', value ?? '');
    if (value === undefined) delete process.env.RPC_UPSTREAMS;
    const fetcher = upstreamReturning(ok(1));
    const { POST, PUBLIC_DEVNET_RPC } = await loadRoute();
    const res = await POST(rpcRequest(call('getSlot')));
    expect(res.status).toBe(200);
    expect(fetcher.mock.calls.map(([u]) => u)).toEqual([PUBLIC_DEVNET_RPC]);
  });

  it('answers 503 when no upstream is set and the fallback is off', async () => {
    vi.stubEnv('RPC_UPSTREAMS', '');
    vi.stubEnv('RPC_PUBLIC_FALLBACK', 'off');
    const fetcher = upstreamReturning(ok(1));
    const { POST } = await loadRoute();
    const res = await POST(rpcRequest(call('getSlot')));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { message: 'RPC unavailable' } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses only the first configured upstream while it is healthy', async () => {
    const fetcher = upstreamReturning(ok(1), ok(2), ok(3));
    const { POST } = await loadRoute();
    await POST(rpcRequest(call('getSlot')));
    await POST(rpcRequest(call('getSlot')));
    await POST(rpcRequest(call('getSlot')));
    expect(fetcher.mock.calls.map(([u]) => u)).toEqual([A, A, A]);
  });

  const failures: Array<[string, () => Response | Error]> = [
    ['429 (rate limited)', () => new Response(`slow down ${A}`, { status: 429 })],
    ['503', () => new Response(`down ${A}`, { status: 503 })],
    ['401 (revoked key)', () => new Response('unauthorized', { status: 401 })],
    ['403 (key over quota)', () => new Response('forbidden', { status: 403 })],
    ['network error', () => new Error(`connect failed ${A}`)],
  ];

  it.each(failures)('falls back to public devnet on %s', async (_label, failure) => {
    const fetcher = upstreamReturning(failure(), ok(7));
    const { POST, PUBLIC_DEVNET_RPC } = await loadRoute();
    const res = await POST(rpcRequest(call('getSlot')));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: 7 });
    expect(fetcher.mock.calls.map(([u]) => u)).toEqual([A, PUBLIC_DEVNET_RPC]);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body as string)).toEqual(call('getSlot'));
  });

  it.each(failures)('answers a sanitized error on %s when fallback is off', async (label, failure) => {
    vi.stubEnv('RPC_PUBLIC_FALLBACK', 'off');
    const fetcher = upstreamReturning(failure(), ok(7));
    const { POST } = await loadRoute();
    const res = await POST(rpcRequest(call('getSlot')));
    expect(res.status).toBe(label.startsWith('429') ? 429 : 502);
    const text = await res.text();
    expect(text).not.toContain('secret');
    expect(text).not.toContain('example');
    expect(fetcher.mock.calls.map(([u]) => u)).toEqual([A]);
  });

  it('answers the fallback status, sanitized, when both endpoints fail', async () => {
    upstreamReturning(new Response(`x ${A}`, { status: 429 }), new Response('down', { status: 503 }));
    const { POST } = await loadRoute();
    const res = await POST(rpcRequest(call('getSlot')));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('secret');

    upstreamReturning(new Error(`boom ${A}`), new Response('slow', { status: 429 }));
    const res2 = await POST(rpcRequest(call('getSlot')));
    expect(res2.status).toBe(429);
  });

  it('honours an RPC_PUBLIC_FALLBACK override', async () => {
    vi.stubEnv('RPC_PUBLIC_FALLBACK', B);
    const fetcher = upstreamReturning(new Response('x', { status: 429 }), ok(7));
    const { POST } = await loadRoute();
    expect((await POST(rpcRequest(call('getSlot')))).status).toBe(200);
    expect(fetcher.mock.calls.map(([u]) => u)).toEqual([A, B]);
  });

  it('passes a 4xx answer through', async () => {
    const fetcher = upstreamReturning(new Response('bad', { status: 400 }));
    const { POST } = await loadRoute();
    const res = await POST(rpcRequest(call('getSlot')));
    expect(res.status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed JSON and batches containing a disallowed method', async () => {
    const fetcher = upstreamReturning();
    const { POST } = await loadRoute();
    expect((await POST(rpcRequest('{nope'))).status).toBe(400);
    expect((await POST(rpcRequest([call('getSlot', 1), call('requestAirdrop', 2)]))).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects oversized bodies before parsing', async () => {
    const fetcher = upstreamReturning();
    const { POST } = await loadRoute();
    const huge = JSON.stringify({ ...call('sendTransaction'), params: ['x'.repeat(70_000)] });
    expect((await POST(rpcRequest(huge))).status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
