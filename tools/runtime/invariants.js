'use strict';
// The six gate invariants (issue #26). Observes protocol state only through
// read-only JSON-RPC and the SDK layout decoders; it never reproduces program
// arithmetic beyond sums, comparisons and PDA derivation.
const { PublicKey, ComputeBudgetProgram } = require('@solana/web3.js');
const { layouts, decodeAccount, decodeResults } = require('../../mgk-frontend/packages/layout');

const INVARIANTS = Object.freeze({
  vault: 'vault balance',
  auction: 'per-auction signed base quantity sums to 0',
  fills: 'fills never exceed eligible submitted size',
  receipts: 'each receipt applied exactly once',
  reduce: 'a valid reduce never increases exposure',
  withdrawable: 'no withdrawable balance is negative',
});

// Supplementary consistency checks. They are not gate invariants, so they
// report under their own names rather than borrowing a gate invariant's.
const CHECKS = Object.freeze({
  equity: 'portfolio equity is never negative',
  collateral: 'vault collateral equals total portfolio equity',
  openInterest: 'open interest equals settled positions',
  net: 'settled positions net to zero per instrument',
});

const READ_METHODS = new Set(['getProgramAccounts', 'getMultipleAccounts', 'getAccountInfo',
  'getMinimumBalanceForRentExemption', 'getSlot']);
const BATCH_STATUS = Object.freeze({ settled: 3, cleared: 4 });
const SIDE = Object.freeze({ buy: 0, sell: 1 });
const AUCTIONS = Object.freeze([0, 1]);
const COMPUTE_BUDGET = ComputeBudgetProgram.programId.toBase58();

// Wrap any JSON-RPC transport so that only state reads can pass through it.
function readOnly(rpc) {
  return (method, params = []) => {
    if (!READ_METHODS.has(method)) throw new Error(`invariant reader refuses non-read RPC method ${method}`);
    return rpc(method, params);
  };
}

// `context` is a transaction ({ label, signature }) or a scenario ({ scenario }).
class InvariantViolation extends Error {
  constructor(violations, context) {
    let where = '';
    if (context?.scenario) where = ` after scenario "${context.scenario}"`;
    else if (context) where = ` after transaction "${context.label}"` + (context.signature ? ` (${context.signature})` : '');
    super(violations.map(v => `invariant "${v.invariant}" violated${where}: ${v.message}`).join('\n'));
    this.name = 'InvariantViolation';
    this.invariant = violations[0].invariant;
    this.transaction = context?.scenario ? undefined : context;
    this.scenario = context?.scenario;
    this.violations = violations;
  }
}

const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, new PublicKey(program))[0].toBase58();
const key = bytes => new PublicKey(bytes).toBase58();
const min = (a, b) => a < b ? a : b;
const max = (a, b) => a > b ? a : b;
const addTo = (map, k, amount) => map.set(k, (map.get(k) ?? 0n) + amount);

// Resolve { core, matcher } from a deployment file ({ programs: { perps_core, perps_matcher } })
// or a candidate manifest / verified artifact list ([{ name: 'mgk_perps_core', programId }, ...]).
function programsFrom(source) {
  const programs = Array.isArray(source) ? source : source?.programs;
  const byName = name => Array.isArray(programs) ? programs.find(p => p.name === `mgk_${name}`)?.programId : programs?.[name];
  const core = byName('perps_core'), matcher = byName('perps_matcher');
  if (!core) throw new Error('program source names no perps core program');
  if (!matcher) throw new Error('program source names no perps matcher program');
  return { core: String(core), matcher: String(matcher) };
}

function parseAccountInfo(address, value) {
  if (!value) return null;
  if (!Number.isSafeInteger(value.lamports)) throw new Error(`${address}: lamports exceed safe JSON integer range`);
  if (!Array.isArray(value.data) || value.data[1] !== 'base64') throw new Error(`${address}: base64 data required`);
  return { address, owner: value.owner, lamports: BigInt(value.lamports), data: Buffer.from(value.data[0], 'base64') };
}

function decode(name, item) {
  try { return name === 'BatchResults' ? decodeResults(item.data) : decodeAccount(name, item.data); }
  catch (error) { throw new Error(`${item.address}: ${error.message}`, { cause: error }); }
}

