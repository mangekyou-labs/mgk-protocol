'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { jsonRpc, createRequestBudget, budgetedFetch, isBudgetError, assertUnkeyedRpc, redactRpcUrl } = require('./rpc');

const ok = result => ({ ok: true, status: 200, json: async () => ({ result }) });
const http = status => ({ ok: false, status, json: async () => ({}) });

function scripted(responses) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body).method);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { sent, fetchImpl };
}

test('the budget charges every request and refuses past the cap without sending', async () => {
  const budget = createRequestBudget({ max: 2 });
  const { sent, fetchImpl } = scripted([ok(1), ok(2), ok(3)]);
  const rpc = jsonRpc('http://rpc.invalid', { budget, fetchImpl });
  assert.equal(await rpc('getSlot'), 1);
  assert.equal(await rpc('getSlot'), 2);
  await assert.rejects(rpc('getSlot'), error => isBudgetError(error) && /2 requests/.test(error.message));
  assert.equal(sent.length, 2);
  assert.equal(budget.used, 2);
  assert.equal(budget.exhausted, true);
});

test('429, 5xx and transport errors retry with backoff; each attempt is charged', async () => {
  const budget = createRequestBudget({ max: 10 });
  const waits = [];
  const { sent, fetchImpl } = scripted([http(429), new TypeError('fetch failed'), http(503), ok('done')]);
  const rpc = jsonRpc('http://rpc.invalid', { budget, fetchImpl, retries: 3, retryDelayMs: 100,
    sleep: async ms => { waits.push(ms); } });
  assert.equal(await rpc('getSlot'), 'done');
  assert.equal(sent.length, 4);
  assert.equal(budget.used, 4);
  assert.deepEqual(waits, [100, 200, 400]);
});

test('a sustained outage fails once retries run out; RPC errors never retry', async () => {
  const outage = scripted([http(429), http(429), http(429)]);
  const rpc = jsonRpc('http://rpc.invalid', { fetchImpl: outage.fetchImpl, retries: 2, sleep: async () => {} });
  await assert.rejects(rpc('getSlot'), /getSlot: RPC HTTP 429/);
  assert.equal(outage.sent.length, 3);

  const rpcError = scripted([{ ok: true, json: async () => ({ error: { code: -32602 } }) }]);
  const strict = jsonRpc('http://rpc.invalid', { fetchImpl: rpcError.fetchImpl, retries: 5, sleep: async () => {} });
  await assert.rejects(strict('getSlot'), /-32602/);
  assert.equal(rpcError.sent.length, 1);
});

test('budgetedFetch charges the shared budget for web3.js Connection requests', async () => {
  const budget = createRequestBudget({ max: 1 });
  const fetch = budgetedFetch(budget, async () => 'response');
  assert.equal(await fetch('http://rpc.invalid'), 'response');
  assert.throws(() => fetch('http://rpc.invalid'), isBudgetError);
});

test('keyed RPC URLs are refused unless allowed, and redacted in logs', () => {
  assert.doesNotThrow(() => assertUnkeyedRpc('https://api.devnet.solana.com'));
  assert.throws(() => assertUnkeyedRpc('https://devnet.helius-rpc.com/?api-key=abc123'), /keyed RPC/);
  assert.doesNotThrow(() => assertUnkeyedRpc('https://devnet.helius-rpc.com/?api-key=abc123', { allowKeyed: true }));
  assert.equal(redactRpcUrl('https://x.test/?api-key=abc123&y=1'), 'https://x.test/?api-key=REDACTED&y=1');
  assert.throws(() => createRequestBudget({ max: 0 }), /positive integer/);
});
