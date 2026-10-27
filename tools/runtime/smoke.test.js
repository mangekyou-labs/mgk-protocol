'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');
const { LocalRuntime } = require('./harness');
const { Keypair, PublicKey, TransactionInstruction, Transaction, ComputeBudgetProgram, SystemProgram } = require('@solana/web3.js');
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
test('candidate runtime: exact position settlement and invalid-oracle rollback', { timeout: 180000 }, async t => {
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
  let [batch, batchBump] = pda([Buffer.from('batch'), u64(0)]);
  let [nextBatch] = pda([Buffer.from('batch'), u64(1)]);
  const [book] = pda([Buffer.from('book'), Buffer.alloc(2)], MATCHER);
  let [results] = pda([Buffer.from('results'), u64(0)], MATCHER);
  const oracle = Keypair.generate().publicKey;
  const portfolios = [maker, taker].map(user => pda([Buffer.from('portfolio'), user.publicKey.toBuffer()]));
  // Genesis scaffolding supplies zeroed storage for the signed initialization lifecycle.
  // All initialized fields, deposits, orders, clearing and settlement are written by signed program transactions.
  for (const [address, owner, size] of [[registry, CORE, 94], [instrument, CORE, 352], [vault, CORE, 80],
    [batch, CORE, 176], [nextBatch, CORE, 176], [book, MATCHER, 27712], [results, MATCHER, 8 + 34 + 128 * 58],
    ...portfolios.map(([address]) => [address, CORE, 2048])]) {
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
  u64(10).copy(init, 56); u64(25).copy(init, 64); u64(25).copy(init, 72);
  u64(1).copy(init, 82); u64(1).copy(init, 90);
  init.writeUInt16LE(1000, 98); init.writeUInt16LE(500, 100); init.writeUInt16LE(5, 102);
  oracle.toBuffer().copy(init, 106); init[138] = regBump; init[139] = instBump;
  await runtime.send('initialize', [ix(0, init, [meta(registry), meta(payer.publicKey, true, true), meta(instrument),
    meta(SystemProgram.programId, false), meta(vault)])], [payer]);
  await runtime.assertState([{ address: registry, fields: [field('10-second batch maximum', 72, 8, 25)] }]);
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
  // A cash-backed genesis fund isolates accounting from the separate #23 top-up/exhaustion work.
  const initialFund = 20_000_000_000n;
  const seededVault = Buffer.from(vaultBefore.data);
  seededVault.writeBigUInt64LE(initialFund, 16);
  seededVault.writeBigUInt64LE(2_000_000_000n + initialFund, 8);
  await runtime.setAccount(vault, { owner: CORE, data: seededVault,
    lamports: Number(vaultBefore.lamports + initialFund) });
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
  // All expectations come from the independent Fraction ledger, fed only observed fills.
  const observedFills = [];
  const recordFills = (data, conversionPrice) => {
    const count = data.readUInt16LE(40);
    const fills = Array.from({ length: count }, (_, index) => {
      const offset = 8 + 34 + index * 58;
      const makerFill = Boolean(data[offset + 56]);
      const bidAuction = data[offset + 57] === 0;
      const quantity = data.readBigUInt64LE(offset + 40);
      return { account: new PublicKey(data.subarray(offset, offset + 32)).toBase58(),
        quantity_lots: String(bidAuction === makerFill ? quantity : -quantity),
        fill_price: String(data.readBigInt64LE(offset + 48)), conversion_price: String(conversionPrice), maker: makerFill };
    });
    for (const fill of fills) assert.ok([String(maker.publicKey), String(taker.publicKey)].includes(fill.account),
      'observed fill belongs to a participating portfolio owner');
    observedFills.push(...fills);
    return fills;
  };
  const reference = () => JSON.parse(execFileSync('python3', ['-B', '-c', `
import json, sys
from fractions import Fraction
sys.path.insert(0, sys.argv[1])
from reference_model import Ledger, Fill
request = json.load(sys.stdin)
ledger = Ledger(int(request['fund']), {account: int(value) for account, value in request['collateral'].items()})
usd_totals = {}
for fill in request['fills']:
    account = fill['account']
    before = ledger.realized_micro_usd.get(account, Fraction(0))
    ledger.apply_fill(Fill(account, int(fill['quantity_lots']), int(fill['fill_price']), int(fill['conversion_price']), fill['maker']))
    delta = ledger.realized_micro_usd.get(account, Fraction(0)) - before
    # The i128 display counter quantizes each event toward the protocol; conversion above stays exact.
    usd_totals[account] = usd_totals.get(account, 0) + delta.numerator // delta.denominator
positions = {account: {'qty': str(p.quantity_lots), 'entry': str(p.entry_price.numerator // p.entry_price.denominator),
    'numerator': str(p.entry_price.numerator), 'denominator': str(p.entry_price.denominator)} for account, p in ledger.positions.items()}
print(json.dumps({'collateral': {a: str(v) for a, v in ledger.collateral.items()}, 'fund': str(ledger.fund_lamports),
    'liability': str(ledger.vault_liability_lamports()), 'positions': positions,
    'realized_usd': {a: str(v) for a, v in usd_totals.items()},
    'realized_lamports': {a: str(v) for a, v in ledger.realized_lamports.items()},
    'fees': {a: str(v) for a, v in ledger.fees_lamports.items()}}))
`, resolve(__dirname, '../gate')], { input: JSON.stringify({ fund: String(initialFund), collateral: {
    [maker.publicKey]: '1000000000', [taker.publicKey]: '1000000000' }, fills: observedFills }), encoding: 'utf8' }));
  recordFills(cleared.data, 1_000_000);
  let model = reference();
  const assertModel = async label => {
    model = reference();
    const expected = portfolios.map(([address], index) => {
      const account = String([maker, taker][index].publicKey), position = model.positions[account];
      return { address, fields: [field('portfolio version', 1, 1, 2),
        field(`${label}: collateral`, 48, 16, model.collateral[account], true),
        field(`${label}: realized USD`, 80, 16, model.realized_usd[account] ?? 0, true),
        field(`${label}: realized lamports`, 96, 16, model.realized_lamports[account] ?? 0, true),
        field(`${label}: fees paid`, 112, 16, model.fees[account] ?? 0, true),
        field(`${label}: funding off`, 128, 16, 0, true),
        field(`${label}: position count`, 208, 2, position ? 1 : 0),
        field(`${label}: quantity`, 224, 8, position?.qty ?? 0, true),
        field(`${label}: entry floor`, 232, 8, position?.entry ?? 0, true)] };
    });
    await runtime.assertState([...expected, { address: vault,
      lamports: String(BigInt(model.liability) + 10_000_000n), fields: [
        field(`${label}: vault balance`, 8, 8, model.liability),
        field(`${label}: fund`, 16, 16, model.fund), field(`${label}: no uncovered debt`, 32, 16, 0)] }]);
    for (let index = 0; index < portfolios.length; index++) {
      const position = model.positions[String([maker, taker][index].publicKey)];
      if (!position) continue;
      const state = (await runtime.account(portfolios[index][0])).data;
      const integer = state.readBigInt64LE(232), remainder = state.readBigUInt64LE(240);
      const denominator = state.readBigUInt64LE(248) || 1n;
      assert.equal((integer * denominator + remainder) * BigInt(position.denominator),
        BigInt(position.numerator) * denominator, `${label}: exact rational entry`);
    }
    runtime.report.settlementScenarios ??= [];
    runtime.report.settlementScenarios.push({ label, model, observedFills: [...observedFills] });
    runtime.report.model = model;
    runtime.flushReport();
  };
  const settle = oracleKey => ix(8, Buffer.from([0, 0, 2, 0]), [meta(batch), meta(registry), meta(vault),
    meta(results, false), meta(instrument), meta(book, false), meta(oracleKey, false), meta(MATCHER, false),
    ...portfolios.map(([portfolio]) => meta(portfolio)), meta(nextBatch)]);
  // An actual signed oracle update must preserve the publisher's confidence.
  const update = Buffer.alloc(16);
  update.writeBigInt64LE(1_000_000n); update.writeBigInt64LE(4321n, 8);
  await runtime.send('oracle publishes real confidence', [ix(1, update,
    [meta(oracle), meta(payer.publicKey, false, true)], ORACLE)], [payer]);
  await runtime.assertState([{ address: oracle, fields: [field('published confidence', 96, 8, 4321, true)] }]);
  await runtime.rpc('surfnet_pauseClock');
  const clock = await runtime.account(new PublicKey('SysvarC1ock11111111111111111111111111111111'));
  const now = Number(clock.data.readBigInt64LE(32));
  const boundaryResults = [];
  const simulate = async oracleKey => {
    const latest = await runtime.connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: payer.publicKey, ...latest }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), settle(oracleKey));
    tx.sign(payer);
    return (await runtime.rpc('simulateTransaction', [tx.serialize().toString('base64'),
      { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }])).value;
  };
  const cases = [
    ['exactly 60 seconds and 1 percent', { publishTime: now - 60, confidence: 10_000 }, null],
    ['61 seconds', { publishTime: now - 61 }, 114],
    ['above 1 percent', { confidence: 10_001 }, 210],
    ['future timestamp', { publishTime: now + 1 }, 114],
    ['inactive', { active: false }, 'invalid'],
    ['foreign instrument', { instrument: Keypair.generate().publicKey }, 'invalid'],
    ['foreign owner', { owner: SystemProgram.programId }, 'invalid'],
    ['zero price', { price: 0, confidence: 0 }, 210],
    ['negative confidence', { confidence: -1 }, 210],
    ['foreign oracle key', {}, 'invalid'],
    ['invalid header', {}, 'invalid'],
  ];
  for (const [label, overrides, expected] of cases) {
    const oracleKey = label === 'foreign oracle key' ? Keypair.generate().publicKey : oracle;
    await runtime.setOracle(oracleKey, { owner: ORACLE, authority: payer.publicKey, instrument,
      price: 1_000_000, publishTime: now, confidence: 12, ...overrides });
    if (label === 'invalid header') {
      const account = await runtime.account(oracleKey);
      account.data[0] = 0;
      await runtime.setAccount(oracleKey, { owner: ORACLE, data: account.data });
    }
    const result = await simulate(oracleKey);
    if (expected === null) assert.equal(result.err, null, `${label}: ${result.logs}`);
    else if (typeof expected === 'number') assert.deepEqual(result.err,
      { InstructionError: [1, { Custom: expected }] }, label);
    else assert.ok(result.err, `${label} must block settlement`);
    boundaryResults.push({ label, error: result.err });
  }
  runtime.report.oracleBoundaries = boundaryResults; runtime.flushReport();
  // Submit an invalid transaction too: validator rollback must preserve all risk state.
  const protectedAccounts = [batch, instrument, vault, nextBatch, ...portfolios.map(([key]) => key)];
  const before = await Promise.all(protectedAccounts.map(key => runtime.account(key)));
  await runtime.setOracle(oracle, { owner: ORACLE, authority: payer.publicKey, instrument,
    price: 1_000_000, publishTime: now - 61, confidence: 12 });
  const latest = await runtime.connection.getLatestBlockhash('confirmed');
  const rejected = new Transaction({ feePayer: payer.publicKey, ...latest }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), settle(oracle));
  rejected.sign(payer);
  const rejectedSignature = await runtime.rpc('sendTransaction', [rejected.serialize().toString('base64'),
    { encoding: 'base64', skipPreflight: true }]);
  await runtime.rpc('surfnet_resumeClock');
  let rejectedStatus;
  const deadline = Date.now() + 15000;
  do {
    rejectedStatus = (await runtime.rpc('getSignatureStatuses', [[rejectedSignature], { searchTransactionHistory: true }])).value[0];
    if (rejectedStatus && ['confirmed', 'finalized'].includes(rejectedStatus.confirmationStatus)) break;
    assert.ok(Date.now() < deadline, 'rejected settlement confirmation timed out');
    await sleep(50);
  } while (true);
  assert.deepEqual(rejectedStatus.err, { InstructionError: [1, { Custom: 114 }] });
  const after = await Promise.all(protectedAccounts.map(key => runtime.account(key)));
  for (let index = 0; index < before.length; index++) {
    assert.deepEqual(after[index].data, before[index].data, `${protectedAccounts[index]} bytes unchanged`);
    assert.equal(after[index].lamports, before[index].lamports, `${protectedAccounts[index]} lamports unchanged`);
  }
  runtime.report.rejectedSettlement = { signature: rejectedSignature, error: rejectedStatus.err };
  runtime.flushReport();
  const freshClock = await runtime.account(new PublicKey('SysvarC1ock11111111111111111111111111111111'));
  await runtime.setOracle(oracle, { owner: ORACLE, authority: payer.publicKey, instrument,
    price: 1_000_000, publishTime: Number(freshClock.data.readBigInt64LE(32)), confidence: 12 });
  await runtime.send('settle', [settle(oracle)], [payer]);
  await assertModel('dual-auction roundtrip and oracle retry');
  await runtime.assertState([
    { address: batch, fields: [field('Settled', 16, 1, 3)] },
    { address: portfolios[0][0], fields: [field('maker equity', 48, 16, model.collateral[maker.publicKey], true)] },
    { address: portfolios[1][0], fields: [field('taker equity', 48, 16, model.collateral[taker.publicKey], true)] },
    { address: vault, lamports: String(BigInt(model.liability) + 10_000_000n), fields: [field('vault balance', 8, 8, model.liability),
      field('insurance fees', 16, 16, model.fund)] },
    { address: nextBatch, fields: [field('batch id', 8, 8, 1), field('Collecting', 16, 1, 0)] },
  ]);
  await assert.rejects(runtime.assertState([{ address: vault, lamports: String(BigInt(model.liability) + 10_000_001n) }]), /lamports/);
  await assert.rejects(runtime.assertState([{ address: portfolios[0][0], fields: [field('wrong expected model equity', 48, 16, 42)] }]), /wrong expected model equity/);
  // Each later batch uses genuine signed post/clear/settle instructions. The oracle
  // conversion deliberately differs from the fill price, exposing spot-cashflow and unit bugs.
  let batchId = 1;
  const settleScenario = async (label, orders, conversionPrice) => {
    batch = nextBatch;
    [nextBatch] = pda([Buffer.from('batch'), u64(batchId + 1)]);
    [results] = pda([Buffer.from('results'), u64(batchId)], MATCHER);
    await runtime.setAccount(nextBatch, { owner: CORE, data: Buffer.alloc(176) });
    await runtime.setAccount(results, { owner: MATCHER, data: Buffer.alloc(8 + 34 + 128 * 58) });
    for (const { side, qty, price } of orders) {
      for (const index of [0, 1]) {
        const user = [maker, taker][index], data = Buffer.alloc(21);
        data[0] = index === 0 ? side : 1 - side; data[1] = Number(index === 0);
        data.writeBigInt64LE(BigInt(price), 2); u64(qty).copy(data, 10);
        await runtime.send(`${label}: post ${index} ${side}`, [ix(20, data,
          [meta(portfolios[index][0]), meta(user.publicKey, true, true), meta(batch),
            meta(registry, false), meta(book), meta(MATCHER, false)])], [payer, user]);
      }
    }
    await runtime.advanceSlots(200);
    await runtime.send(`${label}: close collecting`, [ix(6, Buffer.alloc(0), [meta(batch), meta(registry)])], [payer]);
    await runtime.send(`${label}: clear`, [ix(7, Buffer.from([0, 0, 1, 0, 0, 0]),
      [meta(batch), meta(book), meta(results), meta(MATCHER, false), meta(registry, false), meta(instrument, false)])], [payer]);
    const observed = (await runtime.account(results)).data;
    assert.equal(observed.readUInt16LE(40), orders.length * 2, `${label}: all paired orders filled`);
    recordFills(observed, conversionPrice);
    const fresh = await runtime.account(new PublicKey('SysvarC1ock11111111111111111111111111111111'));
    await runtime.setOracle(oracle, { owner: ORACLE, authority: payer.publicKey, instrument,
      price: conversionPrice, publishTime: Number(fresh.data.readBigInt64LE(32)), confidence: 12 });
    await runtime.send(`${label}: settle`, [settle(oracle)], [payer]);
    await assertModel(label);
    batchId++;
  };
  await settleScenario('open without cash exchange', [{ side: 0, qty: 1000, price: 100_000_000 }], 99_000_000);
  await settleScenario('grow with fractional weighted entry', [{ side: 0, qty: 1001, price: 100_000_001 }], 99_000_000);
  const grownEntry = model.positions[String(maker.publicKey)];
  assert.notEqual(grownEntry.denominator, '1', 'grow fixture produces a fractional entry');
  await settleScenario('partial reduce preserves exact entry', [{ side: 1, qty: 501, price: 101_000_000 }], 99_000_000);
  const reducedEntry = model.positions[String(maker.publicKey)];
  assert.equal(reducedEntry.numerator, grownEntry.numerator, 'partial reduce retains entry numerator');
  assert.equal(reducedEntry.denominator, grownEntry.denominator, 'partial reduce retains entry denominator');
  await settleScenario('flip realizes only the old side', [{ side: 1, qty: 2000, price: 102_000_000 }], 101_000_000);
  assert.equal(model.positions[String(maker.publicKey)].qty, '-500', 'flip leaves only excess quantity');
  assert.equal(model.positions[String(maker.publicKey)].entry, '102000000', 'flip resets entry to its fill');
  await settleScenario('close removes position', [{ side: 0, qty: 500, price: 103_000_000 }], 102_000_000);
  assert.deepEqual(model.positions, {}, 'both positions deleted after close');
  await settleScenario('ordered dual-auction realization', [
    { side: 0, qty: 1000, price: 100_000_000 }, { side: 1, qty: 1000, price: 110_000_000 },
  ], 105_000_000);
  assert.deepEqual(model.positions, {}, 'opposite fills close in cleared-results order');
  const worker = await runtime.launchWorker(process.execPath, ['-e',
    'fetch(process.env.RPC_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getSlot",params:[]})}).then(r=>r.json()).then(r=>{if(!Number.isInteger(r.result))process.exit(1)})']);
  const [exitCode] = await once(worker, 'exit');
  assert.equal(exitCode, 0, 'real worker process can read the validator');
  const heldWorker = await runtime.launchWorker(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await runtime.close();
  assert.ok(heldWorker.signalCode || heldWorker.exitCode !== null, 'cleanup reaps a running worker');
});
