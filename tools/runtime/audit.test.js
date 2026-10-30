'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { execFile } = require('node:child_process');
const { once } = require('node:events');
const { join } = require('node:path');
const { market } = require('./invariant-fixtures');

// A local JSON-RPC endpoint backed by fixture accounts; never devnet.
async function serve(chain) {
  const methods = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const { id, method, params } = JSON.parse(body);
    methods.push(method);
    let reply;
    try { reply = { jsonrpc: '2.0', id, result: await chain.rpc(method, params) }; }
    catch (error) { reply = { jsonrpc: '2.0', id, error: { code: -32601, message: error.message } }; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(reply));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, methods, close: () => server.close() };
}

function runAudit(url) {
  return new Promise(resolve => execFile(process.execPath, [join(__dirname, 'audit.js'), '--rpc', url],
    { env: { ...process.env, RPC_URL: '' } }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
}

test('the audit CLI reports every invariant passing using only read RPC methods', async () => {
  const m = market(); const rpc = await serve(m.chain);
  try {
    const { code, stdout } = await runAudit(rpc.url);
    assert.equal(code, 0);
    const report = JSON.parse(stdout);
    assert.equal(report.rpcUrl, rpc.url);
    assert.deepEqual(report.violations, []);
    assert.equal(report.accounts.portfolios, 2);
    assert.equal(report.invariants.length, 6);
    assert.ok(rpc.methods.length > 0);
    assert.ok(rpc.methods.every(method => /^get/.test(method)), rpc.methods.join());
  } finally { rpc.close(); }
});

test('the audit CLI exits nonzero and names the failing invariant', async () => {
  const m = market(); m.store({ vaultLamports: -1 });
  const rpc = await serve(m.chain);
  try {
    const { code, stdout } = await runAudit(rpc.url);
    assert.equal(code, 1);
    const report = JSON.parse(stdout);
    assert.equal(report.invariants.find(i => i.name === 'vault balance').status, 'fail');
    assert.ok(report.violations.some(v => v.invariant === 'vault balance'));
  } finally { rpc.close(); }
});

test('the audit CLI reports unreachable RPC without a stack trace', async () => {
  const { code, stderr } = await runAudit('http://127.0.0.1:9');
  assert.equal(code, 2);
  assert.match(stderr, /^audit failed: /);
});

test('scenario drivers can import the audit and fail a scenario by name', async () => {
  const { auditScenario } = require('./audit');
  const ok = market();
  const report = await auditScenario('fixture scenario', { rpc: (method, params) => ok.chain.rpc(method, params), programs: ok.programs });
  assert.deepEqual(report.violations, []);
  const bad = market(); bad.store({ vaultLamports: -1 });
  await assert.rejects(auditScenario('fixture scenario', { rpc: (method, params) => bad.chain.rpc(method, params), programs: bad.programs }),
    error => error.name === 'InvariantViolation' && /invariant "vault balance" violated after scenario "fixture scenario"/.test(error.message));
});

test('the audit CLI accepts a candidate manifest as the program source', async () => {
  const { programsFrom } = require('./invariants');
  const { CORE, MATCHER } = require('./invariant-fixtures');
  assert.deepEqual(programsFrom({ programs: [{ name: 'mgk_oracle', programId: 'x' },
    { name: 'mgk_perps_core', programId: CORE }, { name: 'mgk_perps_matcher', programId: MATCHER }] }), { core: CORE, matcher: MATCHER });
  assert.deepEqual(programsFrom({ programs: { perps_core: CORE, perps_matcher: MATCHER } }), { core: CORE, matcher: MATCHER });
  assert.throws(() => programsFrom({ programs: [] }), /perps core/);
});
