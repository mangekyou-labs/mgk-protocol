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
  ])('answers a 503 JSON-RPC error when RPC_UPSTREAMS is %s, never the public endpoint', async (_label, value) => {
    vi.stubEnv('RPC_UPSTREAMS', value ?? '');
    if (value === undefined) delete process.env.RPC_UPSTREAMS;
    const fetcher = upstreamReturning(ok(1));
    const { POST } = await loadRoute();
    const res = await POST(rpcRequest(call('getSlot')));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { message: 'RPC unavailable' } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses only the first configured upstream for every request', async () => {
    const fetcher = upstreamReturning(ok(1), ok(2), ok(3));
    const { POST } = await loadRoute();
    await POST(rpcRequest(call('getSlot')));
    await POST(rpcRequest(call('getSlot')));
    await POST(rpcRequest(call('getSlot')));
    expect(fetcher.mock.calls.map(([u]) => u)).toEqual([A, A, A]);
  });

  it.each([
    ['503', () => new Response(`down ${A}`, { status: 503 })],
    ['401 (revoked key)', () => new Response('unauthorized', { status: 401 })],
    ['403 (key over quota)', () => new Response('forbidden', { status: 403 })],
    ['network error', () => new Error(`connect failed ${A}`)],
  ])('answers 502 on %s without failing over or leaking the upstream URL', async (_label, failure) => {
    const fetcher = upstreamReturning(failure(), ok(7));
    const { POST } = await loadRoute();
    const res = await POST(rpcRequest(call('getSlot')));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain('secret');
    expect(text).not.toContain('example');
    expect(fetcher.mock.calls.map(([u]) => u)).toEqual([A]);
  });

  it('answers 429 on an upstream rate limit so the client backs off, without failing over', async () => {
    const fetcher = upstreamReturning(new Response('x', { status: 429 }), ok(7));
    const { POST } = await loadRoute();
    const res = await POST(rpcRequest(call('getSlot')));
    expect(res.status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(1);
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
