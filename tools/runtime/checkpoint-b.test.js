'use strict';
// Checkpoint B follow-up (issue #37): the five L-tier rows left "not run" in
// docs/acceptance/2026-11-02-8903b23.md (P0-11, P0-17, P0-18, P0-19, P0-26)
// plus the two P1 L rows (P1-2, P1-3). Every scenario runs signed
// transactions against the candidate .so files in the Surfpool harness;
// lamport expectations come only from the independent Fraction reference
// model (tools/gate/ledger_scenario.py and takeover_scenario.py).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { LocalRuntime } = require('./harness');
const { decodeAccount, decodeResults, decodeStruct, layouts } = require('../../mgk-frontend/packages/layout');
const { encodeInstruction } = require('../../mgk-frontend/packages/layout/instructions');
const { Keypair, PublicKey, TransactionInstruction, Transaction, ComputeBudgetProgram, SystemProgram } = require('@solana/web3.js');
const deployment = require('../../deployments/devnet.json');
const CORE = new PublicKey(deployment.programs.perps_core);
const MATCHER = new PublicKey(deployment.programs.perps_matcher);
const ORACLE = new PublicKey(deployment.programs.oracle);
const CLOCK = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const pda = (seeds, owner = CORE) => PublicKey.findProgramAddressSync(seeds, owner);
const meta = (pubkey, isWritable = true, isSigner = false) => ({ pubkey, isWritable, isSigner });
const ix = (name, params, keys, programId = CORE) => new TransactionInstruction({
  programId, keys, data: Buffer.from(encodeInstruction(programId === MATCHER ? 'matcher' : 'core', name, params)),
});
const rawIx = (discriminator, data, keys, programId) => new TransactionInstruction({
  programId, keys, data: Buffer.concat([Buffer.from([discriminator]), data]),
});
const field = (name, path, value) => ({ name, path, value: String(value) });
const GATE_DIR = resolve(__dirname, '../gate');

function runPython(script, request) {
  return JSON.parse(execFileSync('python3', [resolve(GATE_DIR, script)], {
    input: JSON.stringify(request), encoding: 'utf8',
  }));
}

// Maintenance health from the independent model for one portfolio snapshot.
function modelHealth({ collateral, qty, entry, price }) {
  const out = execFileSync('python3', ['-B', '-c', `
import json, sys
sys.path.insert(0, sys.argv[1])
from fractions import Fraction
from reference_model import Ledger, Position
request = json.load(sys.stdin)
ledger = Ledger(0, {request["account"]: int(request["collateral"])})
ledger.positions[request["account"]] = Position(int(request["qty"]), Fraction(request["entry"]))
print(ledger.maintenance_health(request["account"], int(request["price"])))
`, GATE_DIR], {
    input: JSON.stringify({ account: 'V', collateral: String(collateral), qty: String(qty), entry: String(entry), price: String(price) }),
    encoding: 'utf8',
  });
  return BigInt(out.trim());
}

