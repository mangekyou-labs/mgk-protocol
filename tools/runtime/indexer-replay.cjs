'use strict';

const assert = require('node:assert/strict');
const { rmSync } = require('node:fs');
const { createIndexerService } = require('./indexer-service.cjs');
const { setTimeout: sleep } = require('node:timers/promises');

/** Exercise the real read-only service against the candidate program's history. */
async function verifyIndexerReplay(runtime, { programs, accounts, expectedFills, startSlot = Math.min(...runtime.report.transactions.map(tx => tx.slot)) }) {
  const port = Number(process.env.MGK_INDEXER_RUNTIME_PORT ?? 19430);
  const service = createIndexerService(runtime, { programs, accounts, startSlot,
    name: 'candidate-indexer-replay', prefix: 'mgk-indexer-replay-', port });
  const {directory, dbPath} = service;
  const get = async path => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1500) });
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
    return response.json();
  };
  const waitForReplay = async () => {
    const deadline = Date.now() + 90000;
    let error;
    while (Date.now() < deadline) {
      assert.ok(service.child.exitCode === null && !service.child.signalCode, `indexer exited: ${service.output}`);
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
    assert.fail(`indexer replay timed out: ${error}\n${service.output}`);
  };
  try {
    await service.launch();
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
    await service.stop();
    await service.launch();
    const restarted = await waitForReplay();
    assert.deepEqual(restarted, first, 'persistent-disk restart cannot duplicate fills');
    await service.stop();
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
    await service.launch();
    const replayed = await waitForReplay();
    assert.deepEqual(replayed, first, 'empty-disk replay reconstructs the same complete history');
    runtime.report.indexerReplay = { fills: first.fills.length, persistentRestart: true, emptyDiskReplay: true };
    runtime.flushReport();
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { verifyIndexerReplay };
