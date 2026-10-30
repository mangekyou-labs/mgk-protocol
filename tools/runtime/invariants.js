'use strict';
// The six gate invariants (issue #26). Observes protocol state only through
// read-only JSON-RPC and the SDK layout decoders; it never reproduces program
// arithmetic beyond sums, comparisons and PDA derivation.
const { PublicKey } = require('@solana/web3.js');
const { layouts, decodeAccount, decodeResults } = require('../../mgk-frontend/packages/layout');

const INVARIANTS = Object.freeze({
  vault: 'vault balance',
  auction: 'per-auction signed base quantity sums to 0',
  fills: 'fills never exceed eligible submitted size',
  receipts: 'each receipt applied exactly once',
  reduce: 'a valid reduce never increases exposure',
  withdrawable: 'no withdrawable balance is negative',
});

const READ_METHODS = new Set(['getProgramAccounts', 'getMultipleAccounts', 'getAccountInfo',
  'getMinimumBalanceForRentExemption', 'getSlot']);
const BATCH_SETTLED = 3, BATCH_CLEARED = 4;

// Wrap any JSON-RPC transport so that only state reads can pass through it.
function readOnly(rpc) {
  return (method, params = []) => {
    if (!READ_METHODS.has(method)) throw new Error(`invariant reader refuses non-read RPC method ${method}`);
    return rpc(method, params);
  };
}

class InvariantViolation extends Error {
  constructor(violations, transaction) {
    const where = transaction ? ` after transaction "${transaction.label}"` +
      (transaction.signature ? ` (${transaction.signature})` : '') : '';
    super(violations.map(v => `invariant "${v.invariant}" violated${where}: ${v.message}`).join('\n'));
    this.name = 'InvariantViolation';
    this.invariant = violations[0].invariant;
    this.transaction = transaction;
    this.violations = violations;
  }
}

const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, new PublicKey(program))[0].toBase58();
const key = bytes => new PublicKey(bytes).toBase58();
const abs = value => value < 0n ? -value : value;

function account(address, value) {
  if (!value) return null;
  if (!Number.isSafeInteger(value.lamports)) throw new Error(`${address}: lamports exceed safe JSON integer range`);
  if (!Array.isArray(value.data) || value.data[1] !== 'base64') throw new Error(`${address}: base64 data required`);
  return { address, owner: value.owner, lamports: BigInt(value.lamports), data: Buffer.from(value.data[0], 'base64') };
}

function decode(name, item) {
  try { return name === 'BatchResults' ? decodeResults(item.data) : decodeAccount(name, item.data); }
  catch (error) { throw new Error(`${item.address}: ${error.message}`, { cause: error }); }
}

async function multiple(rpc, addresses) {
  const found = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const result = await rpc('getMultipleAccounts', [chunk, { encoding: 'base64', commitment: 'confirmed' }]);
    found.push(...result.value.map((value, index) => account(chunk[index], value)));
  }
  return found;
}

async function programAccounts(rpc, program, size) {
  const result = await rpc('getProgramAccounts', [program, { encoding: 'base64', commitment: 'confirmed',
    filters: [{ dataSize: size }] }]);
  const list = Array.isArray(result) ? result : result.value;
  return list.map(({ pubkey, account: value }) => account(pubkey, value));
}

// Read every canonical protocol account. Zeroed (uninitialized) storage and
// accounts at non-canonical addresses are not protocol state and are ignored.
async function readProtocolState(rpc, { core, matcher }) {
  rpc = readOnly(rpc);
  core = String(core); matcher = String(matcher);
  const owned = item => item && item.owner === core;
  const snapshot = { vault: null, portfolios: new Map(), batches: new Map(), results: new Map() };
  const [vault] = await multiple(rpc, [pda([Buffer.from('vault')], core)]);
  if (owned(vault) && vault.data[0] !== 0) {
    const rent = await rpc('getMinimumBalanceForRentExemption', [vault.data.length]);
    snapshot.vault = { ...vault, rent: BigInt(rent), state: decode('Vault', vault) };
  }
  for (const item of await programAccounts(rpc, core, layouts.Portfolio.size)) {
    if (item.data[0] !== layouts.Portfolio.discriminator) continue;
    const state = decode('Portfolio', item);
    if (pda([Buffer.from('portfolio'), state.user], core) !== item.address) continue;
    if (state.positionsLen > state.positions.length) throw new Error(`${item.address}: invalid position count`);
    snapshot.portfolios.set(item.address, { ...item, state });
  }
  for (const item of await programAccounts(rpc, core, layouts.Batch.size)) {
    if (item.data[0] !== layouts.Batch.discriminator) continue;
    const state = decode('Batch', item);
    if (pda([Buffer.from('batch'), u64(state.batchId)], core) !== item.address) continue;
    snapshot.batches.set(state.batchId, { ...item, state });
  }
  const ids = [...snapshot.batches.keys()];
  const results = await multiple(rpc, ids.map(id => pda([Buffer.from('results'), u64(id)], matcher)));
  results.forEach((item, index) => {
    if (item && item.owner === matcher && item.data[0] !== 0) {
      snapshot.results.set(ids[index], { ...item, state: decode('BatchResults', item) });
    }
  });
  snapshot.portfolioOf = user => snapshot.portfolios.get(pda([Buffer.from('portfolio'), user], core));
  return snapshot;
}