async function startMarket(t, port) {
  assert.ok(process.env.MGK_CANDIDATE_MANIFEST, 'MGK_CANDIDATE_MANIFEST is required; see tools/runtime/README.md');
  const candidate = JSON.parse(readFileSync(process.env.MGK_CANDIDATE_MANIFEST, 'utf8'));
  const runtime = await LocalRuntime.start({
    candidates: candidate.programs, port,
    reportPath: process.env.MGK_CHECKPOINT_B_REPORT
      ? `${process.env.MGK_CHECKPOINT_B_REPORT.replace(/\.json$/, '')}-${port}.json` : undefined,
  });
  t.after(() => runtime.close());
  runtime.report.candidateCommit = candidate.commit;
  runtime.report.checkpointB = { rejections: [] };
  runtime.flushReport();
  const payer = Keypair.generate();
  const funder = Keypair.generate();
  for (const wallet of [payer, funder]) {
    await runtime.setAccount(wallet.publicKey, { owner: SystemProgram.programId, lamports: 60_000_000_000 });
  }
  const vaultRent = BigInt(await runtime.rpc('getMinimumBalanceForRentExemption', [80]));
  const [registry, registryBump] = pda([Buffer.from('registry')]);
  const [instrument, instrumentBump] = pda([Buffer.from('instrument'), Buffer.alloc(2)]);
  const [vault] = pda([Buffer.from('vault')]);
  const [book] = pda([Buffer.from('book'), Buffer.alloc(2)], MATCHER);
  const oracle = Keypair.generate().publicKey;
  const batchPda = id => pda([Buffer.from('batch'), u64(id)])[0];
  const resultsPda = id => pda([Buffer.from('results'), u64(id)], MATCHER)[0];
  let batchId = 0;
  for (const [address, owner, size] of [[registry, CORE, 94], [instrument, CORE, 352], [vault, CORE, 80],
    [batchPda(0), CORE, 176], [book, MATCHER, 27712]]) {
    await runtime.setAccount(address, address === vault
      ? { owner, data: Buffer.alloc(size), lamports: Number(vaultRent) }
      : { owner, data: Buffer.alloc(size) });
  }
  const freshOracle = async (price = 100_000_000) => runtime.setOracle(oracle, {
    owner: ORACLE, authority: payer.publicKey, instrument, price,
    publishTime: Number((await runtime.account(CLOCK)).data.readBigInt64LE(32)), confidence: 12,
  });
  await freshOracle();
  await runtime.send('initialize', [ix('Initialize', {
    governance: payer.publicKey.toBytes(), instrumentCount: 1, volatilityMultiplier: 10000,
    batchIdCounter: 0n, baseDeposit: 1000000n, nMin: 1, tMinSlots: 10n, tMaxSlots: 25n,
    tRevealSlots: 25n, instrumentId: 0, tickSize: 1n, lotSize: 1n, imrBps: 2000, mmrBps: 1000,
    takerFeeBps: 5, makerFeeBps: 0, oracleAddr: oracle.toBytes(), registryBump, instrumentBump,
  }, [meta(registry), meta(payer.publicKey, true, true), meta(instrument),
    meta(SystemProgram.programId, false), meta(vault)])], [payer]);
  await runtime.send('initialize book', [ix('InitializeBook', { instrumentId: 0 },
    [meta(registry, false), meta(book), meta(payer.publicKey, true, true),
      meta(SystemProgram.programId, false), meta(MATCHER, false)])], [payer]);
  const [, batchBump] = pda([Buffer.from('batch'), u64(0)]);
  await runtime.send('create batch', [ix('CreateBatch', { bump: batchBump }, [meta(batchPda(0)), meta(registry)])], [payer]);
  const traders = [];
  const deposits = {};
  const events = [{ kind: 'top_up', amount: '20000000000' }];
  await runtime.send('top up insurance fund', [ix('TopUp', { amount: 20000000000n },
    [meta(funder.publicKey, true, true), meta(vault), meta(SystemProgram.programId, false)])], [funder]);
  const market = {
    runtime, payer, funder, registry, instrument, vault, book, oracle, vaultRent,
    traders, events,
    get batchId() { return batchId; },
    batchPda, resultsPda,
    freshOracle,
    async addTrader(deposit) {
      const user = Keypair.generate();
      await runtime.setAccount(user.publicKey, { owner: SystemProgram.programId, lamports: 20_000_000_000 });
      const [portfolio, bump] = pda([Buffer.from('portfolio'), user.publicKey.toBuffer()]);
      await runtime.setAccount(portfolio, { owner: CORE, data: Buffer.alloc(2848) });
      await runtime.send('init portfolio', [ix('InitPortfolio', { user: user.publicKey.toBytes(), bump },
        [meta(portfolio), meta(user.publicKey, true, true)])], [payer, user]);
      await runtime.send('deposit', [ix('Deposit', { amount: BigInt(deposit) },
        [meta(portfolio), meta(user.publicKey, true, true), meta(SystemProgram.programId, false), meta(vault)])],
        [payer, user]);
      traders.push({ user, portfolio });
      deposits[String(user.publicKey)] = String(deposit);
      return traders.length - 1;
    },
    portfolioState(index) {
      return runtime.account(traders[index].portfolio).then(a => decodeAccount('Portfolio', a.data));
    },
    async vaultState() {
      return decodeAccount('Vault', (await runtime.account(vault)).data);
    },
    async bookOrders() {
      const data = (await runtime.account(book)).data;
      const decoded = decodeAccount('OrderBook', data);
      const found = [];
      for (const levels of [decoded.bids.slice(0, Number(decoded.bidCount)), decoded.asks.slice(0, Number(decoded.askCount))]) {
        for (const level of levels) {
          let offset = level.firstOrderOffset;
          for (let i = 0; i < level.orderCount; i++) {
            const order = decodeStruct('RestingOrder', data, layouts.OrderBook.size + offset * layouts.RestingOrder.size);
            if (order.qty > order.filledQty) found.push(order);
            offset = order.nextOrderOffset;
          }
        }
      }
      return found;
    },
    model() {
      return runPython('ledger_scenario.py', { fund: '0', collateral: deposits, events });
    },
    // Compare every tracked portfolio and the vault against the model.
    async assertModel(label) {
      const model = market.model();
      const expected = [];
      for (let index = 0; index < traders.length; index++) {
        const account = String(traders[index].user.publicKey);
        const position = model.positions[account];
        expected.push({ address: traders[index].portfolio, fields: [
          field(`${label}: equity`, 'equity', model.collateral[account]),
          field(`${label}: realized USD`, 'realizedUsd', model.realized_usd[account] ?? 0),
          field(`${label}: realized lamports`, 'realizedLamports', model.realized_lamports[account] ?? 0),
          field(`${label}: fees`, 'feesPaid', model.fees[account] ?? 0),
          field(`${label}: funding off`, 'fundingPaid', 0),
          field(`${label}: position count`, 'positionsLen', position ? 1 : 0),
          field(`${label}: quantity`, 'positions.0.qty', position?.qty ?? 0),
          field(`${label}: entry floor`, 'positions.0.entryVwap',
            position ? BigInt(position.entry_numerator) / BigInt(position.entry_denominator) : 0),
        ] });
        if (position) {
          const state = (await market.portfolioState(index)).positions[0];
          const den = state.entryDenominator || 1n;
          assert.equal((state.entryVwap * den + state.entryRemainder) * BigInt(position.entry_denominator),
            BigInt(position.entry_numerator) * den, `${label}: exact entry for trader ${index}`);
        }
      }
      const totalCollateral = Object.values(model.collateral).reduce((sum, v) => sum + BigInt(v), 0n);
      expected.push({ address: vault, lamports: String(BigInt(model.above_rent) + vaultRent), fields: [
        field(`${label}: vault balance`, 'balance', totalCollateral),
        field(`${label}: fund`, 'insuranceFund', model.fund),
        field(`${label}: debt`, 'uncoveredBadDebt', model.debt),
        field(`${label}: OI long`, 'openInterestLong', model.open_interest[0]),
        field(`${label}: OI short`, 'openInterestShort', model.open_interest[1]),
      ] }, { address: registry, fields: [field(`${label}: pause flags`, 'pauseFlags', model.flags)] });
      await runtime.assertState(expected);
      runtime.report.checkpointB.models ??= [];
      runtime.report.checkpointB.models.push({ label, model });
      runtime.flushReport();
      return model;
    },
    async post(index, { side, isMaker, price, qty, reduceOnly = false }) {
      const data = { side, isMaker, price: BigInt(price), qty: BigInt(qty), instrumentId: 0, reduceOnly };
      await runtime.send(`post trader ${index}`, [ix('PostOrder', data,
        [meta(traders[index].portfolio), meta(traders[index].user.publicKey, true, true), meta(batchPda(batchId)),
          meta(registry, false), meta(book), meta(MATCHER, false), meta(instrument, false), meta(oracle, false), meta(vault, false)])],
        [payer, traders[index].user]);
      const state = await market.portfolioState(index);
      return state.orders.filter(o => o.remainingQty > 0n).map(o => o.orderId);
    },
    async closeAndClear() {
      await runtime.advanceSlots(40);
      await runtime.send('close collecting', [ix('CloseCommitting', {},
        [meta(batchPda(batchId)), meta(registry)])], [payer]);
      await runtime.send('clear', [ix('ClearBatch', { numCommitments: 0, numInstruments: 1, numPortfolios: 0 },
        [meta(batchPda(batchId)), meta(book), meta(resultsPda(batchId)), meta(MATCHER, false), meta(registry),
          meta(instrument, false), meta(payer.publicKey, true, true), meta(SystemProgram.programId, false)])], [payer]);
      return decodeResults((await runtime.account(resultsPda(batchId))).data);
    },
    // Feed the decoded matcher fills to the model feed, then settle in one tx.
    async settle(participants, conversionPrice, cleared) {
      for (const fill of cleared.fills) {
        const bidAuction = fill.auction === 0;
        events.push({
          kind: 'fill', account: new PublicKey(fill.user).toBase58(),
          quantity_lots: String(bidAuction === fill.isMaker ? fill.qty : -fill.qty),
          fill_price: String(fill.price), conversion_price: String(conversionPrice), maker: fill.isMaker,
        });
      }
      await runtime.setAccount(batchPda(batchId + 1), { owner: CORE, data: Buffer.alloc(176) });
      await freshOracle(conversionPrice);
      const signature = await runtime.send('settle', [ix('SettleBatch',
        { numCommitments: 0, numPortfolios: participants.length },
        [meta(batchPda(batchId)), meta(registry), meta(vault), meta(resultsPda(batchId)), meta(instrument),
          meta(book), meta(oracle, false), meta(MATCHER, false),
          ...participants.map(index => meta(traders[index].portfolio)), meta(batchPda(batchId + 1))])], [payer]);
      batchId++;
      return signature;
    },
    async cancel(index, orderId, { portfolio = traders[index].portfolio, signer = traders[index].user } = {}) {
      return runtime.send(`cancel trader ${index}`, [ix('CancelRestingOrder', { orderId: BigInt(orderId) },
        [meta(portfolio), meta(signer.publicKey, true, true), meta(book), meta(MATCHER, false), meta(registry, false)])],
        [payer, signer]);
    },
    cancelIx(index, orderId, { portfolio = traders[index].portfolio, signer = traders[index].user } = {}) {
      return ix('CancelRestingOrder', { orderId: BigInt(orderId) },
        [meta(portfolio), meta(signer.publicKey, true, true), meta(book), meta(MATCHER, false), meta(registry, false)]);
    },
    liquidateIx(victimIndex, liquidatorIndex) {
      return rawIx(9, Buffer.from([1, 0]),
        [meta(traders[victimIndex].portfolio), meta(registry), meta(vault),
          meta(traders[liquidatorIndex].user.publicKey, false, true), meta(traders[liquidatorIndex].portfolio),
          meta(instrument, false), meta(oracle, false), meta(book), meta(MATCHER, false)], CORE);
    },
    async withdraw(index, amount, conversionPrice) {
      await freshOracle(conversionPrice);
      const walletBefore = (await runtime.account(traders[index].user.publicKey)).lamports;
      await runtime.send(`withdraw trader ${index}`, [ix('Withdraw', { amount: BigInt(amount) },
        [meta(traders[index].portfolio), meta(traders[index].user.publicKey, true, true), meta(vault),
          meta(registry, false), meta(instrument, false), meta(oracle, false)])], [payer, traders[index].user]);
      assert.equal((await runtime.account(traders[index].user.publicKey)).lamports,
        walletBefore + BigInt(amount), 'wallet receives exactly the withdrawal');
      events.push({ kind: 'withdraw', account: String(traders[index].user.publicKey),
        amount: String(amount), conversion_price: String(conversionPrice) });
    },
    // Submit an instruction that must reject with every listed account unchanged.
    async rejectUnchanged(label, instructions, signers, addresses, expectedCode) {
      const snapshot = async address => (await runtime.rpc('getAccountInfo',
        [String(address), { encoding: 'base64', commitment: 'confirmed' }])).value;
      const before = await Promise.all(addresses.map(snapshot));
      const latest = await runtime.connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: signers[0].publicKey, ...latest }).add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(runtime.report.checkpointB.rejections.length) + 1n }),
        ...instructions);
      tx.sign(...signers);
      const wire = tx.serialize().toString('base64');
      const simulation = (await runtime.rpc('simulateTransaction',
        [wire, { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }])).value;
      assert.ok(simulation.err, `${label}: simulation must reject`);
      if (expectedCode !== undefined) {
        assert.deepEqual(simulation.err, { InstructionError: [2, { Custom: expectedCode }] },
          `${label}: expected error ${expectedCode}`);
      }
      const signature = await runtime.rpc('sendTransaction', [wire, { encoding: 'base64', skipPreflight: true }]);
      const deadline = Date.now() + 15000;
      let status;
      do {
        status = (await runtime.rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])).value[0];
        if (status && ['confirmed', 'finalized'].includes(status.confirmationStatus)) break;
        assert.ok(Date.now() < deadline, `${label}: confirmation timed out`);
        await sleep(50);
      } while (true);
      assert.ok(status.err, `${label}: submitted transaction must reject`);
      const after = await Promise.all(addresses.map(snapshot));
      after.forEach((account, i) => assert.deepEqual(account, before[i], `${label}: account unchanged`));
      runtime.report.checkpointB.rejections.push({ label, signature, error: status.err });
      runtime.flushReport();
      return signature;
    },
  };
  return market;
}

