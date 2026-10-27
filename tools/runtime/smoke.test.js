'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');
const { LocalRuntime } = require('./harness');
const { Keypair, PublicKey, TransactionInstruction, SystemProgram } = require('@solana/web3.js');
const deployment = require('../../deployments/devnet.json');
const CORE = new PublicKey(deployment.programs.perps_core);
const MATCHER = new PublicKey(deployment.programs.perps_matcher);
const ORACLE = new PublicKey(deployment.programs.oracle);
const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const pda = (seeds, owner = CORE) => PublicKey.findProgramAddressSync(seeds, owner);
const meta = (pubkey, isWritable = true, isSigner = false) => ({ pubkey, isWritable, isSigner });
const ix = (discriminator, data, keys, programId = CORE) => new TransactionInstruction({ programId, keys,
  data: Buffer.concat([Buffer.from([discriminator]), data]) });
const field = (name, offset, bytes, value, signed = false) => ({ name, offset, bytes, value: String(value), signed });

// Intentionally runs, or fails: absence of candidate artifacts is never a skipped green test.
test('candidate runtime: controllable oracle and signed init/deposit/post/clear/settle', { timeout: 90000 }, async t => {
  assert.ok(process.env.MGK_CANDIDATE_MANIFEST, 'MGK_CANDIDATE_MANIFEST is required; see tools/runtime/README.md');
  const candidate = JSON.parse(readFileSync(process.env.MGK_CANDIDATE_MANIFEST, 'utf8'));
  assert.match(candidate.commit, /^[0-9a-f]{40}$/, 'candidate commit required');
  assert.deepEqual(candidate.programs.map(p => p.programId).sort(), [CORE, MATCHER, ORACLE].map(String).sort());
  const runtime = await LocalRuntime.start({ candidates: candidate.programs,
    port: Number(process.env.MGK_RUNTIME_PORT ?? 18999), reportPath: process.env.MGK_RUNTIME_REPORT });
  t.after(() => runtime.close());
  runtime.report.candidateCommit = candidate.commit; runtime.flushReport();
  const payer = Keypair.generate(), maker = Keypair.generate(), taker = Keypair.generate();
  for (const wallet of [payer, maker, taker]) await runtime.setAccount(wallet.publicKey,
    { owner: SystemProgram.programId, lamports: 20_000_000_000 });
  const [registry, regBump] = pda([Buffer.from('registry')]);
  const [instrument, instBump] = pda([Buffer.from('instrument'), Buffer.alloc(2)]);
  const [vault] = pda([Buffer.from('vault')]);
  const [batch, batchBump] = pda([Buffer.from('batch'), u64(0)]);
  const [nextBatch] = pda([Buffer.from('batch'), u64(1)]);
  const [book] = pda([Buffer.from('book'), Buffer.alloc(2)], MATCHER);
  const [results] = pda([Buffer.from('results'), u64(0)], MATCHER);
  const oracle = Keypair.generate().publicKey;
  const portfolios = [maker, taker].map(user => pda([Buffer.from('portfolio'), user.publicKey.toBuffer()]));
  // Genesis scaffolding supplies zeroed storage as the legacy lifecycle test does.
  // All initialized fields, deposits, orders, clearing and settlement are written by signed program transactions.
  for (const [address, owner, size] of [[registry, CORE, 94], [instrument, CORE, 352], [vault, CORE, 80],
    [batch, CORE, 176], [nextBatch, CORE, 176], [book, MATCHER, 27712], [results, MATCHER, 8 + 34 + 128 * 58],
    ...portfolios.map(([address]) => [address, CORE, 1488])]) {
    const data = Buffer.alloc(size);
    // The matcher normally stamps this header in InitializeBook. Other accounts
    // are stamped by their signed initialize instructions below.
    if (address.equals(book)) { data[0] = 7; data[1] = 1; }
    await runtime.setAccount(address, { owner, data });
  }
  await runtime.setOracle(oracle, { owner: ORACLE, authority: payer.publicKey, instrument,
    price: 100_000_000, publishTime: 123, confidence: 456 });
  await runtime.assertState([{ address: oracle, owner: ORACLE, fields: [field('price', 80, 8, 100_000_000, true),
    field('publish time', 88, 8, 123, true), field('confidence', 96, 8, 456, true)] }]);
  await runtime.setOracle(oracle, { owner: ORACLE, authority: payer.publicKey, instrument,
    price: 110_000_000, publishTime: 789, confidence: 12 });
  await runtime.assertState([{ address: oracle, fields: [field('price', 80, 8, 110_000_000, true),
    field('publish time', 88, 8, 789, true), field('confidence', 96, 8, 12, true)] }]);
  // Also execute the candidate oracle .so, rather than only storing its bytes.
  await runtime.send('oracle activate', [ix(3, Buffer.alloc(0), [meta(oracle), meta(payer.publicKey, false, true)], ORACLE)], [payer]);
  const init = Buffer.alloc(140);
  payer.publicKey.toBuffer().copy(init);
  init.writeUInt16LE(1, 32); init.writeUInt16LE(10000, 34);
  u64(1_000_000).copy(init, 44); init.writeUInt32LE(1, 52);
  u64(10).copy(init, 56); u64(150).copy(init, 64); u64(25).copy(init, 72);
  u64(1).copy(init, 82); u64(1).copy(init, 90);
  init.writeUInt16LE(1000, 98); init.writeUInt16LE(500, 100); init.writeUInt16LE(5, 102);
  oracle.toBuffer().copy(init, 106); init[138] = regBump; init[139] = instBump;
  await runtime.send('initialize', [ix(0, init, [meta(registry), meta(payer.publicKey, true, true), meta(instrument),
    meta(SystemProgram.programId, false), meta(vault)])], [payer]);
  await runtime.send('create batch', [ix(16, Buffer.from([batchBump]), [meta(batch), meta(registry)])], [payer]);
  for (let index = 0; index < 2; index++) {
    const user = [maker, taker][index], [portfolio, bump] = portfolios[index];
    await runtime.send(`init portfolio ${index}`, [ix(1, Buffer.concat([user.publicKey.toBuffer(), Buffer.from([bump])]),
      [meta(portfolio), meta(user.publicKey, true, true)])], [payer, user]);
    await runtime.send(`deposit ${index}`, [ix(2, u64(1_000_000_000), [meta(portfolio), meta(user.publicKey, true, true),
      meta(SystemProgram.programId, false), meta(vault)])], [payer, user]);
    await runtime.assertState([{ address: portfolio, fields: [field('collateral', 48, 16, 1_000_000_000, true),
      field('principal', 64, 16, 1_000_000_000, true)] }]);
  }
  const vaultBefore = await runtime.account(vault);
  assert.equal(vaultBefore.lamports, 2_010_000_000n, 'deposited lamports plus genesis rent');
  for (const [index, side, isMaker] of [[0, 0, true], [0, 1, true], [1, 1, false], [1, 0, false]]) {
    const user = [maker, taker][index], data = Buffer.alloc(21);
    data[0] = side; data[1] = Number(isMaker); data.writeBigInt64LE(1_000_000n, 2); u64(1).copy(data, 10);
    await runtime.send(`post ${index} ${side}`, [ix(20, data, [meta(portfolios[index][0]), meta(user.publicKey, true, true),
      meta(batch), meta(registry, false), meta(book), meta(MATCHER, false)])], [payer, user]);
  }
  await runtime.advanceSlots(200);
  await runtime.send('close collecting', [ix(6, Buffer.alloc(0), [meta(batch), meta(registry)])], [payer]);
  await runtime.send('clear', [ix(7, Buffer.from([0, 0, 1, 0, 0, 0]), [meta(batch), meta(book), meta(results),
    meta(MATCHER, false), meta(registry, false), meta(instrument, false)])], [payer]);
  const cleared = await runtime.account(results);
  assert.equal(cleared.data.readUInt16LE(40), 4, 'both DFBA sides produced maker and taker fills');
  // Feed observed matcher fills into the independent issue-14 model. The two
  // flat legs at a $1 conversion price also match the current legacy fee units.
  const fills = Array.from({ length: 4 }, (_, index) => {
    const offset = 8 + 34 + index * 58;
    const makerFill = Boolean(cleared.data[offset + 56]);
    const bidAuction = cleared.data[offset + 57] === 0;
    const quantity = cleared.data.readBigUInt64LE(offset + 40);
    return { account: new PublicKey(cleared.data.subarray(offset, offset + 32)).toBase58(),
      quantity_lots: String(bidAuction === makerFill ? quantity : -quantity),
      fill_price: String(cleared.data.readBigInt64LE(offset + 48)), conversion_price: '1000000', maker: makerFill };
  });
  const model = JSON.parse(execFileSync('python3', ['-B', '-c', `
import json, sys
sys.path.insert(0, sys.argv[1])
from reference_model import Ledger, Fill
request = json.load(sys.stdin)
ledger = Ledger(0, {account: int(value) for account, value in request['collateral'].items()})
for fill in request['fills']:
    ledger.apply_fill(Fill(fill['account'], int(fill['quantity_lots']), int(fill['fill_price']), int(fill['conversion_price']), fill['maker']))
assert not ledger.positions
print(json.dumps({'collateral': {a: str(v) for a, v in ledger.collateral.items()}, 'fund': str(ledger.fund_lamports), 'liability': str(ledger.vault_liability_lamports())}))
`, resolve(__dirname, '../gate')], { input: JSON.stringify({ collateral: {
    [maker.publicKey]: '1000000000', [taker.publicKey]: '1000000000' }, fills }), encoding: 'utf8' }));
  runtime.report.model = model; runtime.flushReport();
  await runtime.setOracle(oracle, { owner: ORACLE, authority: payer.publicKey, instrument,
    price: 1_000_000, publishTime: 789, confidence: 12 });
  await runtime.send('settle', [ix(8, Buffer.from([0, 0, 2, 0]), [meta(batch), meta(registry), meta(vault),
    meta(results, false), meta(instrument), meta(book, false), meta(oracle, false), meta(MATCHER, false),
    ...portfolios.map(([portfolio]) => meta(portfolio)), meta(nextBatch)])], [payer]);
  // Baseline smoke: dual legs cancel notional, maker fees 0, taker fees 2 x 500.
  // This does not claim that master's settlement implements the future restricted-demo accounting.
  await runtime.assertState([
    { address: batch, fields: [field('Settled', 16, 1, 3)] },
    { address: portfolios[0][0], fields: [field('maker equity', 48, 16, model.collateral[maker.publicKey], true)] },
    { address: portfolios[1][0], fields: [field('taker equity', 48, 16, model.collateral[taker.publicKey], true)] },
    { address: vault, lamports: String(BigInt(model.liability) + 10_000_000n), fields: [field('vault balance', 8, 8, model.liability),
      field('insurance fees', 16, 16, model.fund)] },
    { address: nextBatch, fields: [field('batch id', 8, 8, 1), field('Collecting', 16, 1, 0)] },
  ]);
  await assert.rejects(runtime.assertState([{ address: vault, lamports: '2010000001' }]), /lamports/);
  await assert.rejects(runtime.assertState([{ address: portfolios[0][0], fields: [field('wrong expected model equity', 48, 16, 42)] }]), /wrong expected model equity/);
  const worker = await runtime.launchWorker(process.execPath, ['-e',
    'fetch(process.env.RPC_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getSlot",params:[]})}).then(r=>r.json()).then(r=>{if(!Number.isInteger(r.result))process.exit(1)})']);
  const [exitCode] = await once(worker, 'exit');
  assert.equal(exitCode, 0, 'real worker process can read the validator');
  const heldWorker = await runtime.launchWorker(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await runtime.close();
  assert.ok(heldWorker.signalCode || heldWorker.exitCode !== null, 'cleanup reaps a running worker');
});
