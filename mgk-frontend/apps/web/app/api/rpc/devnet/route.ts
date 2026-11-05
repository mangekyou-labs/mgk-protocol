export const dynamic = 'force-dynamic';

/**
 * Same-origin JSON-RPC proxy. The browser never sees upstream URLs (they
 * carry API keys); only the reads and sends the trading UI needs pass.
 */
const ALLOWED_METHODS = new Set([
  'getAccountInfo',
  'getBalance',
  'getBlockHeight',
  'getEpochInfo',
  'getFeeForMessage',
  'getGenesisHash',
  'getHealth',
  'getLatestBlockhash',
  'getMinimumBalanceForRentExemption',
  'getMultipleAccounts',
  'getRecentPrioritizationFees',
  'getSignatureStatuses',
  'getSlot',
  'getTransaction',
  'getVersion',
  'isBlockhashValid',
  'sendTransaction',
  'simulateTransaction',
]);

const UPSTREAM_TIMEOUT_MS = 10_000;
// A signed transaction is at most 1232 bytes (~1.7 KB base64); reads are tiny.
const MAX_BODY_BYTES = 64 * 1024;
const MAX_BATCH = 20;

/**
 * The one dedicated devnet provider: the first entry of RPC_UPSTREAMS. Every
 * service reads the same provider so they never disagree about chain state;
 * there is no rotation, no cross-provider failover and no silent public
 * fallback (the public endpoint is a manual operator fallback only).
 */
function upstream(): string | null {
  const first = (process.env.RPC_UPSTREAMS ?? '')
    .split(',')
    .map((u) => u.trim())
    .find(Boolean);
  return first ?? null;
}

function rpcError(status: number, message: string): Response {
  return Response.json(
    { jsonrpc: '2.0', id: null, error: { code: -32600, message } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(req: Request): Promise<Response> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return rpcError(413, 'Request too large');
  }
  const body = await req.text();
  if (body.length > MAX_BODY_BYTES) return rpcError(413, 'Request too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return rpcError(400, 'Invalid JSON');
  }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  const allowed = calls.length > 0 && calls.length <= MAX_BATCH && calls.every(
    (c) => typeof c === 'object' && c !== null && ALLOWED_METHODS.has((c as { method?: unknown }).method as string),
  );
  if (!allowed) return rpcError(403, 'Method not allowed');

  // Fail closed: without the dedicated provider the UI must show RPC unavailable.
  const url = upstream();
  if (url === null) return rpcError(503, 'RPC unavailable');

  // Never echo upstream errors: their URLs carry API keys. A uniform 429 lets
  // web3.js apply its own backoff. Other answers (including 400 and JSON-RPC
  // errors) belong to the caller and pass through.
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return rpcError(502, 'Upstream unavailable');
  }
  if (res.status === 429) return rpcError(429, 'Rate limited');
  if (res.status === 401 || res.status === 403 || res.status >= 500) return rpcError(502, 'Upstream unavailable');
  return new Response(await res.text(), {
    status: res.status,
    headers: { 'content-type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
