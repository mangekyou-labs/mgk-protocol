'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

/** Exercise the real read-only service against the candidate program's history. */
async function verifyIndexerReplay(runtime, { programs, accounts, expectedFills, startSlot = Math.min(...runtime.report.transactions.map(tx => tx.slot)) }) {
  const directory = mkdtempSync(join(tmpdir(), 'mgk-indexer-replay-'));
  const manifestPath = join(directory, 'deployment.json');
  const monitoringPath = join(directory, 'monitoring.json');
  writeFileSync(monitoringPath, JSON.stringify({
    feePayers: { keeper: String(accounts.maker), oracle: String(accounts.maker), maker: String(accounts.maker) },
    feeFloorLamports: '10000000', insuranceFloorLamports: '1000000000',
  }));
  writeFileSync(manifestPath, JSON.stringify({
    schema_version: 1, name: 'candidate-indexer-replay', cluster: 'localnet', programs,
    accounts: Object.fromEntries(Object.entries(accounts).map(([name, address]) =>
      [name, { status: 'deployed', address: String(address) }])),
    start_slot: { status: 'set', slot: startSlot },
  }));
  const port = Number(process.env.MGK_INDEXER_RUNTIME_PORT ?? 19430);
  const dbPath = join(directory, 'history.db');
  let child;
  let output = '';
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    let timer;
    try {await Promise.race([closed, new Promise(resolve => {timer = setTimeout(resolve, 5000);})]);}
    finally {clearTimeout(timer);}
    if (child.exitCode === null && !child.signalCode) {child.kill('SIGKILL'); await closed;}
  };
  const launch = async () => {
    output = '';
    child = await runtime.launchWorker(process.execPath,
      [resolve(__dirname, '../../mgk-frontend/apps/indexer/dist/main.js')], {
        env: { DEPLOYMENT_MANIFEST: manifestPath, MONITORING_CONFIG: monitoringPath,
          DB_PATH: dbPath, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn' },
      });
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-8000); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-8000); });
  };
  const get = async path => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1500) });
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
    return response.json();
  };
  const waitForReplay = async () => {
    const deadline = Date.now() + 90000;
    let error;
    while (Date.now() < deadline) {
      assert.ok(child.exitCode === null && !child.signalCode, `indexer exited: ${output}`);
      try {
        const health = await get('/api/healthz');
        error = JSON.stringify(health);
        const tip = await runtime.rpc('getSlot', [{ commitment: 'confirmed' }]);
        if (health.processedThroughSlot !== null && health.processedThroughSlot >= tip) {
          const status = await get('/api/status');
          assert.equal(status.lastIndexedSlot, health.processedThroughSlot);
          assert.ok(status.chainTip >= status.lastIndexedSlot, 'status reports chain tip against indexed slot');
          assert.equal(status.checks.rpc.severity, 'ok', 'status independently reaches candidate RPC');
          return get(`/api/users/${accounts.maker}/fills?limit=500`);
        }
      } catch (caught) { error = caught; }
      await sleep(100);
    }
    assert.fail(`indexer replay timed out: ${error}\n${output}`);
  };
  try {
    await launch();
    const first = await waitForReplay();
    assert.ok(first.fills.length > 0, 'cold replay recovers candidate settlement history');
    const canonical = fills => fills.map(fill => JSON.stringify(fill)).sort();
    const expected = expectedFills
      .filter(fill => fill.quantity_lots !== undefined && fill.account === String(accounts.maker) && BigInt(fill.quantity_lots) !== 0n)
      .map(fill => ({ price: String(fill.fill_price),
        qty: String(BigInt(fill.quantity_lots) < 0n ? -BigInt(fill.quantity_lots) : BigInt(fill.quantity_lots)),
        role: fill.maker ? 'maker' : 'taker' }));
    const actual = first.fills.map(fill => ({ price: String(fill.price), qty: String(fill.qty), role: fill.role }));
    assert.deepEqual(canonical(actual), canonical(expected),
      'history equals independently capped expected executions, including reduce-only clipping');
    await stop();
    await launch();
    const restarted = await waitForReplay();
    assert.deepEqual(restarted, first, 'persistent-disk restart cannot duplicate fills');
    await stop();
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
    await launch();
    const replayed = await waitForReplay();
    assert.deepEqual(replayed, first, 'empty-disk replay reconstructs the same complete history');
    runtime.report.indexerReplay = { fills: first.fills.length, persistentRestart: true, emptyDiskReplay: true };
    runtime.flushReport();
  } finally {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { verifyIndexerReplay };