// Exact entry as a Fraction string for the takeover adapter.
function entryFraction(portfolio) {
  const position = portfolio.positions[0];
  if (!position || portfolio.positionsLen === 0) return null;
  const den = position.entryDenominator;
  if (den === 0n) return String(position.entryVwap);
  return `${position.entryVwap * den + position.entryRemainder}/${den}`;
}

// Signed filled lots per user from decoded matcher results.
function signedFills(cleared) {
  const totals = new Map();
  for (const fill of cleared.fills) {
    const bidAuction = fill.auction === 0;
    const signed = bidAuction === fill.isMaker ? fill.qty : -fill.qty;
    const user = new PublicKey(fill.user).toBase58();
    totals.set(user, (totals.get(user) ?? 0n) + signed);
  }
  return totals;
}

test('P0-11: cancel racing clear, another user\'s order, direct matcher call', { timeout: 300000 }, async t => {
  const m = await startMarket(t, 20101);
  const M = await m.addTrader(1_000_000_000);
  const T = await m.addTrader(1_000_000_000);
  const evidence = {};
  // Cancel-first ordering: the cancelled order never fills; a replacement
  // order posted afterwards settles normally in the same batch.
  await m.freshOracle();
  const [cancelledId] = await m.post(M, { side: 0, isMaker: true, price: 100_000_000, qty: 100 });
  await m.post(T, { side: 1, isMaker: false, price: 100_000_000, qty: 100 });
  evidence.cancelFirst = await m.cancel(M, cancelledId);
  let state = await m.portfolioState(M);
  assert.equal(state.reservedCollateral, 0n, 'cancel releases the reservation');
  assert.ok(state.orders.every(o => o.remainingQty === 0n), 'cancel clears the order record');
  assert.equal((await m.bookOrders()).filter(o => new PublicKey(o.user).equals(m.traders[M].user.publicKey)).length, 0,
    'cancel removes the book order');
  const [replacementId] = await m.post(M, { side: 0, isMaker: true, price: 100_000_000, qty: 100 });
  assert.notEqual(replacementId, cancelledId);
  let cleared = await m.closeAndClear();
  assert.equal(cleared.numFills, 2);
  assert.ok(cleared.fills.every(f => f.orderId !== cancelledId), 'cancelled order produced no fill');
  assert.ok(cleared.fills.some(f => f.orderId === replacementId), 'replacement order filled');
  evidence.cancelFirstSettle = await m.settle([M, T], 100_000_000, cleared);
  await m.assertModel('P0-11 cancel-first batch settled');
  // Clear-first ordering: once the batch is Cleared the settlement lock
  // rejects the cancel (602) and the cleared fills settle exactly once.
  await m.freshOracle();
  await m.post(M, { side: 0, isMaker: true, price: 100_000_000, qty: 100 });
  await m.post(T, { side: 1, isMaker: false, price: 100_000_000, qty: 100 });
  cleared = await m.closeAndClear();
  assert.equal(cleared.numFills, 2);
  const [liveId] = (await m.portfolioState(M)).orders.filter(o => o.remainingQty > 0n).map(o => o.orderId);
  evidence.clearFirstCancel = await m.rejectUnchanged('P0-11 cancel after clear rejected',
    [m.cancelIx(M, liveId)], [m.payer, m.traders[M].user],
    [m.traders[M].portfolio, m.book, m.batchPda(m.batchId), m.registry], 602);
  evidence.clearFirstSettle = await m.settle([M, T], 100_000_000, cleared);
  const model = await m.assertModel('P0-11 clear-first batch settled');
  assert.equal(model.positions[String(m.traders[M].user.publicKey)].qty, '200', 'both batches filled the maker long');
  // Cancelling another user's order rejects, whichever portfolio is named.
  await m.freshOracle();
  const [victimOrder] = await m.post(M, { side: 0, isMaker: true, price: 100_000_000, qty: 100 });
  evidence.otherUser = await m.rejectUnchanged('P0-11 cancel another user\'s portfolio',
    [m.cancelIx(M, victimOrder, { signer: m.traders[T].user })], [m.payer, m.traders[T].user],
    [m.traders[M].portfolio, m.book], 7);
  evidence.otherOrder = await m.rejectUnchanged('P0-11 cancel another user\'s order id',
    [m.cancelIx(T, victimOrder)], [m.payer, m.traders[T].user],
    [m.traders[T].portfolio, m.traders[M].portfolio, m.book], 201);
  // Direct matcher calls with an arbitrary user reject: only core's
  // registry PDA signature authorizes matcher book mutations.
  const cancelData = Buffer.concat([m.traders[M].user.publicKey.toBuffer(), u64(victimOrder)]);
  evidence.directMatcher = await m.rejectUnchanged('P0-11 direct matcher CancelResting',
    [rawIx(1, cancelData, [meta(m.registry, false), meta(m.traders[M].user.publicKey, false, true),
      meta(m.book), meta(m.resultsPda(m.batchId))], MATCHER)],
    [m.payer, m.traders[M].user], [m.book, m.traders[M].portfolio]);
  const settledData = Buffer.concat([Buffer.from([1]), u64(victimOrder)]);
  evidence.directSettled = await m.rejectUnchanged('P0-11 direct matcher CancelSettledOrders',
    [rawIx(9, settledData, [meta(m.registry, false), meta(m.book)], MATCHER)],
    [m.payer], [m.book, m.traders[M].portfolio]);
  await m.cancel(M, victimOrder);
  m.runtime.report.checkpointB.p0_11 = evidence;
  m.runtime.flushReport();
});