function positions(portfolio) {
  const map = new Map();
  for (const p of portfolio.state.positions.slice(0, portfolio.state.positionsLen)) {
    if (p.qty !== 0n) map.set(p.instrumentId, (map.get(p.instrumentId) ?? 0n) + p.qty);
  }
  return map;
}
const liveOrders = portfolio => portfolio.state.orders.filter(order => order.remainingQty !== 0n);
// Auction 0 makers and auction 1 takers buy; the opposite roles sell.
const buys = fill => (fill.auction === 0) === fill.isMaker;

function checkSnapshot(s) {
  const violations = [];
  const fail = (invariant, message) => violations.push({ invariant, message });
  const portfolios = [...s.portfolios.values()];

  if (s.vault) {
    const { lamports, rent, state, address } = s.vault;
    if (lamports + state.uncoveredBadDebt < rent + BigInt(state.balance) + state.insuranceFund) {
      fail(INVARIANTS.vault, `vault ${address} lamports ${lamports} + uncovered bad debt ${state.uncoveredBadDebt}` +
        ` < rent ${rent} + collateral ${state.balance} + insurance fund ${state.insuranceFund}`);
    }
    const equity = portfolios.reduce((sum, p) => sum + p.state.equity, 0n);
    if (equity !== BigInt(state.balance)) {
      fail(INVARIANTS.vault, `vault collateral ${state.balance} != sum of portfolio equity ${equity}`);
    }
    let long = 0n, short = 0n;
    for (const p of portfolios) for (const qty of positions(p).values()) qty > 0n ? long += qty : short -= qty;
    if (long !== state.openInterestLong || short !== state.openInterestShort) {
      fail(INVARIANTS.auction, `vault open interest long ${state.openInterestLong}/short ${state.openInterestShort}` +
        ` != settled positions long ${long}/short ${short}`);
    }
  }

  const net = new Map();
  for (const p of portfolios) for (const [instrument, qty] of positions(p)) net.set(instrument, (net.get(instrument) ?? 0n) + qty);
  for (const [instrument, qty] of net) {
    if (qty !== 0n) fail(INVARIANTS.auction, `instrument ${instrument} settled positions sum to ${qty}`);
  }
  for (const [id, results] of s.results) {
    for (const auction of [0, 1]) {
      const sum = results.state.fills.filter(f => f.auction === auction)
        .reduce((total, f) => total + (buys(f) ? f.qty : -f.qty), 0n);
      if (sum !== 0n) fail(INVARIANTS.auction, `batch ${id} results ${results.address} auction ${auction} signed base quantity sums to ${sum}`);
    }
  }

  for (const [id, batch] of s.batches) {
    const status = batch.state.status, results = s.results.get(id);
    if (status !== BATCH_CLEARED && status !== BATCH_SETTLED) continue;
    if (!results) { fail(INVARIANTS.receipts, `batch ${id} has status ${status} but no results receipt`); continue; }
    if (results.state.batchId !== id) fail(INVARIANTS.receipts, `results ${results.address} records batch ${results.state.batchId}, expected ${id}`);
    if (results.state.spent !== (status === BATCH_SETTLED)) {
      fail(INVARIANTS.receipts, `batch ${id} status ${status} with results ${results.state.spent ? 'spent' : 'unspent'}`);
    }
    if (status !== BATCH_CLEARED || results.state.spent) continue;
    const seen = new Set();
    for (const fill of results.state.fills) {
      const user = key(fill.user), tag = `batch ${id} fill for ${user} order ${fill.orderId}`;
      if (seen.has(`${user}:${fill.orderId}`)) { fail(INVARIANTS.fills, `${tag} appears more than once`); continue; }
      seen.add(`${user}:${fill.orderId}`);
      const portfolio = s.portfolioOf(fill.user);
      const order = portfolio && liveOrders(portfolio).find(o => o.orderId === fill.orderId);
      if (!order) { fail(INVARIANTS.fills, `${tag} has no live submitted order`); continue; }
      if (order.side !== (buys(fill) ? 0 : 1)) fail(INVARIANTS.fills, `${tag} fills the wrong side`);
      if (fill.qty > order.remainingQty) {
        fail(INVARIANTS.fills, `${tag} quantity ${fill.qty} exceeds remaining submitted size ${order.remainingQty}`);
      }
    }
  }

  for (const p of portfolios) {
    if (p.state.equity < 0n) fail(INVARIANTS.withdrawable, `portfolio ${p.address} equity ${p.state.equity} is negative`);
    // Without positions or reservations nothing can be deducted from equity.
    if (positions(p).size === 0 && liveOrders(p).length === 0 && p.state.freeCollateral < 0n) {
      fail(INVARIANTS.withdrawable, `flat portfolio ${p.address} withdrawable ${p.state.freeCollateral} is negative`);
    }
  }
  return violations;
}

