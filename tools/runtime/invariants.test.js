'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair } = require('@solana/web3.js');
const { InvariantChecker, audit, readOnly } = require('./invariants');
const { market, encodeAccount, CORE } = require('./invariant-fixtures');

const tx = { label: 'fixture transaction', signature: 'FixtureSig111' };
const checker = m => new InvariantChecker({ rpc: (method, params) => m.chain.rpc(method, params), ...m.programs });
const rejectsWith = (promise, invariant) => assert.rejects(promise, error => {
  assert.equal(error.name, 'InvariantViolation');
  assert.ok(error.violations.some(v => v.invariant === invariant), error.message);
  assert.match(error.message, new RegExp(`invariant "${invariant}" violated after transaction "fixture transaction" \\(FixtureSig111\\)`));
  return true;
});

test('a consistent market passes every evaluable invariant in a read-only audit', async () => {
  const m = market();
  const report = await audit((method, params) => m.chain.rpc(method, params), m.programs);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.invariants.map(i => i.status), ['pass', 'pass', 'pass', 'pass', 'not evaluable from one snapshot', 'pass']);
  assert.deepEqual(report.accounts.portfolios, 2);
  assert.ok(m.chain.calls.every(method => /^get/.test(method)), m.chain.calls.join());
});

test('the reader refuses any method that could send a transaction', async () => {
  const rpc = readOnly(async () => 'sent');
  assert.throws(() => rpc('sendTransaction', ['AA==']), /refuses non-read RPC method sendTransaction/);
  assert.throws(() => rpc('requestAirdrop', []), /refuses/);
});

test('vault balance: one lamport of under-backing fails', async () => {
  const m = market(); m.store({ vaultLamports: -1 });
  await rejectsWith(checker(m).after(null, tx), 'vault balance');
});

test('vault balance: donated surplus lamports are tolerated', async () => {
  const m = market(); m.store({ vaultLamports: 777 });
  await checker(m).after(null, tx);
});

test('vault balance: recorded collateral must equal total portfolio equity', async () => {
  const m = market(); m.state.vault.balance = 3_000_001n; m.store({ vaultLamports: -1 });
  await rejectsWith(checker(m).after(null, tx), 'vault balance');
});

test('per-auction signed base quantity: unbalanced fills fail', async () => {
  const m = market(); m.state.results[1].fills[1].qty = 2; m.store();
  await rejectsWith(checker(m).after(null, tx), 'per-auction signed base quantity sums to 0');
});

test('per-auction signed base quantity: settled positions must net to zero', async () => {
  const m = market(); m.state.portfolios[m.addresses.taker].positions[0].qty = -4n;
  m.state.vault.openInterestShort = 4n; m.store();
  await rejectsWith(checker(m).after(null, tx), 'per-auction signed base quantity sums to 0');
});

test('fills never exceed eligible submitted size: oversized fill fails', async () => {
  const m = market();
  m.state.results[1].fills.forEach(f => { f.qty = 4; });
  m.store();
  await rejectsWith(checker(m).after(null, tx), 'fills never exceed eligible submitted size');
});

test('fills never exceed eligible submitted size: fill without a live order fails', async () => {
  const m = market(); m.state.portfolios[m.addresses.taker].orders[0].remainingQty = 0n; m.store();
  await rejectsWith(checker(m).after(null, tx), 'fills never exceed eligible submitted size');
});

test('each receipt applied exactly once: a cleared batch with spent results fails', async () => {
  const m = market(); m.state.results[1].spent = true; m.store();
  await rejectsWith(checker(m).after(null, tx), 'each receipt applied exactly once');
});

test('each receipt applied exactly once: spent results may never become unspent', async () => {
  const m = market(); const c = checker(m);
  const before = await c.before();
  m.state.batches[0].status = 4; m.state.results[0].spent = false; m.store();
  await rejectsWith(c.after(before, tx), 'each receipt applied exactly once');
});

// Settles batch 1 in the fixture: the maker's reduce-only sell of 3 lots against a long of 5.
async function settle(makerQty, takerQty) {
  const m = market(); const c = checker(m);
  const before = await c.before();
  m.state.batches[1].status = 3; m.state.results[1].spent = true;
  m.state.portfolios[m.addresses.maker].positions[0].qty = makerQty;
  m.state.portfolios[m.addresses.taker].positions[0].qty = takerQty;
  m.state.portfolios[m.addresses.maker].orders[0].remainingQty = 0n;
  m.state.portfolios[m.addresses.taker].orders[0].remainingQty = 0n;
  // Literal scenario: both sides hold the same size after settlement.
  m.state.vault.openInterestLong = m.state.vault.openInterestShort = takerQty > 0n ? takerQty : -takerQty;
  m.store();
  return c.after(before, tx);
}

test('a valid reduce never increases exposure: a reduce-only settlement that reduces passes', async () => {
  await settle(2n, -2n);
});

test('a valid reduce never increases exposure: a reduce-only fill that flips fails', async () => {
  await rejectsWith(settle(-1n, 1n), 'a valid reduce never increases exposure');
});

test('no withdrawable balance is negative: a withdrawal leaving negative withdrawable fails', async () => {
  const m = market(); const c = checker(m);
  const before = await c.before();
  const p = m.state.portfolios[m.addresses.taker];
  p.principal = 900_000n; p.equity = 900_000n; p.freeCollateral = -1n;
  m.state.vault.balance = 2_900_000n; m.store({ vaultLamports: 0 });
  await rejectsWith(c.after(before, tx), 'no withdrawable balance is negative');
});

test('no withdrawable balance is negative: an adverse mark alone is liquidation territory, not a violation', async () => {
  const m = market(); const c = checker(m);
  const before = await c.before();
  m.state.portfolios[m.addresses.taker].freeCollateral = -50_000n; m.store();
  await c.after(before, tx);
});

test('no withdrawable balance is negative: a flat portfolio with negative withdrawable fails', async () => {
  const m = market(); const flat = Keypair.generate().publicKey.toBase58();
  m.state.portfolios[flat] = { user: flat, equity: 0n, freeCollateral: -1n };
  m.store();
  await rejectsWith(checker(m).after(null, tx), 'no withdrawable balance is negative');
});

test('zeroed storage and forged non-PDA protocol accounts are not counted as protocol state', async () => {
  const m = market();
  m.chain.set(Keypair.generate().publicKey, { data: Buffer.alloc(2848) });
  m.chain.set(Keypair.generate().publicKey, { owner: CORE, data: encodeAccount('Portfolio', {
    user: m.addresses.maker, equity: 99n }) });
  const report = await audit((method, params) => m.chain.rpc(method, params), m.programs);
  assert.deepEqual(report.violations, []);
  assert.equal(report.accounts.portfolios, 2);
});

test('malformed protocol accounts fail loudly and name the account', async () => {
  const m = market();
  const bad = encodeAccount('Portfolio', { user: m.addresses.maker }); bad[1] = 99;
  m.chain.set(m.addresses.makerPortfolio, { data: bad });
  await assert.rejects(checker(m).after(null, tx), new RegExp(`${m.addresses.makerPortfolio}: Portfolio: unsupported layout version`));
});