test('P0-17: liquidation rejects healthy and health=0, takeover in 25% steps', { timeout: 300000 }, async t => {
  const m = await startMarket(t, 20111);
  const V0 = await m.addTrader(211_111_112);
  const C = await m.addTrader(1_000_000_000);
  const V1 = await m.addTrader(1_000_000_000);
  const L = await m.addTrader(1_000_000_000);
  const L2 = await m.addTrader(60_000_000);
  const evidence = {};
  // V0: long 1000 @ $100; at $90 the model health is exactly 0 (see below).
  await m.freshOracle();
  await m.post(V0, { side: 0, isMaker: true, price: 100_000_000, qty: 1000 });
  await m.post(C, { side: 1, isMaker: false, price: 100_000_000, qty: 1000 });
  await m.settle([V0, C], 100_000_000, await m.closeAndClear());
  await m.assertModel('P0-17 health victim opened');
  let v0 = await m.portfolioState(V0);
  assert.ok(modelHealth({ collateral: v0.equity, qty: 1000, entry: entryFraction(v0), price: 100_000_000 }) > 0n,
    'independent model: V0 healthy at $100');
  evidence.healthy = await m.rejectUnchanged('P0-17 healthy liquidation rejected',
    [m.liquidateIx(V0, L)], [m.payer, m.traders[L].user],
    [m.traders[V0].portfolio, m.traders[L].portfolio, m.vault, m.registry, m.book], 110);
  // At $90 the same snapshot has maintenance health exactly 0.
  await m.freshOracle(90_000_000);
  v0 = await m.portfolioState(V0);
  assert.equal(modelHealth({ collateral: v0.equity, qty: 1000, entry: entryFraction(v0), price: 90_000_000 }), 0n,
    'independent model: V0 health exactly 0');
  evidence.healthZero = await m.rejectUnchanged('P0-17 health=0 liquidation rejected',
    [m.liquidateIx(V0, L)], [m.payer, m.traders[L].user],
    [m.traders[V0].portfolio, m.traders[L].portfolio, m.vault, m.registry, m.book], 110);
  // V1: long 1000 @ $100, withdraw to 250M, rest a 50-lot buy, drop to $85.
  await m.freshOracle();
  await m.post(V1, { side: 0, isMaker: true, price: 100_000_000, qty: 1000 });
  await m.post(C, { side: 1, isMaker: false, price: 100_000_000, qty: 1000 });
  await m.settle([V1, C], 100_000_000, await m.closeAndClear());
  await m.assertModel('P0-17 unhealthy victim opened');
  await m.withdraw(V1, 750_000_000, 100_000_000);
  await m.assertModel('P0-17 victim withdrew to 250M');
  await m.freshOracle();
  const [restingId] = (await m.post(V1, { side: 0, isMaker: true, price: 100_000_000, qty: 50 }))
    .filter(id => id !== undefined);
  const victimBefore = await m.portfolioState(V1);
  assert.equal(victimBefore.reservedCollateral, 10_025_000n, 'resting buy reserves IM plus fee');
  assert.ok((await m.bookOrders()).some(o => new PublicKey(o.user).equals(m.traders[V1].user.publicKey)),
    'victim resting order is on the book');
  const liquidatorBefore = await m.portfolioState(L);
  const vaultBefore = await m.runtime.account(m.vault);
  const fundBefore = (await m.vaultState()).insuranceFund;
  assert.ok(modelHealth({ collateral: victimBefore.equity, qty: 1000, entry: entryFraction(victimBefore), price: 85_000_000 }) < 0n,
    'independent model: V1 unhealthy at $85');
  // An underfunded liquidator fails the per-step initial-margin check on
  // the second quarter; the whole takeover (and its cancellation) reverts.
  await m.freshOracle(85_000_000);
  evidence.underfunded = await m.rejectUnchanged('P0-17 underfunded liquidator rejected',
    [m.liquidateIx(V1, L2)], [m.payer, m.traders[L2].user],
    [m.traders[V1].portfolio, m.traders[L2].portfolio, m.vault, m.book, m.registry], 4);
  // Funded takeover: expectations from the independent takeover scenario.
  const expected = runPython('takeover_scenario.py', {
    fund: String(fundBefore),
    collateral: {
      [String(m.traders[V1].user.publicKey)]: String(victimBefore.equity),
      [String(m.traders[L].user.publicKey)]: String(liquidatorBefore.equity),
    },
    positions: {
      [String(m.traders[V1].user.publicKey)]: { qty: '1000', entry: entryFraction(victimBefore) },
    },
    reservations: { [String(m.traders[V1].user.publicKey)]: String(victimBefore.reservedCollateral) },
    account: String(m.traders[V1].user.publicKey),
    liquidator: String(m.traders[L].user.publicKey),
    price: '85000000',
  });
  assert.deepEqual(expected.steps, [250, 187], 'independent model: two 25% steps restore health');
  evidence.takeover = await m.runtime.send('P0-17 takeover', [m.liquidateIx(V1, L)], [m.payer, m.traders[L].user]);
  const victimAfter = await m.portfolioState(V1);
  const liquidatorAfter = await m.portfolioState(L);
  const vaultAfter = await m.runtime.account(m.vault);
  const vKey = String(m.traders[V1].user.publicKey);
  const lKey = String(m.traders[L].user.publicKey);
  assert.equal(String(victimAfter.equity), expected.collateral[vKey], 'victim equity matches model');
  assert.equal(String(liquidatorAfter.equity), expected.collateral[lKey], 'liquidator equity matches model (1% penalty)');
  assert.equal(String(victimAfter.positions[0].qty), expected.positions[vKey].qty, 'victim keeps 563 lots');
  assert.equal(String(liquidatorAfter.positions[0].qty), expected.positions[lKey].qty, 'liquidator takes 437 lots');
  assert.equal(String((await m.vaultState()).insuranceFund), expected.fund, 'fund matches model (1% penalty share)');
  assert.equal(String((await m.vaultState()).uncoveredBadDebt), expected.debt, 'no uncovered debt');
  assert.equal(vaultAfter.lamports, vaultBefore.lamports, 'value conserved: vault lamports unchanged');
  assert.equal(victimAfter.reservedCollateral, 0n, 'victim reservations cancelled');
  assert.ok(victimAfter.orders.every(o => o.remainingQty === 0n), 'victim order records cancelled');
  assert.equal((await m.bookOrders()).filter(o => new PublicKey(o.user).equals(m.traders[V1].user.publicKey)).length, 0,
    'victim book orders cancelled');
  evidence.steps = expected.steps;
  evidence.restingOrderId = String(restingId);
  m.runtime.report.checkpointB.p0_17 = evidence;
  m.runtime.flushReport();
});