async function readAccounts(rpc, addresses) {
  const found = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const result = await rpc('getMultipleAccounts', [chunk, { encoding: 'base64', commitment: 'confirmed' }]);
    found.push(...result.value.map((value, index) => parseAccountInfo(chunk[index], value)));
  }
  return found;
}

async function programAccounts(rpc, program, size) {
  const result = await rpc('getProgramAccounts', [program, { encoding: 'base64', commitment: 'confirmed',
    filters: [{ dataSize: size }] }]);
  const list = Array.isArray(result) ? result : result.value;
  return list.map(({ pubkey, account: value }) => parseAccountInfo(pubkey, value));
}

const initializedBy = (item, owner) => Boolean(item && item.owner === owner && item.data[0] !== 0);

// Read every canonical protocol account. Accounts at non-canonical addresses are
// not protocol state and are ignored. Zeroed storage is only tolerated for the
// vault until the protocol is initialized (see vaultBalance).
async function readProtocolState(rpc, programs) {
  rpc = readOnly(rpc);
  const core = String(programs.core), matcher = String(programs.matcher);
  const snapshot = { programs: { core, matcher }, vault: null, vaultProblem: null, initialized: false,
    portfolios: new Map(), batches: new Map(), results: new Map() };
  const vaultAddress = pda([Buffer.from('vault')], core);
  const [vault, registry] = await readAccounts(rpc, [vaultAddress, pda([Buffer.from('registry')], core)]);
  if (initializedBy(vault, core)) {
    const rent = await rpc('getMinimumBalanceForRentExemption', [vault.data.length]);
    snapshot.vault = { ...vault, rent: BigInt(rent), state: decode('Vault', vault) };
  } else {
    snapshot.vaultProblem = `vault ${vaultAddress} is ` +
      (!vault ? 'missing' : vault.owner !== core ? `owned by ${vault.owner}, not perps core` : 'uninitialized');
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
  const results = await readAccounts(rpc, ids.map(id => pda([Buffer.from('results'), u64(id)], matcher)));
  results.forEach((item, index) => {
    if (initializedBy(item, matcher)) snapshot.results.set(ids[index], { ...item, state: decode('BatchResults', item) });
  });
  // Once the registry exists (or any protocol account does) the vault must exist too.
  snapshot.initialized = initializedBy(registry, core) || snapshot.portfolios.size > 0 || snapshot.batches.size > 0;
  snapshot.portfolioOf = user => snapshot.portfolios.get(pda([Buffer.from('portfolio'), user], core));
  return snapshot;
}

function positions(portfolio) {
  const map = new Map();
  for (const p of portfolio.state.positions.slice(0, portfolio.state.positionsLen)) {
    if (p.qty !== 0n) addTo(map, p.instrumentId, p.qty);
  }
  return map;
}
const liveOrders = portfolio => portfolio.state.orders.filter(order => order.remainingQty !== 0n);
const orderFor = (snapshot, fill) => {
  const portfolio = snapshot.portfolioOf(fill.user);
  return portfolio && liveOrders(portfolio).find(order => order.orderId === fill.orderId);
};
// Auction 0 makers and auction 1 takers buy; the opposite roles sell.
const buys = fill => (fill.auction === AUCTIONS[0]) === fill.isMaker;
const backing = vault => BigInt(vault.state.balance) + vault.state.insuranceFund - vault.state.uncoveredBadDebt;
const signedQty = fill => buys(fill) ? fill.qty : -fill.qty;

// Snapshot checks. Each reports violations through `fail` and returns how many
// facts it evaluated, so an audit can tell "pass" from "nothing to check".

// Lamports cover rent plus every liability. Surplus lamports are tolerated here
// because anyone can donate to the vault; checkTransition pins the exact delta.
function vaultBalance(snapshot, fail) {
  if (!snapshot.vault) {
    if (!snapshot.initialized) return 0;
    fail(`${snapshot.vaultProblem} after the protocol was initialized`);
    return 1;
  }
  const { lamports, rent, state, address } = snapshot.vault;
  if (lamports + state.uncoveredBadDebt < rent + BigInt(state.balance) + state.insuranceFund) {
    fail(`vault ${address} lamports ${lamports} + uncovered bad debt ${state.uncoveredBadDebt}` +
      ` < rent ${rent} + collateral ${state.balance} + insurance fund ${state.insuranceFund}`);
  }
  return 1;
}

function auctionSums(snapshot, fail) {
  let evaluated = 0;
  for (const [id, results] of snapshot.results) {
    for (const auction of AUCTIONS) {
      const fills = results.state.fills.filter(f => f.auction === auction);
      if (!fills.length) continue;
      evaluated++;
      const sum = fills.reduce((total, f) => total + signedQty(f), 0n);
      if (sum !== 0n) fail(`batch ${id} results ${results.address} auction ${auction} signed base quantity sums to ${sum}`);
    }
  }
  return evaluated;
}

function receiptsApplied(snapshot, fail) {
  let evaluated = 0;
  for (const [id, batch] of snapshot.batches) {
    const status = batch.state.status, results = snapshot.results.get(id);
    if (status !== BATCH_STATUS.cleared && status !== BATCH_STATUS.settled) continue;
    evaluated++;
    if (!results) { fail(`batch ${id} has status ${status} but no results receipt`); continue; }
    if (results.state.batchId !== id) fail(`results ${results.address} records batch ${results.state.batchId}, expected ${id}`);
    if (results.state.spent !== (status === BATCH_STATUS.settled)) {
      fail(`batch ${id} status ${status} with results ${results.state.spent ? 'spent' : 'unspent'}`);
    }
  }
  return evaluated;
}

// Fills in a cleared, unspent batch must match a live accepted order.
function fillsWithinOrders(snapshot, fail) {
  let evaluated = 0;
  for (const [id, batch] of snapshot.batches) {
    const results = snapshot.results.get(id);
    if (batch.state.status !== BATCH_STATUS.cleared || !results || results.state.spent) continue;
    const seen = new Set();
    for (const fill of results.state.fills) {
      evaluated++;
      const user = key(fill.user), tag = `batch ${id} fill for ${user} order ${fill.orderId}`;
      if (seen.has(`${user}:${fill.orderId}`)) { fail(`${tag} appears more than once`); continue; }
      seen.add(`${user}:${fill.orderId}`);
      const order = orderFor(snapshot, fill);
      if (!order) { fail(`${tag} has no live accepted order`); continue; }
      if (order.side !== (buys(fill) ? SIDE.buy : SIDE.sell)) fail(`${tag} fills the wrong side`);
      if (fill.qty > order.remainingQty) fail(`${tag} quantity ${fill.qty} exceeds remaining accepted size ${order.remainingQty}`);
    }
  }
  return evaluated;
}

// `freeCollateral` is the program's cached signed withdrawable collateral. It
// legitimately goes negative after an adverse mark, an initial-margin change at
// settlement, or while a portfolio awaits liquidation, so a snapshot can only
// require it non-negative for flat portfolios (nothing can be deducted from
// equity). Withdrawals and reservation increases are checked in checkTransition.
function flatWithdrawable(snapshot, fail) {
  let evaluated = 0;
  for (const p of snapshot.portfolios.values()) {
    if (positions(p).size !== 0 || liveOrders(p).length !== 0) continue;
    evaluated++;
    if (p.state.freeCollateral < 0n) fail(`flat portfolio ${p.address} withdrawable collateral ${p.state.freeCollateral} is negative`);
  }
  return evaluated;
}

function equityNonNegative(snapshot, fail) {
  for (const p of snapshot.portfolios.values()) {
    if (p.state.equity < 0n) fail(`portfolio ${p.address} equity ${p.state.equity} is negative`);
  }
  return snapshot.portfolios.size;
}

function collateralMatchesEquity(snapshot, fail) {
  if (!snapshot.vault) return 0;
  const equity = [...snapshot.portfolios.values()].reduce((sum, p) => sum + p.state.equity, 0n);
  const balance = BigInt(snapshot.vault.state.balance);
  if (equity !== balance) fail(`vault collateral ${balance} != sum of portfolio equity ${equity}`);
  return 1;
}

function openInterestMatches(snapshot, fail) {
  if (!snapshot.vault) return 0;
  const { state } = snapshot.vault;
  let long = 0n, short = 0n;
  for (const p of snapshot.portfolios.values()) for (const qty of positions(p).values()) qty > 0n ? long += qty : short -= qty;
  if (long !== state.openInterestLong || short !== state.openInterestShort) {
    fail(`vault open interest long ${state.openInterestLong}/short ${state.openInterestShort}` +
      ` != settled positions long ${long}/short ${short}`);
  }
  return 1;
}

function positionsNetZero(snapshot, fail) {
  const net = new Map();
  for (const p of snapshot.portfolios.values()) for (const [instrument, qty] of positions(p)) addTo(net, instrument, qty);
  for (const [instrument, qty] of net) if (qty !== 0n) fail(`instrument ${instrument} settled positions sum to ${qty}`);
  return net.size;
}

const SNAPSHOT_CHECKS = [
  [INVARIANTS.vault, vaultBalance],
  [INVARIANTS.auction, auctionSums],
  [INVARIANTS.fills, fillsWithinOrders],
  [INVARIANTS.receipts, receiptsApplied],
  [INVARIANTS.withdrawable, flatWithdrawable],
  [CHECKS.equity, equityNonNegative],
  [CHECKS.collateral, collateralMatchesEquity],
  [CHECKS.openInterest, openInterestMatches],
  [CHECKS.net, positionsNetZero],
];

// Per check name: { evaluated, violations }.
function evaluateSnapshot(snapshot) {
  const outcome = new Map();
  for (const [name, check] of SNAPSHOT_CHECKS) {
    const violations = [];
    const evaluated = check(snapshot, message => violations.push({ invariant: name, message }));
    outcome.set(name, { evaluated, violations });
  }
  return outcome;
}

const checkSnapshot = snapshot => [...evaluateSnapshot(snapshot).values()].flatMap(o => o.violations);

// Transition checks: they need the state immediately before and after one transaction.

// Only protocol programs move vault lamports in step with the ledger. Any other
// instruction (e.g. a system transfer) can only donate, never withdraw.
function vaultDelta(before, after, transaction, fail) {
  if (!before.vault || !after.vault) return;
  const lamportDelta = after.vault.lamports - before.vault.lamports;
  const backingDelta = backing(after.vault) - backing(before.vault);
  const { core, matcher } = after.programs;
  const external = (transaction?.programIds ?? []).some(id => ![core, matcher, COMPUTE_BUDGET].includes(String(id)));
  if (external ? lamportDelta < backingDelta : lamportDelta !== backingDelta) {
    fail(INVARIANTS.vault, `vault ${after.vault.address} lamports moved by ${lamportDelta} but collateral + insurance fund` +
      ` - uncovered bad debt moved by ${backingDelta}` + (external ? ' (a non-protocol instruction may only donate)' : ''));
  }
}

function receiptsNotReapplied(before, after, fail) {
  for (const [id, batch] of before.batches) {
    const later = after.batches.get(id);
    if (batch.state.status === BATCH_STATUS.settled && later && later.state.status !== BATCH_STATUS.settled) {
      fail(INVARIANTS.receipts, `settled batch ${id} returned to status ${later.state.status}`);
    }
  }
  for (const [id, results] of before.results) {
    const later = after.results.get(id);
    if (results.state.spent && (!later || !later.state.spent)) fail(INVARIANTS.receipts, `spent results for batch ${id} became unspent`);
  }
}

// For results applied by this transaction: per user and instrument with any
// reduce-only fill, the settled position must lie in the envelope reachable by
// applying the plain fills exactly and the reduce-only fills toward zero
// without crossing it, in any order:
//   min(q0, 0) + plain sells <= q1 <= max(q0, 0) + plain buys.
// Fills whose order is unknown count as plain fills on every instrument.
function reduceEnvelope(before, after, fail) {
  for (const [id, results] of before.results) {
    if (results.state.spent || !after.results.get(id)?.state.spent) continue;
    const users = new Map();
    for (const fill of results.state.fills) {
      const user = key(fill.user);
      const entry = users.get(user) ?? { portfolio: before.portfolioOf(fill.user), reduce: new Set(), plain: new Map(), unknown: [] };
      users.set(user, entry);
      const order = orderFor(before, fill);
      if (!order) { entry.unknown.push(fill); continue; }
      if (order.reduceOnly) { entry.reduce.add(order.instrumentId); continue; }
      const plain = entry.plain.get(order.instrumentId) ?? { buy: 0n, sell: 0n };
      buys(fill) ? plain.buy += fill.qty : plain.sell -= fill.qty;
      entry.plain.set(order.instrumentId, plain);
    }
    for (const [user, { portfolio, reduce, plain, unknown }] of users) {
      const settled = portfolio && after.portfolios.get(portfolio.address);
      if (!settled) continue;
      const was = positions(portfolio), now = positions(settled);
      for (const instrument of reduce) {
        let { buy, sell } = plain.get(instrument) ?? { buy: 0n, sell: 0n };
        for (const fill of unknown) buys(fill) ? buy += fill.qty : sell -= fill.qty;
        const q0 = was.get(instrument) ?? 0n, q1 = now.get(instrument) ?? 0n;
        const low = min(q0, 0n) + sell, high = max(q0, 0n) + buy;
        if (q1 < low || q1 > high) {
          fail(INVARIANTS.reduce, `batch ${id} moved ${user} instrument ${instrument} from ${q0} to ${q1},` +
            ` outside [${low}, ${high}] allowed by its reduce-only and plain fills`);
        }
      }
    }
  }
}

function withdrawableAfterDebit(before, after, fail) {
  for (const [address, p] of after.portfolios) {
    const prior = before.portfolios.get(address);
    if (!prior) continue;
    const withdrew = p.state.principal < prior.state.principal;
    const reserved = p.state.reservedCollateral > prior.state.reservedCollateral;
    if ((withdrew || reserved) && p.state.freeCollateral < 0n) {
      fail(INVARIANTS.withdrawable, `portfolio ${address} withdrawable collateral ${p.state.freeCollateral} is negative after a ` +
        (withdrew ? 'withdrawal' : 'reservation increase'));
    }
  }
}

// `transaction.programIds` lists the transaction's top-level instruction programs.
// Without it every instruction is assumed to be a protocol instruction.
function checkTransition(before, after, transaction) {
  const violations = [];
  const fail = (invariant, message) => violations.push({ invariant, message });
  vaultDelta(before, after, transaction, fail);
  receiptsNotReapplied(before, after, fail);
  reduceEnvelope(before, after, fail);
  withdrawableAfterDebit(before, after, fail);
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
    const violations = [...checkSnapshot(after), ...(before ? checkTransition(before, after, transaction) : [])];
    if (violations.length) throw new InvariantViolation(violations, transaction);
    return after;
  }
}

