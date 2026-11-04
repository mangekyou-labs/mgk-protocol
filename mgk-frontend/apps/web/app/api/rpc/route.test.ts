import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const A = 'https://a.example/?api-key=secret-a';
const B = 'https://b.example/?api-key=secret-b';

function rpcRequest(body: unknown, init: RequestInit = {}): Request {
  return new Request('http://localhost/api/rpc', {
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

describe('POST /api/rpc', () => {
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
    ['429', () => new Response('slow down', { status: 429 })],
    ['503', () => new Response('down', { status: 503 })],
    ['401 (revoked key)', () => new Response('unauthorized', { status: 401 })],
    ['403 (key over quota)', () => new Response('forbidden', { status: 403 })],
    ['network error', () => new Error('ECONNRESET')],
  ])('fails over to the next upstream on %s', async (_label, failure) => {
    const fetcher = upstreamReturning(failure(), ok(7));
    const { POST } = await loadRoute();
    const res = await POST(rpcRequest(call('getSlot')));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: 7 });
    expect(fetcher.mock.calls.map(([u]) => u)).toEqual([A, B]);
  });

  it('passes a 4xx answer through without failing over', async () => {
    const fetcher = upstreamReturning(new Response('bad', { status: 400 }));
    const { POST } = await loadRoute();
    const res = await POST(rpcRequest(call('getSlot')));
    expect(res.status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rotates the first upstream across requests', async () => {
    const fetcher = upstreamReturning(ok(1), ok(2), ok(3));
    const { POST } = await loadRoute();
    await POST(rpcRequest(call('getSlot')));
    await POST(rpcRequest(call('getSlot')));
    await POST(rpcRequest(call('getSlot')));
    expect(fetcher.mock.calls.map(([u]) => u)).toEqual([A, B, A]);
  });

  it('answers 502 without leaking upstream URLs when every upstream fails', async () => {
    upstreamReturning(new Response('x', { status: 429 }), new Error(`connect failed ${B}`));
    const { POST } = await loadRoute();
    const res = await POST(rpcRequest(call('getSlot')));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain('secret');
    expect(text).not.toContain('example');
  });

  it('answers 429 when every upstream is rate limited so the client backs off', async () => {
    upstreamReturning(new Response('x', { status: 429 }), new Response('y', { status: 429 }));
    const { POST } = await loadRoute();
    const res = await POST(rpcRequest(call('getSlot')));
    expect(res.status).toBe(429);
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
