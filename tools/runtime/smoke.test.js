'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');
const { LocalRuntime } = require('./harness');
const { decodeAccount, decodeResults } = require('../../mgk-frontend/packages/layout');
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
const field = (name, path, value) => ({ name, path, value: String(value) });

// Intentionally runs, or fails: absence of candidate artifacts is never a skipped green test.
test('candidate runtime: oracle risk, order reservations, reduce-only clipping and rollback', { timeout: 420000 }, async t => {
  assert.ok(process.env.MGK_CANDIDATE_MANIFEST, 'MGK_CANDIDATE_MANIFEST is required; see tools/runtime/README.md');
  const candidate = JSON.parse(readFileSync(process.env.MGK_CANDIDATE_MANIFEST, 'utf8'));
  assert.match(candidate.commit, /^[0-9a-f]{40}$/, 'candidate commit required');
  assert.deepEqual(candidate.programs.map(p => p.programId).sort(), [CORE, MATCHER, ORACLE].map(String).sort());
  const runtime = await LocalRuntime.start({ candidates: candidate.programs,
    port: Number(process.env.MGK_RUNTIME_PORT ?? 18999), reportPath: process.env.MGK_RUNTIME_REPORT });
  t.after(() => runtime.close());
  runtime.report.candidateCommit = candidate.commit; runtime.flushReport();
  const payer = Keypair.generate(), maker = Keypair.generate(), taker = Keypair.generate();
  // The funder tops up the insurance fund. It is neither governance nor a trader: top-up is permissionless.
  const funder = Keypair.generate();
  for (const wallet of [payer, maker, taker]) await runtime.setAccount(wallet.publicKey,
    { owner: SystemProgram.programId, lamports: 20_000_000_000 });
  await runtime.setAccount(funder.publicKey, { owner: SystemProgram.programId, lamports: 60_000_000_000 });
  // The vault invariant is exact: vault lamports - rent = collateral + fund - uncovered debt.
  const vaultRent = BigInt(await runtime.rpc('getMinimumBalanceForRentExemption', [80]));
  const [registry, regBump] = pda([Buffer.from('registry')]);
  const [instrument, instBump] = pda([Buffer.from('instrument'), Buffer.alloc(2)]);
  const [vault] = pda([Buffer.from('vault')]);
  let [batch, batchBump] = pda([Buffer.from('batch'), u64(0)]);
  let [nextBatch] = pda([Buffer.from('batch'), u64(1)]);
  const [book] = pda([Buffer.from('book'), Buffer.alloc(2)], MATCHER);
  let [results] = pda([Buffer.from('results'), u64(0)], MATCHER);
  const oracle = Keypair.generate().publicKey;
  // Simulation only: proves an instruction is accepted without changing any account.
  const simulateOk = async (label, instructions, signers) => {
    const latest = await runtime.connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: signers[0].publicKey, ...latest }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...instructions);
    tx.sign(...signers);
    const simulation = (await runtime.rpc('simulateTransaction', [tx.serialize().toString('base64'),
      { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }])).value;
    assert.equal(simulation.err, null, `${label}: must be accepted: ${simulation.logs}`);
  };
  // `expectedCode`, when given, pins the exact custom program error (instruction 2 follows two compute-budget ixs).
  const rejectUnchanged = async (label, instructions, signers, addresses, expectedCode) => {
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
    if (expectedCode !== undefined) assert.deepEqual(simulation.err, { InstructionError: [2, { Custom: expectedCode }] },
      `${label}: expected error code ${expectedCode}`);
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
    if (expectedCode !== undefined) assert.deepEqual(status.err, { InstructionError: [2, { Custom: expectedCode }] },
      `${label}: submitted error code ${expectedCode}`);
    const after = await Promise.all(addresses.map(snapshot));
    after.forEach((account, index) => assert.deepEqual(account, before[index],
      `${label}: ${addresses[index]} account unchanged`));
    runtime.report.integrityRejections ??= [];
    runtime.report.integrityRejections.push({ label, signature, error: status.err });
    runtime.flushReport();
  };
  // The third trader joins later so a winner can leave while its counterparty stays open.
  const carol = Keypair.generate();
  const traders = [maker, taker];
  const portfolios = traders.map(user => pda([Buffer.from('portfolio'), user.publicKey.toBuffer()]));
  const carolPortfolio = pda([Buffer.from('portfolio'), carol.publicKey.toBuffer()]);
  // Genesis scaffolding supplies zeroed storage for the signed initialization lifecycle.
  // All initialized fields, deposits, orders, clearing and settlement are written by signed program transactions.
  for (const [address, owner, size] of [[registry, CORE, 94], [instrument, CORE, 352], [vault, CORE, 80],
    [batch, CORE, 176], [nextBatch, CORE, 176], [book, MATCHER, 27712],
    ...[...portfolios, carolPortfolio].map(([address]) => [address, CORE, 2848])]) {
    const data = Buffer.alloc(size);
    // The vault is created with exactly its rent-exempt minimum so the exact invariant holds from the first move.
    await runtime.setAccount(address, address === vault ? { owner, data, lamports: Number(vaultRent) } : { owner, data });
  }
  await runtime.setOracle(oracle, { owner: ORACLE, authority: payer.publicKey, instrument,
    price: 100_000_000, publishTime: 123, confidence: 456 });
  await runtime.assertState([{ address: oracle, owner: ORACLE, fields: [field('price', 'price', 100_000_000),
    field('publish time', 'timestamp', 123), field('confidence', 'confidence', 456)] }]);
  await runtime.setOracle(oracle, { owner: ORACLE, authority: payer.publicKey, instrument,
    price: 110_000_000, publishTime: 789, confidence: 12 });
  await runtime.assertState([{ address: oracle, fields: [field('price', 'price', 110_000_000),
    field('publish time', 'timestamp', 789), field('confidence', 'confidence', 12)] }]);
  // Also execute the candidate oracle .so, rather than only storing its bytes.
  await runtime.send('oracle activate', [ix(3, Buffer.alloc(0), [meta(oracle), meta(payer.publicKey, false, true)], ORACLE)], [payer]);
  const init = Buffer.alloc(140);
  payer.publicKey.toBuffer().copy(init);
  init.writeUInt16LE(1, 32); init.writeUInt16LE(10000, 34);
  u64(1_000_000).copy(init, 44); init.writeUInt32LE(1, 52);
  u64(10).copy(init, 56); u64(25).copy(init, 64); u64(25).copy(init, 72);
  u64(1).copy(init, 82); u64(1).copy(init, 90);
  init.writeUInt16LE(2000, 98); init.writeUInt16LE(1000, 100); init.writeUInt16LE(5, 102);
  oracle.toBuffer().copy(init, 106); init[138] = regBump; init[139] = instBump;
  await runtime.send('initialize', [ix(0, init, [meta(registry), meta(payer.publicKey, true, true), meta(instrument),
    meta(SystemProgram.programId, false), meta(vault)])], [payer]);
  await runtime.assertState([{ address: registry, fields: [field('10-second batch maximum', 'tMaxSlots', 25)] }]);
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
    await runtime.assertState([{ address: portfolio, fields: [field('collateral', 'equity', 1_000_000_000),
      field('principal', 'principal', 1_000_000_000)] }]);
  }
  const vaultBefore = await runtime.account(vault);
  assert.equal(vaultBefore.lamports, 2_000_000_000n + vaultRent, 'deposited lamports plus rent');
  assert.equal(decodeAccount('Vault', vaultBefore.data).insuranceFund, 0n, 'the fund starts empty: only signed top-ups fund it');
  // The cash-backed 20 SOL fund arrives by a signed, permissionless top-up (disc 26), not a genesis patch.
  const initialFund = 20_000_000_000n;
  const topUp = (amount, payerWallet = funder) => ix(26, u64(amount),
    [meta(payerWallet.publicKey, true, true), meta(vault), meta(SystemProgram.programId, false)]);
  await runtime.send('top up the insurance fund', [topUp(initialFund)], [funder]);
  await runtime.assertState([{ address: vault, lamports: String(2_000_000_000n + initialFund + vaultRent), fields: [
    field('vault balance is total collateral only', 'balance', 2_000_000_000n), field('fund', 'insuranceFund', initialFund),
    field('no uncovered debt', 'uncoveredBadDebt', 0)] }]);
  const postClock = await runtime.account(new PublicKey('SysvarC1ock11111111111111111111111111111111'));
  await runtime.setOracle(oracle, { owner: ORACLE, authority: payer.publicKey, instrument,
    price: 1_000_000, publishTime: Number(postClock.data.readBigInt64LE(32)), confidence: 12 });
  for (const [index, side, isMaker] of [[0, 0, true], [0, 1, true], [1, 1, false], [1, 0, false]]) {
    const user = [maker, taker][index], data = Buffer.alloc(21);
    data[0] = side; data[1] = Number(isMaker); data.writeBigInt64LE(1_000_000n, 2); u64(1).copy(data, 10);
    await runtime.send(`post ${index} ${side}`, [ix(20, data, [meta(portfolios[index][0]), meta(user.publicKey, true, true),
      meta(batch), meta(registry, false), meta(book), meta(MATCHER, false), meta(instrument, false), meta(oracle, false), meta(vault, false)])], [payer, user]);
  }
  const forgedBook = Keypair.generate().publicKey;
  const genuineBook = await runtime.account(book);
  await runtime.setAccount(forgedBook, { owner: MATCHER, data: genuineBook.data });
  const spoofPostData = Buffer.alloc(21); spoofPostData[1] = 1;
  spoofPostData.writeBigInt64LE(1n, 2); u64(1).copy(spoofPostData, 10);
  for (const [label, bookKey, matcherKey] of [
    ['wrong book PDA', forgedBook, MATCHER], ['wrong matcher program', book, SystemProgram.programId],
  ]) await rejectUnchanged(label, [ix(20, spoofPostData, [meta(portfolios[0][0]),
    meta(maker.publicKey, true, true), meta(batch), meta(registry, false), meta(bookKey), meta(matcherKey, false), meta(instrument, false), meta(oracle, false), meta(vault, false)])],
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
    meta(batch), meta(registry, false), meta(book), meta(MATCHER, false), meta(instrument, false), meta(oracle, false), meta(vault, false)]);
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
  await runtime.assertState([{ address: batch, fields: [field('Cleared', 'status', 4)] },
    { address: results, fields: [field('result batch', 'batchId', 0), field('unspent', 'spent', 0)] }]);
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
  assert.equal(decodeResults(cleared.data).numFills, 4, 'both DFBA sides produced maker and taker fills');
  // Expectations come from the independent Fraction ledger, fed ordered inputs.
  // Ordered ledger events: the signed top-up first, then fills and later signed fund/withdraw/unpause moves.
  const observedFills = [{ kind: 'top_up', amount: String(initialFund) }];
  const recordFills = (data, conversionPrice, provenance = 'observed matcher output') => {
    const fills = decodeResults(data).fills.map(fill => {
      const bidAuction = fill.auction === 0;
      return { provenance, account: new PublicKey(fill.user).toBase58(),
        quantity_lots: String(bidAuction === fill.isMaker ? fill.qty : -fill.qty),
        fill_price: String(fill.price), conversion_price: String(conversionPrice), maker: fill.isMaker };
    });
    for (const fill of fills) assert.ok(traders.map(user => String(user.publicKey)).includes(fill.account),
      'observed fill belongs to a participating portfolio owner');
    observedFills.push(...fills);
    return fills;
  };
  let riskPrice = 1_000_000;
  // Portfolios whose cached risk fields (IM, MM, free, health) are current at riskPrice. Only settlement of a
  // portfolio and its own withdrawals refresh the cache, so other portfolios keep their older cached values.
  let riskFresh = new Set([0, 1]);
  const reference = () => JSON.parse(execFileSync('python3', ['-B', '-c', `
import json, sys
from fractions import Fraction
sys.path.insert(0, sys.argv[1])
from reference_model import Ledger, Fill
request = json.load(sys.stdin)
ledger = Ledger(int(request['fund']), {account: int(value) for account, value in request['collateral'].items()})
usd_totals = {}
for fill in request['events']:
    kind = fill.get('kind', 'fill')
    # Non-fill events replay signed fund and withdrawal transactions in their on-chain order.
    if kind == 'top_up':
        ledger.top_up(int(fill['amount'])); continue
    if kind == 'donate':
        ledger.donate(int(fill['amount'])); continue
    if kind == 'deposit':
        ledger.collateral[fill['account']] = ledger.collateral.get(fill['account'], 0) + int(fill['amount']); continue
    if kind == 'withdraw_fund':
        ledger.withdraw_fund(int(fill['amount'])); continue
    if kind == 'withdraw':
        ledger.withdraw(fill['account'], int(fill['amount']), int(fill['conversion_price'])); continue
    if kind == 'unpause':
        ledger.unpause(fill['withdrawals'], fill['trading']); continue
    account = fill['account']
    before = ledger.realized_micro_usd.get(account, Fraction(0))
    ledger.apply_fill(Fill(account, int(fill['quantity_lots']), int(fill['fill_price']), int(fill['conversion_price']), fill['maker']))
    delta = ledger.realized_micro_usd.get(account, Fraction(0)) - before
    # The i128 display counter quantizes each event toward the protocol; conversion above stays exact.
    usd_totals[account] = usd_totals.get(account, 0) + delta.numerator // delta.denominator
risk = {}
for account, collateral in ledger.collateral.items():
    position = ledger.positions.get(account)
    quantity = position.quantity_lots if position else 0
    pnl = Fraction(quantity) * (int(request['risk_price']) - position.entry_price) * 1_000_000 / int(request['risk_price']) if position else Fraction(0)
    pnl = pnl.numerator // pnl.denominator
    im, mm = abs(quantity) * 200_000, abs(quantity) * 100_000
    risk[account] = {'im': str(im), 'mm': str(mm), 'free': str(collateral + min(pnl, 0) - im), 'health': str(collateral + pnl - mm),
        'withdrawable': str(ledger.withdrawable(account, int(request['risk_price'])))}
positions = {account: {'qty': str(p.quantity_lots), 'entry': str(p.entry_price.numerator // p.entry_price.denominator),
    'numerator': str(p.entry_price.numerator), 'denominator': str(p.entry_price.denominator)} for account, p in ledger.positions.items()}
print(json.dumps({'collateral': {a: str(v) for a, v in ledger.collateral.items()}, 'fund': str(ledger.fund_lamports),
    'debt': str(ledger.uncovered_bad_debt), 'reserve': str(ledger.reserve_requirement()),
    'open_interest': [str(side) for side in ledger.open_interest()],
    'flags': (1 if ledger.trading_paused else 0) | (2 if ledger.withdrawals_paused else 0),
    'liability': str(ledger.vault_liability_lamports()),
    'above_rent': str(ledger.vault_lamports_above_rent()), 'positions': positions,
    'realized_usd': {a: str(v) for a, v in usd_totals.items()},
    'realized_lamports': {a: str(v) for a, v in ledger.realized_lamports.items()},
    'risk': risk, 'fees': {a: str(v) for a, v in ledger.fees_lamports.items()}}))
`, resolve(__dirname, '../gate')], { input: JSON.stringify({ risk_price: riskPrice, fund: '0', collateral: {
    [maker.publicKey]: '1000000000', [taker.publicKey]: '1000000000' }, events: observedFills }), encoding: 'utf8' }));
  recordFills(cleared.data, 1_000_000);
  let model = reference();
  const assertModel = async label => {
    model = reference();
    const expected = portfolios.map(([address], index) => {
      const account = String(traders[index].publicKey), position = model.positions[account];
      return { address, fields: [field(`${label}: collateral`, 'equity', model.collateral[account]),
        field(`${label}: realized USD`, 'realizedUsd', model.realized_usd[account] ?? 0),
        field(`${label}: realized lamports`, 'realizedLamports', model.realized_lamports[account] ?? 0),
        field(`${label}: fees paid`, 'feesPaid', model.fees[account] ?? 0),
        field(`${label}: funding off`, 'fundingPaid', 0),
        ...(riskFresh.has(index) ? [
        field(`${label}: initial margin`, 'im', model.risk[account].im),
        field(`${label}: maintenance margin`, 'mm', model.risk[account].mm),
        field(`${label}: free collateral`, 'freeCollateral', model.risk[account].free),
        field(`${label}: health`, 'health', model.risk[account].health)] : []),
        field(`${label}: reservations released`, 'reservedCollateral', 0),
        field(`${label}: position count`, 'positionsLen', position ? 1 : 0),
        field(`${label}: quantity`, 'positions.0.qty', position?.qty ?? 0),
        field(`${label}: entry floor`, 'positions.0.entryVwap', position?.entry ?? 0)] };
    });
    const totalCollateral = Object.values(model.collateral).reduce((sum, value) => sum + BigInt(value), 0n);
    // Vault v2: balance@8 is total collateral, fund@16, uncovered debt@32, open interest long/short @48/@56.
    // The vault is never under-backed: lamports - rent = collateral + fund - debt + donated surplus.
    await runtime.assertState([...expected, { address: vault,
      lamports: String(BigInt(model.above_rent) + vaultRent), fields: [
        field(`${label}: vault balance`, 'balance', totalCollateral),
        field(`${label}: fund`, 'insuranceFund', model.fund), field(`${label}: uncovered debt`, 'uncoveredBadDebt', model.debt),
        field(`${label}: open interest long`, 'openInterestLong', model.open_interest[0]),
        field(`${label}: open interest short`, 'openInterestShort', model.open_interest[1])] },
    { address: registry, fields: [field(`${label}: pause flags (trading|withdrawals)`, 'pauseFlags', model.flags)] }]);
    for (let index = 0; index < portfolios.length; index++) {
      const position = model.positions[String(traders[index].publicKey)];
      if (!position) continue;
      const positionState = decodeAccount('Portfolio', (await runtime.account(portfolios[index][0])).data).positions[0];
      const integer = positionState.entryVwap, remainder = positionState.entryRemainder;
      const storedDenominator = positionState.entryDenominator;
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
  // The settled portfolio set defaults to the first two traders; later scenarios set it to the batch's participants.
  let participants = [0, 1];
  const settle = oracleKey => ix(8, Buffer.from([0, 0, participants.length, 0]), [meta(batch), meta(registry), meta(vault),
    meta(results), meta(instrument), meta(book), meta(oracleKey, false), meta(MATCHER, false),
    ...participants.map(index => meta(portfolios[index][0])), meta(nextBatch)]);
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
  await runtime.assertState([{ address: oracle, fields: [field('published confidence', 'confidence', 4321)] }]);
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
  // The real oracle process loses quorum: it must leave the stale oracle untouched.
  const workerDirectory = mkdtempSync(join(tmpdir(), 'mgk-oracle-worker-'));
  t.after(() => rmSync(workerDirectory, { recursive: true, force: true }));
  const authorityPath = join(workerDirectory, 'ephemeral-oracle.json');
  writeFileSync(authorityPath, JSON.stringify([...payer.secretKey]), { mode: 0o600 });
  const fixturePath = join(workerDirectory, 'sources.json');
  const manifestPath = join(workerDirectory, 'deployment.json');
  writeFileSync(manifestPath, JSON.stringify({ ...deployment, cluster: 'localnet',
    accounts: Object.fromEntries(Object.entries({ registry, instrument, oracle, insurance: vault, maker: maker.publicKey })
      .map(([name, key]) => [name, { status: 'deployed', address: String(key) }])),
    start_slot: { status: 'set', slot: 0 } }));
  const runOracle = async mode => {
    writeFileSync(fixturePath, JSON.stringify({ mode }));
    const child = await runtime.launchWorker(process.execPath, ['--require', resolve(__dirname, 'oracle-fixture.cjs'),
      resolve(__dirname, '../ops-oracle.js'), '--once'], { env: {
      DEPLOYMENT_MANIFEST: manifestPath, ORACLE_AUTHORITY_KEYPAIR: authorityPath, MGK_ORACLE_FIXTURE: fixturePath } });
    let output = '', errors = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => errors += chunk);
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, `oracle worker process: ${errors}`);
    return JSON.parse(output.trim());
  };
  const staleOracle = await runtime.account(oracle);
  assert.equal((await runOracle('no_quorum')).status, 'no_quorum');
  assert.deepEqual((await runtime.account(oracle)).data, staleOracle.data, 'no quorum must not refresh oracle');
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
  const recovered = await runOracle('healthy');
  assert.equal(recovered.status, 'published');
  assert.equal(recovered.price, '1000000');
  assert.equal(recovered.confidence, '12');
  await runtime.assertState([{ address: oracle, fields: [field('worker recovery confidence', 'confidence', 12)] }]);
  runtime.report.oracleWorkerRecovery = {
    noQuorum: 'no_quorum', rejectedSettlement: rejectedSignature, recovery: recovered };
  runtime.flushReport();
  await runtime.send('settle', [settle(oracle)], [payer]);
  await assertModel('dual-auction roundtrip and oracle retry');
  await runtime.assertState([{ address: results, fields: [field('spent after settlement', 'spent', 1)] }]);
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
    { address: batch, fields: [field('Settled', 'status', 3)] },
    { address: portfolios[0][0], fields: [field('maker equity', 'equity', model.collateral[maker.publicKey])] },
    { address: portfolios[1][0], fields: [field('taker equity', 'equity', model.collateral[taker.publicKey])] },
    { address: vault, lamports: String(BigInt(model.above_rent) + vaultRent), fields: [
      field('vault balance', 'balance', Object.values(model.collateral).reduce((sum, value) => sum + BigInt(value), 0n)),
      field('insurance fund', 'insuranceFund', model.fund)] },
    { address: nextBatch, fields: [field('batch id', 'batchId', 1), field('Collecting', 'status', 0)] },
  ]);
  await assert.rejects(runtime.assertState([{ address: vault, lamports: String(BigInt(model.above_rent) + vaultRent + 1n) }]), /lamports/);
  await assert.rejects(runtime.assertState([{ address: portfolios[0][0], fields: [field('wrong expected model equity', 'equity', 42)] }]), /wrong expected model equity/);
  // Each later batch uses genuine signed post/clear/settle instructions. The oracle
  // conversion deliberately differs from the fill price, exposing spot-cashflow and unit bugs.
  let batchId = 1;
  const settleScenario = async (label, orders, conversionPrice, acceptedQuantities, postPrice = conversionPrice) => {
    batch = nextBatch;
    [nextBatch] = pda([Buffer.from('batch'), u64(batchId + 1)]);
    [results] = pda([Buffer.from('results'), u64(batchId)], MATCHER);
    await runtime.setAccount(nextBatch, { owner: CORE, data: Buffer.alloc(176) });
    const postClock = await runtime.account(new PublicKey('SysvarC1ock11111111111111111111111111111111'));
    await runtime.setOracle(oracle, { owner: ORACLE, authority: payer.publicKey, instrument,
      price: postPrice, publishTime: Number(postClock.data.readBigInt64LE(32)), confidence: 12 });
    // `reduceOnly` applies to the maker side (the original fixtures); `takerReduceOnly` to the taker side.
    // `makerIdx`/`takerIdx` pick the paired traders so a third portfolio can take the other side.
    const involved = new Set();
    for (const { side, qty, price, reduceOnly = false, takerReduceOnly = false, makerIdx = 0, takerIdx = 1 } of orders) {
      involved.add(makerIdx); involved.add(takerIdx);
      for (const index of [makerIdx, takerIdx]) {
        const isMaker = index === makerIdx, user = traders[index], data = Buffer.alloc(21);
        data[0] = isMaker ? side : 1 - side; data[1] = Number(isMaker);
        data.writeBigInt64LE(BigInt(price), 2); u64(qty).copy(data, 10);
        data[20] = Number(isMaker ? reduceOnly : takerReduceOnly);
        await runtime.send(`${label}: post ${index} ${side}`, [ix(20, data,
          [meta(portfolios[index][0]), meta(user.publicKey, true, true), meta(batch),
            meta(registry, false), meta(book), meta(MATCHER, false), meta(instrument, false), meta(oracle, false), meta(vault, false)])], [payer, user]);
      }
    }
    participants = [...involved].sort();
    await runtime.advanceSlots(200);
    await runtime.send(`${label}: close collecting`, [ix(6, Buffer.alloc(0), [meta(batch), meta(registry)])], [payer]);
    await runtime.send(`${label}: clear`, [ix(7, Buffer.from([0, 0, 1, 0, 0, 0]),
      [meta(batch), meta(book), meta(results), meta(MATCHER, false), meta(registry), meta(instrument, false),
      meta(payer.publicKey, true, true), meta(SystemProgram.programId, false)])], [payer]);
    const observed = (await runtime.account(results)).data;
    assert.equal(decodeResults(observed).numFills, orders.length * 2, `${label}: all paired orders filled`);
    riskPrice = conversionPrice; riskFresh = new Set(participants);
    const accepted = Buffer.from(observed);
    if (acceptedQuantities) {
      assert.equal(acceptedQuantities.length, decodeResults(observed).numFills);
      acceptedQuantities.forEach((quantity, i) => u64(quantity).copy(accepted, 51 + i * 58 + 40));
    }
    recordFills(accepted, conversionPrice, acceptedQuantities ? 'independently capped expected executions from matcher output' : 'observed matcher output');
    const fresh = await runtime.account(new PublicKey('SysvarC1ock11111111111111111111111111111111'));
    await runtime.setOracle(oracle, { owner: ORACLE, authority: payer.publicKey, instrument,
      price: conversionPrice, publishTime: Number(fresh.data.readBigInt64LE(32)), confidence: 12 });
    await runtime.send(`${label}: settle`, [settle(oracle)], [payer]);
    await assertModel(label);
    if (label === 'open without cash exchange') {
      const free = BigInt(model.risk[String(maker.publicKey)].free);
      assert.ok(free < BigInt(model.collateral[String(maker.publicKey)]), 'oracle loss and IM reduce withdrawability');
      await rejectUnchanged('withdrawal cannot spend oracle loss or position IM', [ix(3, u64(free + 1n),
        [meta(portfolios[0][0]), meta(maker.publicKey, true, true), meta(vault), meta(registry, false),
          meta(instrument, false), meta(oracle, false)])], [payer, maker], [portfolios[0][0], vault, registry]);
    }
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
  await settleScenario('reduce-only fixture opens paired positions', [{ side: 0, qty: 1000, price: 100_000_000 }], 100_000_000);
  await settleScenario('concurrent reduce-only closes cancel balanced excess', [
    { side: 1, qty: 750, price: 100_000_000, reduceOnly: true },
    { side: 1, qty: 750, price: 100_000_000, reduceOnly: true },
  ], 100_000_000, [750, 250, 750, 250]);
  assert.deepEqual(model.positions, {}, 'both sides remain flat after clipping 1500 tentative lots to1000');

  // ---- Issue 23: cash-backed insurance fund, exposure limits, risk-off, exhaustion and recovery ----
  const CLOCK = new PublicKey('SysvarC1ock11111111111111111111111111111111');
  const freshOracle = async price => runtime.setOracle(oracle, { owner: ORACLE, authority: payer.publicKey, instrument,
    price, publishTime: Number((await runtime.account(CLOCK)).data.readBigInt64LE(32)), confidence: 12 });
  // The collecting batch outside settleScenario is the one the last settle created.
  const postIx = (index, { side = 0, price = 100_000_000, qty = 1, reduceOnly = false } = {}) => {
    const data = Buffer.alloc(21); data[0] = side; data[1] = 0;
    data.writeBigInt64LE(BigInt(price), 2); u64(qty).copy(data, 10); data[20] = Number(reduceOnly);
    return ix(20, data, [meta(portfolios[index][0]), meta(traders[index].publicKey, true, true), meta(nextBatch),
      meta(registry, false), meta(book), meta(MATCHER, false), meta(instrument, false), meta(oracle, false), meta(vault, false)]);
  };
  const withdrawIx = (index, amount) => ix(3, u64(amount), [meta(portfolios[index][0]), meta(traders[index].publicKey, true, true),
    meta(vault), meta(registry, false), meta(instrument, false), meta(oracle, false)]);
  const withdrawFundIx = (amount, governance = payer) => ix(27, u64(amount),
    [meta(vault), meta(registry, false), meta(governance.publicKey, true, true)]);
  const unpauseIx = (withdrawals, trading) => ix(28, Buffer.from([Number(withdrawals), Number(trading)]),
    [meta(registry), meta(vault, false), meta(payer.publicKey, false, true)]);
  const doWithdraw = async (label, index, amount, price) => {
    await freshOracle(price);
    const walletBefore = (await runtime.account(traders[index].publicKey)).lamports;
    await runtime.send(label, [withdrawIx(index, amount)], [payer, traders[index]]);
    assert.equal((await runtime.account(traders[index].publicKey)).lamports, walletBefore + BigInt(amount),
      `${label}: the wallet receives exactly the withdrawn lamports`);
    observedFills.push({ kind: 'withdraw', account: String(traders[index].publicKey), amount: String(amount),
      conversion_price: String(price) });
    riskPrice = price; riskFresh = new Set([...riskFresh, index]);
  };
  const makerKey = String(maker.publicKey), takerKey = String(taker.publicKey), carolKey = String(carol.publicKey);

  // A third trader joins with a signed deposit, so a winner can leave while its original counterparty stays open.
  await runtime.setAccount(carol.publicKey, { owner: SystemProgram.programId, lamports: 20_000_000_000 });
  await runtime.send('init portfolio carol', [ix(1, Buffer.concat([carol.publicKey.toBuffer(), Buffer.from([carolPortfolio[1]])]),
    [meta(carolPortfolio[0]), meta(carol.publicKey, true, true)])], [payer, carol]);
  await runtime.send('deposit carol', [ix(2, u64(1_000_000_000), [meta(carolPortfolio[0]), meta(carol.publicKey, true, true),
    meta(SystemProgram.programId, false), meta(vault)])], [payer, carol]);
  traders.push(carol); portfolios.push(carolPortfolio);
  observedFills.push({ kind: 'deposit', account: carolKey, amount: '1000000000' });
  await assertModel('third trader joins');

  // Acceptance 6: a winner withdraws realized profit before the loser closes.
  await settleScenario('winner fixture: maker long against taker short',
    [{ side: 0, qty: 1000, price: 100_000_000 }], 100_000_000);
  const makerBeforeProfit = BigInt(model.collateral[makerKey]);
  await settleScenario('maker closes at a profit against a third trader',
    [{ side: 1, qty: 1000, price: 110_000_000, makerIdx: 0, takerIdx: 2 }], 110_000_000);
  assert.equal(model.positions[makerKey], undefined, 'the winner is flat');
  assert.equal(model.positions[takerKey].qty, '-1000', 'the loser still holds its position');
  const profit = BigInt(model.collateral[makerKey]) - makerBeforeProfit;
  assert.ok(profit > 0n, 'the fund credited the winner in cash');
  await doWithdraw('winner withdraws profit while the loser is still open', 0, profit, 110_000_000);
  await assertModel('winner withdrew profit before the loser closed');
  assert.equal(model.positions[takerKey].qty, '-1000', 'the loser is still open after the withdrawal');

  // Acceptance 1: fund withdrawal is admin-only and limited to the surplus above the reserve.
  assert.equal(model.reserve, String(1000n * 400_000n), 'reserve is 0.4 x larger-side open interest');
  const surplus = BigInt(model.fund) - BigInt(model.reserve);
  assert.ok(surplus > 0n, 'the topped-up fund exceeds the reserve');
  await rejectUnchanged('fund withdrawal above the surplus', [withdrawFundIx(surplus + 1n)], [payer], [vault, registry], 611);
  await rejectUnchanged('fund withdrawal by a non-governance signer', [withdrawFundIx(1n, funder)], [funder], [vault, registry], 7);
  await runtime.send('governance withdraws exactly the fund surplus', [withdrawFundIx(surplus)], [payer]);
  observedFills.push({ kind: 'withdraw_fund', amount: String(surplus) });
  await assertModel('fund withdrawn down to the required reserve');
  assert.equal(model.fund, model.reserve, 'fund sits exactly at the reserve');

  // Acceptance 2: exposure limits and risk-off. The fund equals the reserve, so any exposure-adding post is refused.
  const postAddresses = [nextBatch, portfolios[0][0], vault, book];
  await rejectUnchanged('portfolio exposure limit: 10 SOL', [postIx(0, { qty: 10_001 })], [payer, maker], postAddresses, 608);
  const cleanVault = await runtime.account(vault);
  const patchedVault = Buffer.from(cleanVault.data); patchedVault.writeBigUInt64LE(49_999n, 48);
  await runtime.setAccount(vault, { owner: CORE, data: patchedVault, lamports: Number(cleanVault.lamports) });
  await rejectUnchanged('market exposure limit: 50 SOL per side', [postIx(0, { qty: 2 })], [payer, maker], postAddresses, 609);
  await runtime.setAccount(vault, { owner: CORE, data: cleanVault.data, lamports: Number(cleanVault.lamports) });
  await rejectUnchanged('risk-off: fund below 0.4 x (larger-side OI + order quantity)', [postIx(0, { qty: 1 })],
    [payer, maker], postAddresses, 610);
  await freshOracle(110_000_000);
  await simulateOk('risk-off still accepts reduce-only closes',
    [postIx(2, { side: 1, qty: 1, reduceOnly: true, price: 110_000_000 })], [payer, carol]);
  await simulateOk('risk-off still accepts withdrawals', [withdrawIx(0, 1)], [payer, maker]);
  await assertModel('exposure limits and risk-off left no state change');

  // Acceptance 3: exhaustion. The fill price is above the post-time oracle and the oracle then drops, so the
  // lamport value of the loser's realized loss exceeds its whole collateral and the winner's gain exceeds fund plus collection.
  await settleScenario('exhaustion: winner closes against the underfunded loser',
    [{ side: 1, qty: 1000, price: 140_000_000, reduceOnly: true, takerReduceOnly: true, makerIdx: 2, takerIdx: 1 }],
    20_000_000, undefined, 110_000_000);
  assert.deepEqual(model.positions, {}, 'both reduce-only closes filled');
  assert.ok(BigInt(model.debt) > 0n, 'the unpaid payout is recorded as uncovered bad debt');
  assert.equal(model.fund, '0', 'the fund is exhausted');
  assert.equal(model.flags, 3, 'exhaustion auto-pauses trading and withdrawals');
  await rejectUnchanged('paused: new exposure refused', [postIx(0, { qty: 1 })], [payer, maker],
    [nextBatch, portfolios[0][0], vault, book, registry], 602);
  await freshOracle(20_000_000);
  await rejectUnchanged('paused: the winner cannot withdraw yet', [withdrawIx(2, 1)], [payer, carol],
    [portfolios[2][0], vault, registry], 602);

  // Acceptance 3 and 4: inflows repay debt first; unpause needs debt 0 and the reserve, withdrawals first.
  await rejectUnchanged('unpause refused while debt is outstanding', [unpauseIx(true, false)], [payer], [registry, vault], 612);
  const debt = BigInt(model.debt);
  await runtime.send('partial top-up repays debt before the fund', [topUp(debt - 1n)], [funder]);
  observedFills.push({ kind: 'top_up', amount: String(debt - 1n) });
  await assertModel('partial top-up');
  assert.equal(model.debt, '1', 'one lamport of debt remains'); assert.equal(model.fund, '0', 'debt is repaid before the fund');
  await rejectUnchanged('unpause refused with one lamport of debt', [unpauseIx(true, false)], [payer], [registry, vault], 612);
  await runtime.send('top-up clears the debt and funds the remainder', [topUp(1_000_001n)], [funder]);
  observedFills.push({ kind: 'top_up', amount: '1000001' });
  await assertModel('debt cleared by inflow');
  assert.equal(model.debt, '0'); assert.equal(model.fund, '1000000', 'the remainder joins the fund');
  await rejectUnchanged('trading cannot resume before withdrawals', [unpauseIx(false, true)], [payer], [registry, vault], 612);
  await runtime.send('unpause withdrawals first', [unpauseIx(true, false)], [payer]);
  observedFills.push({ kind: 'unpause', withdrawals: true, trading: false });
  await assertModel('withdrawals resumed, trading still paused');
  assert.equal(model.flags, 1);
  await doWithdraw('winner withdraws once withdrawals resume', 2, BigInt(model.collateral[carolKey]), 20_000_000);
  await assertModel('winner withdrew after recovery');
  await rejectUnchanged('trading is still paused after withdrawals resume', [postIx(0, { qty: 1 })], [payer, maker],
    [nextBatch, portfolios[0][0], vault, book, registry], 602);
  await runtime.send('unpause trading', [unpauseIx(false, true)], [payer]);
  observedFills.push({ kind: 'unpause', withdrawals: false, trading: true });
  await assertModel('trading resumed');
  assert.equal(model.flags, 0);
  await freshOracle(20_000_000);
  await simulateOk('trading resumes: new exposure is accepted again', [postIx(0, { qty: 1, price: 20_000_000 })], [payer, maker]);

  // Acceptance 5: a plain transfer to the vault is surplus, not a lockout. Deposits, withdrawals and top-ups keep
  // working around it, while a vault that is under-backed by even one lamport reverts every lamport move.
  await runtime.send('direct lamport donation to the vault', [SystemProgram.transfer({
    fromPubkey: funder.publicKey, toPubkey: vault, lamports: 777 })], [funder]);
  observedFills.push({ kind: 'donate', amount: '777' });
  await assertModel('donation is tolerated as surplus');
  await runtime.send('top-up still works with a donation present', [topUp(1_000n)], [funder]);
  observedFills.push({ kind: 'top_up', amount: '1000' });
  await assertModel('top-up around a donation');
  await runtime.send('deposit still works with a donation present', [ix(2, u64(5_000), [meta(carolPortfolio[0]),
    meta(carol.publicKey, true, true), meta(SystemProgram.programId, false), meta(vault)])], [payer, carol]);
  observedFills.push({ kind: 'deposit', account: carolKey, amount: '5000' });
  await assertModel('deposit around a donation');
  await doWithdraw('withdrawal still works with a donation present', 2, 1, 20_000_000);
  await assertModel('withdrawal around a donation');
  const donatedVault = await runtime.account(vault);
  await runtime.setAccount(vault, { owner: CORE, data: donatedVault.data,
    lamports: Number(BigInt(model.above_rent) + vaultRent - 778n) });
  await rejectUnchanged('an under-backed vault reverts a top-up', [topUp(1_000n)], [funder], [vault], 607);
  await freshOracle(20_000_000);
  await rejectUnchanged('an under-backed vault reverts a withdrawal', [withdrawIx(0, 1)], [payer, maker], [vault, portfolios[0][0]], 607);
  await runtime.setAccount(vault, { owner: CORE, data: donatedVault.data, lamports: Number(donatedVault.lamports) });
  await assertModel('vault restored after the under-backed check');
  const worker = await runtime.launchWorker(process.execPath, ['-e',
    'fetch(process.env.RPC_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getSlot",params:[]})}).then(r=>r.json()).then(r=>{if(!Number.isInteger(r.result))process.exit(1)})']);
  const [exitCode] = await once(worker, 'exit');
  assert.equal(exitCode, 0, 'real worker process can read the validator');
  // End-of-run audit: the same read-only CLI that audits devnet, pointed at the local runtime
  // and at the candidate programs actually loaded.
  const auditor = await runtime.launchWorker(process.execPath, [resolve(__dirname, 'audit.js'),
    '--deployment', process.env.MGK_CANDIDATE_MANIFEST]);
  let auditOutput = '', auditErrors = '';
  auditor.stdout.on('data', chunk => { auditOutput += chunk; });
  auditor.stderr.on('data', chunk => { auditErrors += chunk; });
  const [auditExit] = await once(auditor, 'close'); // 'close' waits for stdout to drain
  assert.equal(auditExit, 0, `end-of-run audit: ${auditErrors}${auditOutput}`);
  const auditReport = JSON.parse(auditOutput);
  assert.deepEqual(auditReport.violations, []);
  assert.ok(auditReport.accounts.portfolios > 0 && auditReport.accounts.results > 0, 'audit read protocol state');
  assert.ok(auditReport.invariants.every(i => i.status !== 'fail'), JSON.stringify(auditReport.invariants));
  const heldWorker = await runtime.launchWorker(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await runtime.close();
  assert.ok(heldWorker.signalCode || heldWorker.exitCode !== null, 'cleanup reaps a running worker');
});
