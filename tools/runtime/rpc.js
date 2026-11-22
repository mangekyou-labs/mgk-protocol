'use strict';
// Minimal JSON-RPC over HTTP, shared by the local runtime harness and the audit CLI.
// Transport failures keep fetch's error (and its `cause`); HTTP and RPC errors name the method.
//
// Long gate runs (soak, latency) pass a `budget` so the run counts every
// request it makes and stops itself at a hard cap instead of draining an
// RPC plan, and `retries` so a transient public-RPC 429/5xx does not fail a
// whole poll. A request that would exceed the cap throws RequestBudgetExceeded
// before anything is sent.

class RequestBudgetExceeded extends Error {
  constructor(max) {
    super(`RPC request budget exhausted (${max} requests); run stopped`);
    this.name = 'RequestBudgetExceeded';
    this.code = 'RPC_BUDGET_EXHAUSTED';
  }
}

// A shared request counter with a hard cap. `take()` charges one request.
function createRequestBudget({ max }) {
  if (!Number.isInteger(max) || max <= 0) throw new Error('request budget max must be a positive integer');
  const budget = {
    max,
    used: 0,
    take() {
      if (budget.used >= budget.max) throw new RequestBudgetExceeded(budget.max);
      budget.used++;
    },
    // Raises the cap by `extra`; for bounded cleanup after a spent run.
    extend(extra) { budget.max += extra; },
    get exhausted() { return budget.used >= budget.max; },
  };
  return budget;
}

const isBudgetError = error => error?.code === 'RPC_BUDGET_EXHAUSTED';

// A fetch that charges the budget before every request: give it to a
// web3.js Connection (`new Connection(url, { fetch })`) so the driver's
// requests count against the same cap as the observer's.
function budgetedFetch(budget, fetchImpl = globalThis.fetch) {
  return (...args) => {
    budget.take();
    return fetchImpl(...args);
  };
}

const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);

function jsonRpc(url, {
  timeout = 30000,
  budget = null,
  retries = 0,
  retryDelayMs = 1000,
  fetchImpl = globalThis.fetch,
  sleep = ms => new Promise(done => setTimeout(done, ms)),
} = {}) {
  const once = async (method, params) => {
    if (budget) budget.take();
    let response;
    try {
      response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeout) });
    } catch (error) {
      error.retryable = true;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`${method}: RPC HTTP ${response.status}`);
      error.retryable = RETRYABLE_HTTP.has(response.status);
      throw error;
    }
    const result = await response.json();
    if (result.error) throw new Error(`${method}: ${JSON.stringify(result.error)}`);
    return result.result;
  };
  return async (method, params = []) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(method, params);
      } catch (error) {
        // Transport errors and 429/5xx are transient; RPC errors and a
        // spent budget are not.
        if (!error.retryable || attempt >= retries) throw error;
        await sleep(retryDelayMs * 2 ** attempt);
      }
    }
  };
}

// Gate runs default to the public RPC; a keyed URL (Helius and the like)
// is refused unless explicitly allowed, so a long run never spends a paid
// key that live services share.
function assertUnkeyedRpc(url, { allowKeyed = false } = {}) {
  if (allowKeyed) return;
  if (/api[-_]?key=|\/v2\/[A-Za-z0-9_-]{16,}/i.test(String(url))) {
    throw new Error('refusing a keyed RPC URL for a gate run (pass --allow-keyed-rpc to override)');
  }
}

// Redacts any api key in a URL for logs and evidence.
const redactRpcUrl = url => String(url).replace(/(api[-_]?key=)[^&]+/gi, '$1REDACTED');

module.exports = { jsonRpc, createRequestBudget, budgetedFetch, RequestBudgetExceeded, isBudgetError,
  assertUnkeyedRpc, redactRpcUrl };