test('P0-19 stress drift and P0-18 within-fund bad debt', { timeout: 300000 }, async t => {
  const m = await startMarket(t, 20121);
  const A = await m.addTrader(1_000_000_000);
  const B = await m.addTrader(1_000_000_000);
  const C = await m.addTrader(1_000_000_000);
  const V = await m.addTrader(1_000_000_000);
  const W = await m.addTrader(1_000_000_000);
  const evidence = { p0_19: {}, p0_18: {} };
  // One stress direction: open at $100 (conversion `first`), close the
  // winner leg at $110 (conversion `first`), close the loser leg at $110
  // (conversion `second`). Taker fees are separated through the model's own
  // fee ledger, leaving the exact feeless conversion drift.
  const stressRun = async (label, first, second, expectedDrift) => {
    const before = m.model();
    const fundBefore = BigInt(before.fund);
    const feesBefore = Object.values(before.fees).reduce((sum, v) => sum + BigInt(v), 0n);
    await m.freshOracle();
    await m.post(A, { side: 0, isMaker: true, price: 100_000_000, qty: 100 });
    await m.post(B, { side: 1, isMaker: false, price: 100_000_000, qty: 100 });
    await m.settle([A, B], first, await m.closeAndClear());
    await m.freshOracle();
    await m.post(C, { side: 0, isMaker: true, price: 110_000_000, qty: 100 });
    await m.post(A, { side: 1, isMaker: false, price: 110_000_000, qty: 100 });
    await m.settle([C, A], first, await m.closeAndClear());
    await m.freshOracle();
    await m.post(B, { side: 0, isMaker: true, price: 110_000_000, qty: 100 });
    await m.post(C, { side: 1, isMaker: false, price: 110_000_000, qty: 100 });
    await m.settle([B, C], second, await m.closeAndClear());
    const model = await m.assertModel(label);
    const feesDelta = Object.values(model.fees).reduce((sum, v) => sum + BigInt(v), 0n) - feesBefore;
    const drift = BigInt(model.fund) - fundBefore - feesDelta;
    assert.equal(drift, BigInt(expectedDrift), `${label}: exact conversion drift to the fund`);
    return { drift: String(drift), fund: model.fund };
  };
  evidence.p0_19.up = await stressRun('P0-19 $110 then $120', 110_000_000, 120_000_000, -757_575);
  evidence.p0_19.down = await stressRun('P0-19 $120 then $110', 120_000_000, 110_000_000, 757_577);
  // P0-18: the loser loses 4 SOL of lamport value against 0.2 SOL of
  // collateral; the 20 SOL fund absorbs the shortfall with no debt/pause.
  await m.freshOracle();
  await m.post(V, { side: 0, isMaker: true, price: 100_000_000, qty: 1000 });
  await m.post(W, { side: 1, isMaker: false, price: 100_000_000, qty: 1000 });
  await m.settle([V, W], 100_000_000, await m.closeAndClear());
  // Leave 1M of free collateral: the reduce-only close still reserves its
  // worst-case fee, which a maxed-out withdrawal would make unpostable.
  await m.withdraw(V, 799_000_000, 100_000_000);
  await m.assertModel('P0-18 loser withdrew to 0.201 SOL');
  const fundBeforeClose = (await m.vaultState()).insuranceFund;
  await m.freshOracle();
  await m.post(V, { side: 1, isMaker: true, price: 20_000_000, qty: 1000, reduceOnly: true });
  await m.post(W, { side: 0, isMaker: false, price: 20_000_000, qty: 1000, reduceOnly: true });
  evidence.p0_18.settle = await m.settle([V, W], 20_000_000, await m.closeAndClear());
  const model = await m.assertModel('P0-18 bad debt absorbed by the fund');
  assert.equal(model.debt, '0', 'no uncovered bad debt: the fund absorbed the loss');
  assert.equal(model.flags, 0, 'no pause flags');
  assert.equal(model.collateral[String(m.traders[V].user.publicKey)], '0', 'loser collected to zero');
  assert.ok(BigInt(model.fund) < fundBeforeClose, 'fund paid the winner shortfall');
  assert.ok(BigInt(model.fund) > 0n, 'fund not exhausted (distinct from P0-21)');
  evidence.p0_18.fundBeforeClose = String(fundBeforeClose);
  evidence.p0_18.fundAfter = model.fund;
  m.runtime.report.checkpointB.p0_19 = evidence.p0_19;
  m.runtime.report.checkpointB.p0_18 = evidence.p0_18;
  m.runtime.flushReport();
});