const NOT_EVALUATED = Object.freeze({
  [INVARIANTS.vault]: 'the protocol is not initialized',
  [INVARIANTS.auction]: 'no batch results hold fills',
  [INVARIANTS.fills]: 'no cleared batch awaits settlement',
  [INVARIANTS.receipts]: 'no batch has cleared or settled',
  [INVARIANTS.withdrawable]: 'no flat portfolio; withdrawals and reservations are only checked per transaction',
  [CHECKS.equity]: 'no portfolios',
  [CHECKS.collateral]: 'no initialized vault',
  [CHECKS.openInterest]: 'no initialized vault',
  [CHECKS.net]: 'no open positions',
});

function status(name, { evaluated, violations }) {
  if (violations.length) return { name, status: 'fail' };
  if (!evaluated) return { name, status: 'not evaluable', reason: NOT_EVALUATED[name] };
  return { name, status: 'pass', evaluated };
}

// End-of-run audit over a single snapshot. A check with nothing to evaluate is
// reported as "not evaluable", never as a vacuous pass.
async function audit(rpc, programs) {
  const snapshot = await readProtocolState(rpc, programs);
  const outcome = evaluateSnapshot(snapshot);
  const invariants = Object.values(INVARIANTS).map(name => name === INVARIANTS.reduce
    ? { name, status: 'not evaluable', reason: 'needs the state before and after the settling transaction' }
    : status(name, outcome.get(name)));
  return {
    slot: await readOnly(rpc)('getSlot', [{ commitment: 'confirmed' }]),
    accounts: { vault: snapshot.vault?.address ?? null, portfolios: snapshot.portfolios.size,
      batches: snapshot.batches.size, results: snapshot.results.size },
    invariants,
    checks: Object.values(CHECKS).map(name => status(name, outcome.get(name))),
    violations: [...outcome.values()].flatMap(o => o.violations),
  };
}

module.exports = { INVARIANTS, CHECKS, InvariantChecker, InvariantViolation, readProtocolState, checkSnapshot,
  checkTransition, audit, readOnly, programsFrom, pda, u64 };
