'use strict';
// Test fixtures for the invariant checker: protocol account bytes encoded from
// the SDK layout table, served by an in-memory JSON-RPC that records methods.
const assert = require('node:assert/strict');
const { PublicKey, Keypair } = require('@solana/web3.js');
const { layouts, resultsLayout, decodeResults } = require('../../mgk-frontend/packages/layout');
const deployment = require('../../deployments/devnet.json');

const CORE = deployment.programs.perps_core, MATCHER = deployment.programs.perps_matcher;
const { u64, pda: derive } = require('./invariants');
const pda = (seeds, program = CORE) => derive(seeds, program);

function size(type) {
  const array = /^\[(.+); (\d+)\]$/.exec(type);
  if (array) return size(array[1]) * Number(array[2]);
  return layouts[type]?.size ?? (type === 'pubkey' ? 32 : type === 'bool' ? 1 : Number(type.slice(1)) / 8);
}

function write(type, value, data, offset) {
  const array = /^\[(.+); (\d+)\]$/.exec(type);
  if (array) return value.forEach((item, i) => item !== undefined && write(array[1], item, data, offset + i * size(array[1])));
  if (layouts[type]) return encodeStruct(type, value, data, offset);
  if (type === 'pubkey') return new PublicKey(value).toBuffer().copy(data, offset);
  if (type === 'bool') return data.writeUInt8(Number(value), offset);
  const bits = Number(type.slice(1)), signed = type[0] === 'i';
  if (bits === 128) {
    const raw = BigInt.asUintN(128, BigInt(value));
    data.writeBigUInt64LE(raw & ((1n << 64n) - 1n), offset);
    data.writeBigUInt64LE(raw >> 64n, offset + 8);
  } else if (bits === 64) data[signed ? 'writeBigInt64LE' : 'writeBigUInt64LE'](BigInt(value), offset);
  else data[`write${signed ? 'Int' : 'UInt'}${bits === 8 ? 8 : bits + 'LE'}`](Number(value), offset);
}

function encodeStruct(name, values, data = Buffer.alloc(layouts[name].size), offset = 0) {
  for (const [field, value] of Object.entries(values)) {
    assert.ok(layouts[name].fields[field], `${name}.${field}: unknown layout field`);
    const [fieldOffset, type] = layouts[name].fields[field];
    write(type, value, data, offset + fieldOffset);
  }
  return data;
}

function encodeAccount(name, values) {
  const data = encodeStruct(name, values);
  data[0] = layouts[name].discriminator; data[1] = layouts[name].version;
  return data;
}

// The results payload is not in the layout table. Encoded fixtures start from
// the matcher serializer's own bytes (resultsLayout.fixture, see
// docs/layout-freeze.md) and locate each field by probing the SDK decoder:
// a byte belongs to a field when changing it changes that decoded field.
// No offsets are written down here, so the fixtures cannot drift from the decoder.
const MAX_FILLS = 12;
const template = () => {
  const data = Buffer.alloc(resultsLayout.headerSize + MAX_FILLS * resultsLayout.fillSize);
  Buffer.from(resultsLayout.fixture).copy(data);
  return data;
};
const show = value => Buffer.isBuffer(value) || value instanceof Uint8Array ? Buffer.from(value).toString('hex') : String(value);

function locate(read, from, to) {
  const base = template(), expected = show(read(decodeResults(base)));
  const changes = new Map(); // offset -> true (field changed) | 'invalid' (decoder rejected the bytes)
  for (let i = from; i < to; i++) {
    const probe = Buffer.from(base); probe[i] ^= 1;
    try { if (show(read(decodeResults(probe))) !== expected) changes.set(i, true); } catch { changes.set(i, 'invalid'); }
  }
  const bytes = [...changes].filter(([, kind]) => kind === true).map(([i]) => i);
  assert.ok(bytes.length && bytes.at(-1) - bytes[0] + 1 === bytes.length, 'results field must be contiguous bytes');
  // A byte the decoder rejects outright (e.g. a fill count's high byte) extends an adjacent field.
  let end = bytes.at(-1);
  while (changes.get(end + 1) === 'invalid') end++;
  return { offset: bytes[0], width: end - bytes[0] + 1 };
}