test('P0-26 capped batch, P1-2 DFBA paper vectors, P1-3 adversarial at cap', { timeout: 300000 }, async t => {
  const m = await startMarket(t, 20131);
  const evidence = { p0_26: {}, p1_2: {}, p1_3: {} };
  const add = () => m.addTrader(1_000_000_000);
  // P1-2 vector 1: identical-price pro-rata, equal sizes (paper allocation).
  const M1 = await add(), M2 = await add(), T1 = await add();
  await m.freshOracle();
  await m.post(M1, { side: 1, isMaker: true, price: 100_000_000, qty: 100 });
  await m.post(M2, { side: 1, isMaker: true, price: 100_000_000, qty: 100 });
  await m.post(T1, { side: 0, isMaker: false, price: 100_000_000, qty: 100 });
  let cleared = await m.closeAndClear();
  let fills = signedFills(cleared);
  assert.equal(fills.get(String(m.traders[M1].user.publicKey)), -50n, 'pro-rata maker 1 fills 50');
  assert.equal(fills.get(String(m.traders[M2].user.publicKey)), -50n, 'pro-rata maker 2 fills 50');
  assert.equal(fills.get(String(m.traders[T1].user.publicKey)), 100n, 'taker fills in full');
  assert.equal(cleared.askClearingPrice, 100_000_000n, 'uniform clearing price');
  evidence.p1_2.equalProRata = { settle: await m.settle([M1, M2, T1], 100_000_000, cleared) };
  await m.assertModel('P1-2 equal pro-rata settled');
  for (const idx of [M1, M2]) {
    for (const o of (await m.portfolioState(idx)).orders.filter(x => x.remainingQty > 0n)) await m.cancel(idx, o.orderId);
  }
  // P1-2 vector 2: identical-price pro-rata dust rounds down deterministically.
  const M3 = await add(), M4 = await add(), M5 = await add(), T2 = await add();
  await m.freshOracle();
  for (const idx of [M3, M4, M5]) await m.post(idx, { side: 1, isMaker: true, price: 100_000_000, qty: 10 });
  await m.post(T2, { side: 0, isMaker: false, price: 100_000_000, qty: 10 });
  cleared = await m.closeAndClear();
  fills = signedFills(cleared);
  for (const idx of [M3, M4, M5]) {
    assert.equal(fills.get(String(m.traders[idx].user.publicKey)), -3n, 'dust vector maker fills 3');
  }
  assert.equal(fills.get(String(m.traders[T2].user.publicKey)), 9n, 'taker fills 9 of 10');
  assert.equal(10n - fills.get(String(m.traders[T2].user.publicKey)), 1n,
    'one lot of deterministic dust stays unfilled');
  evidence.p1_2.dust = { settle: await m.settle([M3, M4, M5, T2], 100_000_000, cleared) };
  await m.assertModel('P1-2 dust settled');
  for (const idx of [M3, M4, M5, T2]) {
    for (const o of (await m.portfolioState(idx)).orders.filter(x => x.remainingQty > 0n)) await m.cancel(idx, o.orderId);
  }
  // P1-2 vector 3: identical-price pro-rata with unequal sizes (25/75).
  const M6 = await add(), M7 = await add(), T3 = await add();
  await m.freshOracle();
  await m.post(M6, { side: 1, isMaker: true, price: 100_000_000, qty: 100 });
  await m.post(M7, { side: 1, isMaker: true, price: 100_000_000, qty: 300 });
  await m.post(T3, { side: 0, isMaker: false, price: 100_000_000, qty: 100 });
  cleared = await m.closeAndClear();
  fills = signedFills(cleared);
  assert.equal(fills.get(String(m.traders[M6].user.publicKey)), -25n, 'pro-rata 100/400 fills 25');
  assert.equal(fills.get(String(m.traders[M7].user.publicKey)), -75n, 'pro-rata 300/400 fills 75');
  assert.equal(fills.get(String(m.traders[T3].user.publicKey)), 100n);
  evidence.p1_2.unequalProRata = { settle: await m.settle([M6, M7, T3], 100_000_000, cleared) };
  await m.assertModel('P1-2 unequal pro-rata settled');
  for (const idx of [M6, M7]) {
    for (const o of (await m.portfolioState(idx)).orders.filter(x => x.remainingQty > 0n)) await m.cancel(idx, o.orderId);
  }
  // P0-26: twelve orders from twelve portfolios fill the results cap and
  // every involved portfolio settles in a single transaction.
  const capped = [];
  for (let i = 0; i < 12; i++) capped.push(await add());
  await m.freshOracle();
  for (let i = 0; i < 6; i++) await m.post(capped[i], { side: 0, isMaker: true, price: 100_000_000, qty: 10 });
  for (let i = 6; i < 12; i++) await m.post(capped[i], { side: 1, isMaker: false, price: 100_000_000, qty: 10 });
  cleared = await m.closeAndClear();
  assert.equal(cleared.numFills, 12, 'batch fills the 12-fill results cap');
  assert.equal(cleared.matchedBidQty, 60n, 'all 60 lots matched');
  evidence.p0_26.settle = await m.settle(capped, 100_000_000, cleared);
  const model = await m.assertModel('P0-26 capped batch settled in one transaction');
  for (let i = 0; i < 12; i++) {
    assert.equal(model.positions[String(m.traders[capped[i]].user.publicKey)].qty, i < 6 ? '10' : '-10',
      `capped trader ${i} settled`);
  }
  assert.equal(decodeResults((await m.runtime.account(m.resultsPda(m.batchId - 1))).data).spent, true,
    'capped results spent after the single settlement');
  assert.equal(decodeAccount('Batch', (await m.runtime.account(m.batchPda(m.batchId - 1))).data).status, 3,
    'capped batch Settled');
  // P1-3: adversarial and overflow posts against a portfolio at the
  // 12-order cap all reject unchanged; freeing a slot restores posting.
  const ADV = await add();
  await m.freshOracle();
  for (let i = 0; i < 12; i++) await m.post(ADV, { side: 0, isMaker: true, price: 100_000_000, qty: 1 });
  assert.equal((await m.portfolioState(ADV)).orders.filter(o => o.remainingQty > 0n).length, 12, 'ADV at the order cap');
  const advAddresses = [m.traders[ADV].portfolio, m.book, m.batchPda(m.batchId)];
  const advPost = params => ix('PostOrder', params,
    [meta(m.traders[ADV].portfolio), meta(m.traders[ADV].user.publicKey, true, true), meta(m.batchPda(m.batchId)),
      meta(m.registry, false), meta(m.book), meta(MATCHER, false), meta(m.instrument, false), meta(m.oracle, false), meta(m.vault, false)]);
  const advSigners = [m.payer, m.traders[ADV].user];
  evidence.p1_3.thirteenth = await m.rejectUnchanged('P1-3 thirteenth live order',
    [advPost({ side: 0, isMaker: true, price: 100_000_000n, qty: 1n, instrumentId: 0, reduceOnly: false })], advSigners, advAddresses, 212);
  evidence.p1_3.zeroQty = await m.rejectUnchanged('P1-3 zero quantity',
    [advPost({ side: 0, isMaker: true, price: 100_000_000n, qty: 0n, instrumentId: 0, reduceOnly: false })], advSigners, advAddresses, 211);
  evidence.p1_3.zeroPrice = await m.rejectUnchanged('P1-3 zero price',
    [advPost({ side: 0, isMaker: true, price: 0n, qty: 1n, instrumentId: 0, reduceOnly: false })], advSigners, advAddresses, 210);
  evidence.p1_3.negativePrice = await m.rejectUnchanged('P1-3 negative price',
    [advPost({ side: 0, isMaker: true, price: -5n, qty: 1n, instrumentId: 0, reduceOnly: false })], advSigners, advAddresses, 210);
  evidence.p1_3.badSide = await m.rejectUnchanged('P1-3 invalid side',
    [advPost({ side: 2, isMaker: true, price: 100_000_000n, qty: 1n, instrumentId: 0, reduceOnly: false })], advSigners, advAddresses, 300);
  evidence.p1_3.hugeQty = await m.rejectUnchanged('P1-3 quantity above i64 max',
    [advPost({ side: 0, isMaker: true, price: 100_000_000n, qty: 1n << 63n, instrumentId: 0, reduceOnly: false })], advSigners, advAddresses, 608);
  evidence.p1_3.hugePrice = await m.rejectUnchanged('P1-3 price at i64 max',
    [advPost({ side: 0, isMaker: true, price: (1n << 63n) - 1n, qty: 1000n, instrumentId: 0, reduceOnly: false })], advSigners, advAddresses, 4);
  const [firstOrder] = (await m.portfolioState(ADV)).orders.filter(o => o.remainingQty > 0n).map(o => o.orderId);
  await m.cancel(ADV, firstOrder);
  await m.post(ADV, { side: 0, isMaker: true, price: 100_000_000, qty: 1 });
  assert.equal((await m.portfolioState(ADV)).orders.filter(o => o.remainingQty > 0n).length, 12,
    'posting works again after freeing a slot: cap state not corrupted');
  m.runtime.report.checkpointB.p0_26 = evidence.p0_26;
  m.runtime.report.checkpointB.p1_2 = evidence.p1_2;
  m.runtime.report.checkpointB.p1_3 = evidence.p1_3;
  m.runtime.flushReport();
});
