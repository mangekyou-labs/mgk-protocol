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
test('candidate runtime: fixed-precision position settlement and invalid-oracle rollback', { timeout: 180000 }, async t => {
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
  const rejectUnchanged = async (label, instructions, signers, addresses) => {
    const snapshot = async address => (await runtime.rpc('getAccountInfo', [String(address),
      { encoding: 'base64', commitment: 'confirmed' }])).value;
    const before = await Promise.all(addresses.map(snapshot));
    const latest = await runtime.connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: signers[0].publicKey, ...latest }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      // Distinct signed bytes avoid reusing an earlier successful transaction's signature.
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(runtime.report.integrityRejections?.length ?? 0) + 1n }),
      ...instructions);
    tx.sign(...signers);
    const wire = tx.serialize().toString('base64');
    const simulation = (await runtime.rpc('simulateTransaction', [wire,
      { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }])).value;
    assert.ok(simulation.err, `${label}: simulation must reject`);
    const signature = await runtime.rpc('sendTransaction', [wire, { encoding: 'base64', skipPreflight: true }]);
    const deadline = Date.now() + 15000;
    let status;
    do {
      status = (await runtime.rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])).value[0];
      if (status && ['confirmed', 'finalized'].includes(status.confirmationStatus)) break;
      assert.ok(Date.now() < deadline, `${label}: rejected transaction confirmation timed out`);
      await sleep(50);
    } while (true);
    assert.ok(status.err, `${label}: submitted transaction must reject`);
    const after = await Promise.all(addresses.map(snapshot));
    after.forEach((account, index) => assert.deepEqual(account, before[index],
      `${label}: ${addresses[index]} account unchanged`));
    runtime.report.integrityRejections ??= [];
    runtime.report.integrityRejections.push({ label, signature, error: status.err });
    runtime.flushReport();
  };
  const portfolios = [maker, taker].map(user => pda([Buffer.from('portfolio'), user.publicKey.toBuffer()]));
  // Genesis scaffolding supplies zeroed storage for the signed initialization lifecycle.
  // All initialized fields, deposits, orders, clearing and settlement are written by signed program transactions.
  for (const [address, owner, size] of [[registry, CORE, 94], [instrument, CORE, 352], [vault, CORE, 80],
    [batch, CORE, 176], [nextBatch, CORE, 176], [book, MATCHER, 27712],
    ...portfolios.map(([address]) => [address, CORE, 2048])]) {
    const data = Buffer.alloc(size);
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
  await runtime.send('initialize matcher book via core', [ix(25, Buffer.alloc(2),
    [meta(registry, false), meta(book), meta(payer.publicKey, true, true),
      meta(SystemProgram.programId, false), meta(MATCHER, false)])], [payer]);
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
  const forgedBook = Keypair.generate().publicKey;
  const genuineBook = await runtime.account(book);
  await runtime.setAccount(forgedBook, { owner: MATCHER, data: genuineBook.data });
  const spoofPostData = Buffer.alloc(21); spoofPostData[1] = 1;
  spoofPostData.writeBigInt64LE(1n, 2); u64(1).copy(spoofPostData, 10);
  for (const [label, bookKey, matcherKey] of [
    ['wrong book PDA', forgedBook, MATCHER], ['wrong matcher program', book, SystemProgram.programId],
  ]) await rejectUnchanged(label, [ix(20, spoofPostData, [meta(portfolios[0][0]),
    meta(maker.publicKey, true, true), meta(batch), meta(registry, false), meta(bookKey), meta(matcherKey, false)])],
    [payer, maker], [book, forgedBook, batch, portfolios[0][0]]);
  // The genuine user's signature cannot replace perps-core's PDA signature.
  for (const discriminator of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
    await rejectUnchanged(`direct matcher instruction ${discriminator}`,
      [ix(discriminator, Buffer.alloc(96), [meta(registry, false), meta(maker.publicKey, false, true),
        meta(book), meta(results)], MATCHER)], [payer, maker], [book, results, registry]);
  }
  // Retained orders count toward the transaction bound, even for one owner.
  const capAddresses = [book, batch, portfolios[0][0]];
  const capSnapshot = await Promise.all(capAddresses.map(address => runtime.account(address)));
  const unmatched = Buffer.alloc(21); unmatched[1] = 1;
  unmatched.writeBigInt64LE(1n, 2); u64(1).copy(unmatched, 10);
  const capPost = () => ix(20, unmatched, [meta(portfolios[0][0]), meta(maker.publicKey, true, true),
    meta(batch), meta(registry, false), meta(book), meta(MATCHER, false)]);
  for (let index = 4; index < 12; index++) await runtime.send(`order cap fixture ${index + 1}`, [capPost()], [payer, maker]);
  await rejectUnchanged('thirteenth live order rejected', [capPost()], [payer, maker], capAddresses);
  for (let index = 0; index < capAddresses.length; index++) await runtime.setAccount(capAddresses[index], {
    owner: capSnapshot[index].owner, data: capSnapshot[index].data, lamports: Number(capSnapshot[index].lamports) });
  await runtime.advanceSlots(200);
  await runtime.send('close collecting' , [ix(6, Buffer.alloc(0), [meta(batch), meta(registry)])], [payer]);
  const forgedResults = Keypair.generate().publicKey;
  await runtime.setAccount(forgedResults, { owner: MATCHER, data: Buffer.alloc(8 + 9 + 34 + 128 * 58) });
  await rejectUnchanged('wrong results PDA', [ix(7, Buffer.from([0, 0, 1, 0, 0, 0]),
    [meta(batch), meta(book), meta(forgedResults), meta(MATCHER, false), meta(registry), meta(instrument, false),
      meta(payer.publicKey, true, true), meta(SystemProgram.programId, false)])],
    [payer], [batch, book, forgedResults, results, registry]);
  await runtime.send('clear', [ix(7, Buffer.from([0, 0, 1, 0, 0, 0]), [meta(batch), meta(book), meta(results),
    meta(MATCHER, false), meta(registry), meta(instrument, false),
      meta(payer.publicKey, true, true), meta(SystemProgram.programId, false)])], [payer]);
  await runtime.assertState([{ address: batch, fields: [field('Cleared', 16, 1, 4)] },
    { address: results, fields: [field('result batch', 8, 8, 0), field('unspent', 16, 1, 0)] }]);
  await rejectUnchanged('re-clear rejected', [ix(7, Buffer.from([0, 0, 1, 0, 0, 0]),
    [meta(batch), meta(book), meta(results), meta(MATCHER, false), meta(registry), meta(instrument, false),
      meta(payer.publicKey, true, true), meta(SystemProgram.programId, false)])],
    [payer], [batch, book, results, registry]);
  await rejectUnchanged('reinitialize cannot reset cleared withdrawal lock', [ix(0, init,
    [meta(registry), meta(payer.publicKey, true, true), meta(instrument),
      meta(SystemProgram.programId, false), meta(vault)])],
    [payer], [registry, instrument, vault, batch, results]);
  await rejectUnchanged('withdrawal globally blocked while cleared', [ix(3, u64(1),
    [meta(portfolios[0][0]), meta(maker.publicKey, true, true), meta(vault), meta(registry, false)])],
    [payer, maker], [portfolios[0][0], vault, registry, batch]);
  const cleared = await runtime.account(results);
  assert.equal(cleared.data.readUInt16LE(49), 4, 'both DFBA sides produced maker and taker fills');
  // Expectations come from the independent Fraction ledger, fed ordered inputs.
  const observedFills = [];
  const recordFills = (data, conversionPrice, provenance = 'observed matcher output') => {
    const count = data.readUInt16LE(49);
    const fills = Array.from({ length: count }, (_, index) => {
      const offset = 8 + 9 + 34 + index * 58;
      const makerFill = Boolean(data[offset + 56]);
      const bidAuction = data[offset + 57] === 0;
      const quantity = data.readBigUInt64LE(offset + 40);
      return { provenance, account: new PublicKey(data.subarray(offset, offset + 32)).toBase58(),
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
      const storedDenominator = state.readBigUInt64LE(248);
      assert.ok(storedDenominator === 0n || storedDenominator === 1_000_000_000_000n, `${label}: fixed entry grid`);
      assert.ok(remainder < (storedDenominator || 1n), `${label}: canonical remainder`);
      const denominator = storedDenominator || 1n;
      assert.equal((integer * denominator + remainder) * BigInt(position.denominator),
        BigInt(position.numerator) * denominator, `${label}: quantized reference entry`);
    }
    runtime.report.settlementScenarios ??= [];
    runtime.report.settlementScenarios.push({ label, model, observedFills: [...observedFills] });
    runtime.report.model = model;
    runtime.flushReport();
  };
  const settle = oracleKey => ix(8, Buffer.from([0, 0, 2, 0]), [meta(batch), meta(registry), meta(vault),
    meta(results), meta(instrument), meta(book, false), meta(oracleKey, false), meta(MATCHER, false),
    ...portfolios.map(([portfolio]) => meta(portfolio)), meta(nextBatch)]);
  const integrityClock = await runtime.account(new PublicKey('SysvarC1ock11111111111111111111111111111111'));
  await runtime.setOracle(oracle, { owner: ORACLE, authority: payer.publicKey, instrument,
    price: 1_000_000, publishTime: Number(integrityClock.data.readBigInt64LE(32)), confidence: 12 });
  const integrityAccounts = [batch, registry, vault, instrument, results, nextBatch, ...portfolios.map(([key]) => key)];
  const incomplete = settle(oracle);
  incomplete.data.writeUInt16LE(1, 3); incomplete.keys.splice(9, 1);
  await rejectUnchanged('missing portfolio reverts complete batch', [incomplete], [payer], integrityAccounts);
  const duplicate = settle(oracle); duplicate.keys[9] = { ...duplicate.keys[8] };
  await rejectUnchanged('duplicate portfolio reverts complete batch', [duplicate], [payer], integrityAccounts);
  const malformed = settle(oracle); malformed.data.writeUInt16LE(65535, 3);
  await rejectUnchanged('malformed portfolio count rejected', [malformed], [payer], integrityAccounts);
  const originalResults = await runtime.account(results);
  const wrongBatchResults = Buffer.from(originalResults.data); wrongBatchResults.writeBigUInt64LE(1n, 8);
  await runtime.setAccount(results, { owner: MATCHER, data: wrongBatchResults, lamports: Number(originalResults.lamports) });
  await rejectUnchanged('wrong batch result rejected', [settle(oracle)], [payer], integrityAccounts);
  const spentResults = Buffer.from(originalResults.data); spentResults[16] = 1;
  await runtime.setAccount(results, { owner: MATCHER, data: spentResults, lamports: Number(originalResults.lamports) });
  await rejectUnchanged('spent result replay rejected', [settle(oracle)], [payer], integrityAccounts);
  await runtime.setAccount(results, { owner: MATCHER, data: originalResults.data, lamports: Number(originalResults.lamports) });
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
  const protectedAccounts = [batch, registry, results, instrument, vault, nextBatch, ...portfolios.map(([key]) => key)];
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
  await runtime.assertState([{ address: results, fields: [field('spent after settlement', 16, 1, 1)] }]);
  await rejectUnchanged('settled batch replay rejected', [settle(oracle)], [payer], integrityAccounts);
  // A simulated withdrawal proves the lock was released without changing the accounting model fixture.
  {
    const latest = await runtime.connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: payer.publicKey, ...latest }).add(ix(3, u64(1),
      [meta(portfolios[0][0]), meta(maker.publicKey, true, true), meta(vault), meta(registry, false)]));
    tx.sign(payer, maker);
    const simulation = (await runtime.rpc('simulateTransaction', [tx.serialize().toString('base64'),
      { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }])).value;
    assert.equal(simulation.err, null, `withdrawal resumes after settlement: ${simulation.logs}`);
    runtime.report.withdrawalResumedAfterSettlement = true; runtime.flushReport();
  }
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
      [meta(batch), meta(book), meta(results), meta(MATCHER, false), meta(registry), meta(instrument, false),
      meta(payer.publicKey, true, true), meta(SystemProgram.programId, false)])], [payer]);
    const observed = (await runtime.account(results)).data;
    assert.equal(observed.readUInt16LE(49), orders.length * 2, `${label}: all paired orders filled`);
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
  await settleScenario('partial reduce preserves stored entry', [{ side: 1, qty: 501, price: 101_000_000 }], 99_000_000);
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
  // Arithmetic regression fixtures bypass matching only. Both portfolios stay
  // balanced, and public signed SettleBatch executes every ordered fill in .so.
  // The report distinguishes these fixture inputs from observed matcher fills.
  const lifecycle = [];
  const pair = (side, price) => {
    lifecycle.push({ index: 0, side, price }, { index: 1, side: 1 - side, price });
  };
  pair(0, 100_000_000);
  for (let cycle = 0; cycle < 128; cycle++) {
    pair(0, 100_000_001 + cycle % 2);
    pair(1, 100_000_001 + cycle % 2);
  }
  pair(1, 100_000_000);
  for (let offset = 0; offset < lifecycle.length; offset += 128) {
    const entries = lifecycle.slice(offset, offset + 128);
    const label = `fixed-grid lifecycle fixture ${offset / 128}`;
    batch = nextBatch;
    [nextBatch] = pda([Buffer.from('batch'), u64(batchId + 1)]);
    [results] = pda([Buffer.from('results'), u64(batchId)], MATCHER);
    const batchData = Buffer.from((await runtime.account(batch)).data);
    batchData[16] = 4; // Valid v1 batch header/id, now cleared for the fixture.
    await runtime.setAccount(batch, { owner: CORE, data: batchData });
    await runtime.setAccount(nextBatch, { owner: CORE, data: Buffer.alloc(176) });
    const data = Buffer.alloc(8 + 9 + 34 + 128 * 58);
    data[0] = 8; data[1] = 1; // Matcher-owned BatchResults v1.
    data.writeBigUInt64LE(BigInt(batchId), 8);
    data.writeUInt16LE(entries.length, 49);
    entries.forEach(({ index, side, price }, i) => {
      const off = 51 + i * 58;
      [maker, taker][index].publicKey.toBuffer().copy(data, off);
      u64(offset + i).copy(data, off + 32);
      u64(1).copy(data, off + 40);
      data.writeBigInt64LE(BigInt(price), off + 48);
      data[off + 56] = 1; data[off + 57] = side; // Maker buy in bid, sell in ask.
    });
    await runtime.setAccount(results, { owner: MATCHER, data });
    recordFills((await runtime.account(results)).data, 100_000_000, 'cleared-results arithmetic fixture');
    const fresh = await runtime.account(new PublicKey('SysvarC1ock11111111111111111111111111111111'));
    await runtime.setOracle(oracle, { owner: ORACLE, authority: payer.publicKey, instrument,
      price: 100_000_000, publishTime: Number(fresh.data.readBigInt64LE(32)), confidence: 12 });
    await runtime.send(label, [settle(oracle)], [payer]);
    await assertModel(label);
    batchId++;
  }
  assert.deepEqual(model.positions, {}, '128 lifecycle cycles per direction finish flat');
  runtime.report.fixedGridCyclesPerDirection = 128;
  runtime.flushReport();
  const worker = await runtime.launchWorker(process.execPath, ['-e',
    'fetch(process.env.RPC_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getSlot",params:[]})}).then(r=>r.json()).then(r=>{if(!Number.isInteger(r.result))process.exit(1)})']);
  const [exitCode] = await once(worker, 'exit');
  assert.equal(exitCode, 0, 'real worker process can read the validator');
  const heldWorker = await runtime.launchWorker(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await runtime.close();
  assert.ok(heldWorker.signalCode || heldWorker.exitCode !== null, 'cleanup reaps a running worker');
});