const RESULTS = {
  batchId: locate(r => r.batchId, 2, resultsLayout.headerSize),
  spent: locate(r => r.spent, 2, resultsLayout.headerSize),
  numFills: locate(r => r.numFills, 2, resultsLayout.headerSize),
};
const fillRange = [resultsLayout.headerSize, resultsLayout.headerSize + resultsLayout.fillSize];
const FILL = Object.fromEntries(['user', 'orderId', 'qty', 'price', 'isMaker', 'auction'].map(field => {
  const { offset, width } = locate(r => r.fills[0][field], ...fillRange);
  return [field, { offset: offset - resultsLayout.headerSize, width }];
}));

function writeLE(data, { offset, width }, value) {
  let raw = BigInt.asUintN(width * 8, BigInt(value));
  for (let i = 0; i < width; i++) { data[offset + i] = Number(raw & 0xffn); raw >>= 8n; }
}

function encodeResults({ batchId, spent = false, fills = [] }) {
  assert.ok(fills.length <= MAX_FILLS);
  const data = template();
  data.fill(0, resultsLayout.headerSize);
  writeLE(data, RESULTS.batchId, batchId);
  writeLE(data, RESULTS.spent, Number(spent));
  writeLE(data, RESULTS.numFills, fills.length);
  fills.forEach((fill, i) => {
    const at = field => ({ ...FILL[field], offset: resultsLayout.headerSize + i * resultsLayout.fillSize + FILL[field].offset });
    new PublicKey(fill.user).toBuffer().copy(data, at('user').offset);
    writeLE(data, at('orderId'), fill.orderId);
    writeLE(data, at('qty'), fill.qty);
    writeLE(data, at('price'), fill.price ?? 1_000_000);
    writeLE(data, at('isMaker'), Number(fill.isMaker));
    writeLE(data, at('auction'), fill.auction);
  });
  const decoded = decodeResults(data);
  assert.equal(decoded.batchId, BigInt(batchId));
  assert.equal(decoded.spent, Boolean(spent));
  assert.equal(decoded.fills.length, fills.length);
  fills.forEach((fill, i) => {
    assert.equal(decoded.fills[i].qty, BigInt(fill.qty));
    assert.equal(decoded.fills[i].auction, fill.auction);
    assert.equal(decoded.fills[i].isMaker, Boolean(fill.isMaker));
  });
  return data;
}

// Rent in this fixture follows Solana's default rent schedule: (128 + bytes) x 6960 lamports.
const rent = bytes => (128 + bytes) * 6960;

class FixtureChain {
  constructor() { this.accounts = new Map(); this.calls = []; }
  set(address, { owner = CORE, lamports, data }) {
    this.accounts.set(String(address), { owner: String(owner), lamports: lamports ?? rent(data.length), data });
  }
  info(address) {
    const a = this.accounts.get(address);
    return a ? { owner: a.owner, lamports: a.lamports, executable: false, rentEpoch: 0,
      data: [a.data.toString('base64'), 'base64'], space: a.data.length } : null;
  }
  async rpc(method, params = []) {
    this.calls.push(method);
    if (method === 'getMultipleAccounts') return { context: { slot: 7 }, value: params[0].map(a => this.info(a)) };
    if (method === 'getAccountInfo') return { context: { slot: 7 }, value: this.info(params[0]) };
    if (method === 'getMinimumBalanceForRentExemption') return rent(params[0]);
    if (method === 'getSlot') return 7;
    if (method === 'getProgramAccounts') {
      const sizes = (params[1]?.filters ?? []).map(f => f.dataSize);
      return [...this.accounts.keys()].filter(a => this.accounts.get(a).owner === params[0])
        .filter(a => sizes.every(s => this.accounts.get(a).data.length === s))
        .map(pubkey => ({ pubkey, account: this.info(pubkey) }));
    }
    throw new Error(`fixture chain: unsupported method ${method}`);
  }
}

