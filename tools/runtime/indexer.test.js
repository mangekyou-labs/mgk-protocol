'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { setTimeout: sleep } = require('node:timers/promises');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { LocalRuntime } = require('./harness');
const { layouts } = require('../../mgk-frontend/packages/layout');
const { Keypair, PublicKey, SystemProgram } = require('@solana/web3.js');
const base = require('../../deployments/devnet.json');
function fixture(name, fields = {}) {
  const data = Buffer.alloc(layouts[name].size);
  data[0] = layouts[name].discriminator; data[1] = layouts[name].version;
  for (const [key, value] of Object.entries(fields)) {
    const [offset, type] = layouts[name].fields[key];
    if (type === 'pubkey') new PublicKey(value).toBuffer().copy(data, offset);
    else if (type === 'bool' || type === 'u8') data[offset] = Number(value);
    else if (type === 'u16') data.writeUInt16LE(Number(value), offset);
    else if (type === 'u32') data.writeUInt32LE(Number(value), offset);
    else if (type === 'i64') data.writeBigInt64LE(BigInt(value), offset);
    else data.writeBigUInt64LE(BigInt(value), offset);
  }
  return data;
}
async function eventually(fn) {
  const deadline = Date.now() + 20000;
  while (true) { try { return await fn(); } catch (e) { if (Date.now() > deadline) throw e; await sleep(100); } }
}
test('read-only service reports chain status on empty disk', { timeout: 120000 }, async t => {
  assert.ok(process.env.MGK_CANDIDATE_MANIFEST, 'MGK_CANDIDATE_MANIFEST required');
  const candidate = JSON.parse(readFileSync(process.env.MGK_CANDIDATE_MANIFEST));
  const runtime = await LocalRuntime.start({ candidates: candidate.programs, port: 19899 });
  const directory = mkdtempSync(join(tmpdir(), 'mgk-indexer-status-'));
  t.after(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  const core = new PublicKey(base.programs.perps_core), matcher = new PublicKey(base.programs.perps_matcher);
  const [registry] = PublicKey.findProgramAddressSync([Buffer.from('registry')], core);
  const instrument = Keypair.generate().publicKey, oracle = Keypair.generate().publicKey, insurance = Keypair.generate().publicKey;
  const maker = Keypair.generate().publicKey, keeper = Keypair.generate().publicKey, publisher = Keypair.generate().publicKey;
  const [batch] = PublicKey.findProgramAddressSync([Buffer.from('batch'), Buffer.alloc(8)], core);
  const [book] = PublicKey.findProgramAddressSync([Buffer.from('book'), Buffer.alloc(2)], matcher);
  const slot = await runtime.rpc('getSlot', [{ commitment: 'confirmed' }]);
  await runtime.setAccount(registry, { owner: core, data: fixture('Registry', {batchIdCounter: 1}) });
  await runtime.setAccount(instrument, { owner: core, data: fixture('Instrument', {instrumentId: 0, oracleAddr: oracle, isActive: true}) });
  await runtime.setAccount(insurance, { owner: core, data: fixture('Vault', {insuranceFund: 10_000_000_000n}) });
  await runtime.setAccount(batch, { owner: core, data: fixture('Batch', {batchId: 0, status: 0, commitDeadlineSlot: slot + 10000}) });
  await runtime.setOracle(oracle, { owner: base.programs.oracle, authority: publisher, instrument, price: 100_000_000, publishTime: Math.floor(Date.now()/1000), confidence: 10000 });
  for (const wallet of [maker, keeper, publisher]) await runtime.setAccount(wallet, {owner: SystemProgram.programId, lamports: 100_000_000});
  const bookData = Buffer.alloc(layouts.OrderBook.size + 256 * layouts.RestingOrder.size);
  fixture('OrderBook', {instrumentId: 0}).copy(bookData);
  for (let i = 0; i < 2; i++) {
    const order = fixture('RestingOrder', {user: maker, qty: 10, price: i ? 101_000_000 : 99_000_000, side: i, isMaker: true});
    order.copy(bookData, layouts.OrderBook.size + i * layouts.RestingOrder.size);
  }
  await runtime.setAccount(book, {owner: matcher, data: bookData});
  const manifest = structuredClone(base); manifest.name = 'status-harness'; manifest.cluster = 'localnet';
  manifest.start_slot = {status: 'set', slot};
  for (const [key, value] of Object.entries({registry, instrument, oracle, insurance, maker})) manifest.accounts[key] = {status: 'deployed', address: String(value)};
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, 'monitoring.json'), JSON.stringify({feePayers: {keeper: String(keeper), oracle: String(publisher), maker: String(maker)}, feeFloorLamports: '10000000', insuranceFloorLamports: '1000000000'}));
  let fault = 'blocks';
  const proxy = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    try {
      if (fault === 'rpc') throw new Error('RPC unavailable');
      if (fault === 'blocks' && request.method === 'getBlocks') throw new Error('Temporary history outage');
      const result = await runtime.rpc(request.method, request.params);
      res.end(JSON.stringify({jsonrpc:'2.0', id: request.id, result}));
    } catch (error) {res.end(JSON.stringify({jsonrpc:'2.0', id:request.id, error:{code:-32000, message:error.message}}));}
  });
  proxy.listen(19897, '127.0.0.1'); await once(proxy, 'listening');
  t.after(() => proxy.close());
  const child = spawn(process.execPath, ['mgk-frontend/apps/indexer/dist/main.js'], {cwd: resolve('.'), env: {...process.env, RPC_URL: 'http://127.0.0.1:19897',
    DEPLOYMENT_MANIFEST: join(directory, 'manifest.json'), MONITORING_CONFIG: join(directory, 'monitoring.json'), DB_PATH: join(directory, 'indexer.db'), PORT: '19400', LOG_LEVEL: 'error',
  }, stdio: ['ignore','pipe','pipe']});
  runtime.workers.add(child);
  let logs = ''; child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
  const status = await eventually(async () => {
    assert.equal(child.exitCode, null, logs);
    const response = await fetch('http://127.0.0.1:19400/api/status'); assert.equal(response.status, 200);
    return response.json();
  });
  assert.equal(status.checks.oracle.severity, 'ok');
  assert.equal(status.lastIndexedSlot, null, 'RPC history failure cannot advance watermark');
  assert.equal(status.checks.makerDepth.severity, 'ok');
  assert.equal(status.checks.fees.severity, 'ok');
  assert.equal(status.checks.insurance.severity, 'ok');
  assert.equal(status.checks.pause.severity, 'ok');
  assert.ok(status.chainTip >= slot);
  const read = async () => (await fetch('http://127.0.0.1:19400/api/status')).json();
  await runtime.advanceSlots(151);
  let observed = await read();
  assert.equal(observed.checks.indexer.severity, 'warn');
  assert.ok(observed.checks.indexer.lagSlots > 150);
  assert.equal(observed.lastIndexedSlot, null);
  fault = '';
  await eventually(async () => {const s = await read(); assert.ok(s.lastIndexedSlot >= slot + 151);});
  for (const [age, severity] of [[30,'ok'], [31,'warn'], [60,'warn'], [61,'critical']]) {
    // Retry at the second boundary to avoid a clock tick invalidating the fixture.
    await eventually(async () => {
      const timestamp = Math.floor(Date.now()/1000);
      await runtime.setOracle(oracle, {owner: base.programs.oracle, authority: publisher, instrument,
        price: 100_000_000, publishTime: timestamp - age, confidence: 10000});
      const s = await read();
      if (Math.floor(Date.now()/1000) !== timestamp) throw new Error('Clock tick; refresh fixture');
      assert.equal(s.checks.oracle.ageSeconds, age);
      assert.equal(s.checks.oracle.severity, severity);
    });
  }
  await runtime.setAccount(keeper, {owner: SystemProgram.programId, lamports: 9_999_999});
  await runtime.setAccount(insurance, {owner:core, data:fixture('Vault', {insuranceFund:999_999_999})});
  await runtime.setAccount(registry, {owner:core, data:fixture('Registry', {batchIdCounter:1, pauseFlags:3})});
  observed = await read();
  assert.equal(observed.checks.fees.severity, 'critical');
  assert.equal(observed.checks.insurance.severity, 'warn');
  assert.equal(observed.checks.pause.flags, 3);
  assert.equal(observed.checks.pause.severity, 'critical');
  // Taker orders and fully filled makers cannot satisfy executable maker depth.
  bookData[layouts.OrderBook.size + layouts.RestingOrder.fields.isMaker[0]] = 0;
  await runtime.setAccount(book, {owner:matcher, data:bookData});
  observed = await read();
  assert.equal(observed.checks.makerDepth.severity, 'critical');
  assert.equal(observed.checks.makerDepth.bid, false);
  await runtime.setAccount(batch, {owner:core, data:fixture('Batch', {batchId:0, status:4})});
  observed = await read();
  assert.equal(observed.checks.batch.severity, 'critical', 'missing clear history fails closed');
  await runtime.setAccount(batch, {owner:SystemProgram.programId, data:Buffer.alloc(0)});
  observed = await read();
  assert.equal(observed.checks.batch.severity, 'critical', 'never falls back to an older batch');
  const watermark = observed.lastIndexedSlot;
  fault = 'rpc';
  observed = await read();
  assert.equal(observed.checks.rpc.reachable, false);
  assert.equal(observed.checks.rpc.severity, 'critical');
  assert.equal(observed.lastIndexedSlot, watermark);

});