// Checks that need the state immediately before and after one transaction.
function checkTransition(before, after) {
  const violations = [];
  const fail = (invariant, message) => violations.push({ invariant, message });
  for (const [id, batch] of before.batches) {
    const later = after.batches.get(id);
    if (batch.state.status === BATCH_SETTLED && later && later.state.status !== BATCH_SETTLED) {
      fail(INVARIANTS.receipts, `settled batch ${id} returned to status ${later.state.status}`);
    }
  }
  for (const [id, results] of before.results) {
    const later = after.results.get(id);
    if (results.state.spent && (!later || !later.state.spent)) fail(INVARIANTS.receipts, `spent results for batch ${id} became unspent`);
    if (results.state.spent || !later?.state.spent) continue;
    // These results were applied by this transaction: reduce-only fills must not add exposure.
    const users = new Map();
    for (const fill of results.state.fills) {
      const user = key(fill.user), portfolio = before.portfolioOf(fill.user);
      const order = portfolio && liveOrders(portfolio).find(o => o.orderId === fill.orderId);
      const entry = users.get(user) ?? { portfolio, reduceOnly: true };
      entry.reduceOnly &&= Boolean(order && order.reduceOnly);
      users.set(user, entry);
    }
    for (const [user, { portfolio, reduceOnly }] of users) {
      const settled = after.portfolios.get(portfolio?.address);
      if (!reduceOnly || !settled) continue;
      const was = positions(portfolio), now = positions(settled);
      for (const instrument of new Set([...was.keys(), ...now.keys()])) {
        const q0 = was.get(instrument) ?? 0n, q1 = now.get(instrument) ?? 0n;
        if (abs(q1) > abs(q0) || (q1 !== 0n && (q1 > 0n) !== (q0 > 0n))) {
          fail(INVARIANTS.reduce, `batch ${id} reduce-only fills moved ${user} instrument ${instrument} from ${q0} to ${q1}`);
        }
      }
    }
  }
  for (const [address, p] of after.portfolios) {
    const prior = before.portfolios.get(address);
    if (!prior) continue;
    const withdrew = p.state.principal < prior.state.principal;
    const reserved = p.state.reservedCollateral > prior.state.reservedCollateral;
    if ((withdrew || reserved) && p.state.freeCollateral < 0n) {
      fail(INVARIANTS.withdrawable, `portfolio ${address} withdrawable ${p.state.freeCollateral} is negative after a ` +
        (withdrew ? 'withdrawal' : 'reservation increase'));
    }
  }
  return violations;
}

// Runs every invariant around one transaction: snapshot before, snapshot after.
class InvariantChecker {
  constructor({ rpc, core, matcher }) {
    this.read = () => readProtocolState(rpc, { core, matcher });
  }

  async before() { return this.read(); }

  async after(before, transaction) {
    const after = await this.read();
    const violations = [...checkSnapshot(after), ...(before ? checkTransition(before, after) : [])];
    if (violations.length) throw new InvariantViolation(violations, transaction);
    return after;
  }
}

// End-of-run audit over a single snapshot. Transition-only checks cannot be evaluated.
async function audit(rpc, programs) {
  const snapshot = await readProtocolState(rpc, programs);
  const violations = checkSnapshot(snapshot);
  const failed = new Set(violations.map(v => v.invariant));
  return {
    slot: await readOnly(rpc)('getSlot', [{ commitment: 'confirmed' }]),
    accounts: { vault: snapshot.vault?.address ?? null, portfolios: snapshot.portfolios.size,
      batches: snapshot.batches.size, results: snapshot.results.size },
    invariants: Object.values(INVARIANTS).map(name => ({ name,
      status: failed.has(name) ? 'fail' : name === INVARIANTS.reduce ? 'not evaluable from one snapshot' : 'pass' })),
    violations,
  };
}

module.exports = { INVARIANTS, InvariantChecker, InvariantViolation, readProtocolState, checkSnapshot, checkTransition, audit, readOnly };
