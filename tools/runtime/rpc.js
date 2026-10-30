'use strict';
// Minimal JSON-RPC over HTTP, shared by the local runtime harness and the audit CLI.
// Transport failures keep fetch's error (and its `cause`); HTTP and RPC errors name the method.
function jsonRpc(url, { timeout = 30000 } = {}) {
  return async (method, params = []) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error(`${method}: RPC HTTP ${response.status}`);
    const result = await response.json();
    if (result.error) throw new Error(`${method}: ${JSON.stringify(result.error)}`);
    return result.result;
  };
}

module.exports = { jsonRpc };