// A consistent market: two traders, one settled batch, one cleared batch awaiting settlement.
// All quantities are literal scenario values, not program output.
function market() {
  const chain = new FixtureChain();
  const maker = Keypair.generate().publicKey.toBase58(), taker = Keypair.generate().publicKey.toBase58();
  const portfolio = user => pda([Buffer.from('portfolio'), new PublicKey(user).toBuffer()]);
  const state = {
    vault: { balance: 3_000_000n, insuranceFund: 500_000n, uncoveredBadDebt: 0n, openInterestLong: 5n, openInterestShort: 5n },
    portfolios: {
      [maker]: { user: maker, equity: 2_000_000n, principal: 2_000_000n, freeCollateral: 1_500_000n, positionsLen: 1,
        positions: [{ instrumentId: 0, qty: 5n }],
        orders: [{ orderId: 7n, originalQty: 3n, remainingQty: 3n, side: 1, reduceOnly: 1 }] },
      [taker]: { user: taker, equity: 1_000_000n, principal: 1_000_000n, freeCollateral: 600_000n, positionsLen: 1,
        positions: [{ instrumentId: 0, qty: -5n }],
        orders: [{ orderId: 8n, originalQty: 3n, remainingQty: 3n, side: 0 }] },
    },
    batches: { 0: { status: 3 }, 1: { status: 4 }, 2: { status: 0 } },
    results: {
      0: { batchId: 0, spent: true, fills: [] },
      // Auction 1: maker sells 3 (order 7), taker buys 3 (order 8).
      1: { batchId: 1, spent: false, fills: [
        { user: maker, orderId: 7, qty: 3, isMaker: true, auction: 1 },
        { user: taker, orderId: 8, qty: 3, isMaker: false, auction: 1 }] },
    },
  };
  const addresses = { vault: pda([Buffer.from('vault')]), registry: pda([Buffer.from('registry')]), maker, taker,
    makerPortfolio: portfolio(maker), takerPortfolio: portfolio(taker) };
  // A null registry or vault is stored as zeroed (uninitialized) storage, as before `initialize`.
  state.registry = {};
  // Every store rewrites the whole chain from `state`.
  const store = (overrides = {}) => {
    chain.accounts.clear();
    chain.set(addresses.registry, { data: state.registry ? encodeAccount('Registry', state.registry) : Buffer.alloc(layouts.Registry.size) });
    const vaultBytes = state.vault ? encodeAccount('Vault', state.vault) : Buffer.alloc(layouts.Vault.size);
    const backing = state.vault ? state.vault.balance + state.vault.insuranceFund - state.vault.uncoveredBadDebt : 0n;
    chain.set(addresses.vault, { data: vaultBytes,
      lamports: rent(layouts.Vault.size) + Number(backing) + (overrides.vaultLamports ?? 0) });
    for (const [user, values] of Object.entries(state.portfolios)) chain.set(portfolio(user), { data: encodeAccount('Portfolio', values) });
    for (const [id, values] of Object.entries(state.batches)) {
      chain.set(pda([Buffer.from('batch'), u64(id)]), { data: encodeAccount('Batch', { batchId: BigInt(id), ...values }) });
    }
    for (const [id, values] of Object.entries(state.results)) {
      chain.set(pda([Buffer.from('results'), u64(id)], MATCHER), { owner: MATCHER, data: encodeResults(values) });
    }
  };
  store();
  return { chain, state, addresses, store, programs: { core: CORE, matcher: MATCHER } };
}

module.exports = { CORE, MATCHER, FixtureChain, encodeAccount, encodeResults, market, rent, pda, u64 };
