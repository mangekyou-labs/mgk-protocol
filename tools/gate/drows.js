#!/usr/bin/env node
'use strict';
// Tier-D gate row driver (issue #40, spec #13). Runs P0-1, 4, 5, 6, 7, 9, 10,
// 12 and 13 against a deployed market, drives the P0-33 latency taker
// (--latency) and the P0-35 soak taker (--soak, or createSoakDrive for
// tools/gate/soak.js runSoak). The hosted keeper advances every batch; this
// tool never cranks. Every send is simulated first; settlement is observed
// from chain state and every lamport delta is asserted exactly.
//
//   node tools/gate/drows.js --rpc URL --deployment deployments/devnet.json \
//     --rows P0-1,P0-4 --keys ~/.config/solana --out /tmp/mgk-d-rows
//   node tools/gate/drows.js --latency --orders 30 --span-min 32 \
//     --status-url https://.../api/status --rpc URL --out DIR
//   node tools/gate/drows.js --soak --duration-min 120 --rpc URL --out DIR
//
// Signs only with the persona keys (maker, taker, qa) and refuses the admin,
// governance, oracle-authority and hosted-maker keys. Exits 0 when every
// row passes, 1 on a failed row and 2 on usage or startup refusal.
const { execFileSync } = require('node:child_process');
const { mkdirSync, readFileSync, realpathSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { basename, join, resolve } = require('node:path');
const {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} = require('@solana/web3.js');
const { decodeAccount, decodeStruct, decodeResults, layouts } = require('../../mgk-frontend/packages/layout');
const { encodeInstruction } = require('../../mgk-frontend/packages/layout/instructions');
const { loadManifest } = require('../../mgk-frontend/packages/layout/manifest');
const { createMarketContext } = require('../market-context');
const { LatencyRecorder } = require('./latency');

const ADMIN_PUBKEY = 'GBz4U7gb3nqALmtBBYajKgngFjbEsjPzM86X7ZADPwt4';
const PERSONA_FILES = Object.freeze({
  maker: 'mgk-trader-maker.json',
  taker: 'mgk-trader-taker.json',
  qa: 'mgk-demo-qa.json',
});
// Rows this tool automates. P0-33/P0-35 have their own modes (--latency,
// --soak / createSoakDrive); P0-28 is already proven on devnet and P0-30 is
// operator-run, so neither is run here.
const D_ROWS = Object.freeze(['P0-1', 'P0-4', 'P0-5', 'P0-6', 'P0-7', 'P0-9', 'P0-10', 'P0-12', 'P0-13']);
const OTHER_D_ROWS = new Set(['P0-28', 'P0-30', 'P0-33', 'P0-35']);
const DEFAULT_DEPLOYMENT = resolve(__dirname, '../../deployments/devnet.json');
const DEFAULT_KEYS = join(homedir(), '.config/solana');
// monitoringGreen rule: every /api/status check must be 'ok' except these.
// Indexer lag is ignored by default because P0-33 measures chain-observed
// latency and the indexer is not on the order path.
const DEFAULT_MONITORING_IGNORE = Object.freeze(['indexer']);
// Operator keys (maker worker, keeper, oracle, admin) are never loaded.
const FORBIDDEN_FILE = /maker-worker|keeper|oracle|admin/i;

// Reads exactly the requested persona files. The key directory is never listed.
function loadPersonas({
  dir,
  names = Object.keys(PERSONA_FILES),
  readFile = readFileSync,
  realpath = realpathSync,
  fromSecretKey = secret => Keypair.fromSecretKey(secret),
  forbiddenPubkeys = [],
} = {}) {
  const personas = {};
  const seen = new Set();
  for (const name of names) {
    const file = PERSONA_FILES[name];
    if (!file) throw Error(`Unknown persona ${name}`);
    const path = join(dir, file);
    if (FORBIDDEN_FILE.test(basename(realpath(path))))
      throw Error(`Refusing ${file}: resolves to an operator key file`);
    const keypair = fromSecretKey(Uint8Array.from(JSON.parse(readFile(path, 'utf8'))));
    const pubkey = keypair.publicKey.toBase58();
    if (pubkey === ADMIN_PUBKEY) throw Error(`Refusing ${file}: admin key ${pubkey}`);
    if (forbiddenPubkeys.includes(pubkey)) throw Error(`Refusing ${file}: operator key ${pubkey}`);
    if (seen.has(pubkey)) throw Error(`Refusing ${file}: duplicate persona key ${pubkey}`);
    seen.add(pubkey);
    personas[name] = { name, file, keypair, publicKey: keypair.publicKey };
  }
  return personas;
}

const BOOLEAN_FLAGS = new Map([['--latency', 'latency'], ['--soak', 'soak']]);

function parseArgs(argv) {
  const options = {
    rpc: null,
    deployment: DEFAULT_DEPLOYMENT,
    keys: DEFAULT_KEYS,
    out: null,
    rows: [...D_ROWS],
    mode: 'rows',
    orders: 30,
    spanMs: 32 * 60 * 1000,
    statusUrl: null,
    monitoringIgnore: [...DEFAULT_MONITORING_IGNORE],
    soakMs: 2 * 60 * 60 * 1000,
    soakPollMs: 5000,
    driveEvery: 12,
  };
  const modes = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (BOOLEAN_FLAGS.has(flag)) {
      modes.push(BOOLEAN_FLAGS.get(flag));
      continue;
    }
    const value = argv[i + 1];
    if (flag === '--rpc') options.rpc = value;
    else if (flag === '--deployment') options.deployment = value === undefined ? value : resolve(value);
    else if (flag === '--keys') options.keys = value;
    else if (flag === '--out') options.out = value === undefined ? value : resolve(value);
    else if (flag === '--rows') {
      modes.push('rows');
      options.rows = (value ?? '').split(',').map(id => id.trim()).filter(Boolean);
    } else if (flag === '--orders') options.orders = Number(value);
    else if (flag === '--span-min') options.spanMs = Number(value) * 60 * 1000;
    else if (flag === '--status-url') options.statusUrl = value;
    else if (flag === '--duration-min') options.soakMs = Number(value) * 60 * 1000;
    else if (flag === '--soak-poll-ms') options.soakPollMs = Number(value);
    else if (flag === '--drive-every') options.driveEvery = Number(value);
    else if (flag === '--monitoring-ignore') {
      options.monitoringIgnore = (value ?? '').split(',').map(name => name.trim()).filter(Boolean);
    } else throw new Error(`unknown argument ${flag}`);
    if (value === undefined) throw new Error(`${flag}: missing value`);
    i++;
  }
  if (new Set(modes).size > 1) throw new Error('choose one mode: --rows, --latency or --soak');
  if (modes.length) options.mode = modes[0];
  if (!options.rpc) throw new Error('--rpc is required (this tool never defaults to a cluster)');
  if (!options.out) throw new Error('--out <evidence-dir> is required');
  for (const id of options.rows) {
    if (id === 'P0-28') throw new Error('P0-28 is already proven on devnet; this tool does not run it');
    if (!D_ROWS.includes(id)) {
      throw new Error(OTHER_D_ROWS.has(id) ? `${id} has its own driver, not --rows` : `${id} is not a tier-D row this tool runs`);
    }
  }
  for (const [name, value] of [['--orders', options.orders], ['--span-min', options.spanMs], ['--duration-min', options.soakMs],
    ['--soak-poll-ms', options.soakPollMs], ['--drive-every', options.driveEvery]]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  }
  if (options.mode === 'latency' && options.orders < 2) throw new Error('--orders must be at least 2');
  if (options.mode === 'latency' && !options.statusUrl) {
    throw new Error('--latency needs --status-url (monitoringGreen is read from /api/status)');
  }
  return options;
}

// ---------------------------------------------------------------------------
// Chain driver
// ---------------------------------------------------------------------------
const bs58 = require('bs58');
const { confirmSignature } = require('../../mgk-frontend/packages/layout/confirmation');

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const BATCH = Object.freeze({ committing: 0, settled: 3, cleared: 4 });
const ERR = Object.freeze({ insufficientFunds: 4, batchNotOpen: 502, paused: 602, reduceOnly: 606 });
// Frugality: rows deposit 0.005 SOL (P0-1 deposits exactly 0.2 SOL as the
// gate specifies); nothing ever deposits more than 0.2 SOL.
const ROW_DEPOSIT = 5_000_000n;
const P01_DEPOSIT = 200_000_000n;
const MAX_DEPOSIT = P01_DEPOSIT;
const CU_LIMIT = 1_400_000;
const NULL_OFFSET = 0xffffffff;
const U64_MAX = (1n << 64n) - 1n;
const BUY = 0;
const SELL = 1;
// Registry byte 92 is the unsettled-batch latch (not in the generated layout).
const REGISTRY_UNSETTLED_OFFSET = 92;
const RETRY_CODES = new Set([ERR.paused, ERR.batchNotOpen]);

const meta = (pubkey, isWritable = true, isSigner = false) => ({ pubkey, isWritable, isSigner });
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const ceilDiv = (a, b) => (a + b - 1n) / b;
const abs = n => (n < 0n ? -n : n);
const minBig = (a, b) => (a < b ? a : b);
const b58 = key => (typeof key === 'string' ? key : new PublicKey(key).toBase58());

// JSON-safe evidence: BigInt -> string, keys -> base58, other bytes -> hex.
function plain(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (value instanceof Uint8Array) return value.length === 32 ? bs58.encode(Buffer.from(value)) : Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  }
  return value;
}

const customCode = err => err?.InstructionError?.[1]?.Custom;

class SimulationError extends Error {
  constructor(label, err, logs, signedAt) {
    super(`${label}: simulation failed ${JSON.stringify(err)}`);
    this.code = customCode(err);
    this.simulationError = err;
    this.logs = logs ?? [];
    this.signedAt = signedAt;
  }
}

// Mirrors Portfolio reservation(): notional at max(limit, conversion), the
// 5 bps taker fee rounded up, plus 20% initial margin unless reduce-only.
function reservation(qty, price, conversion, reduceOnly = false) {
  const [q, p, c] = [BigInt(qty), BigInt(price), BigInt(conversion)];
  const notional = q * (p > c ? p : c) * 1_000_000n;
  const fee = ceilDiv(notional, c * 2000n);
  return reduceOnly ? fee : ceilDiv(notional, c * 5n) + fee;
}

// OrderReservation::reserved(): initialReserve * remaining / original, rounded up.
function proRata(initialReserve, originalQty, remainingQty) {
  const [total, original, remaining] = [BigInt(initialReserve), BigInt(originalQty), BigInt(remainingQty)];
  if (remaining === 0n) return 0n;
  return (total / original) * remaining + ceilDiv((total % original) * remaining, original);
}

// Port of mgk-frontend/apps/indexer/src/settlementReceipt.ts: only a
// complete receipt emitted directly by the core invocation is accepted.
function settlementReceipt(logs, { programId, batchId, allocations }) {
  const core = b58(programId);
  const stack = [];
  let receipt;
  for (const line of logs ?? []) {
    const invoke = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (invoke) { stack.push(invoke[1]); continue; }
    const exit = /^Program (\S+) (success|failed:.*)$/.exec(line);
    if (exit) {
      if (stack.pop() !== exit[1]) throw Error('Malformed invocation logs');
      continue;
    }
    if (stack[stack.length - 1] !== core || !line.startsWith('Program data: ')) continue;
    const [tag, encoded] = line.slice(14).split(' ');
    if (!tag || Buffer.from(tag, 'base64').toString() !== 'mgk-settlement-v1') continue;
    const data = Buffer.from(encoded ?? '', 'base64');
    if (data.length < 10) throw Error('Truncated settlement receipt');
    if (data.readBigUInt64LE(0) !== BigInt(batchId)) continue;
    const count = data.readUInt16LE(8);
    if (receipt || count !== allocations.length || data.length !== 10 + count * 8) {
      throw Error('Incomplete or duplicate settlement receipt');
    }
    receipt = Array.from({ length: count }, (_, i) => data.readBigUInt64LE(10 + i * 8));
    if (receipt.some((qty, i) => qty > BigInt(allocations[i]))) throw Error('Settlement receipt exceeds allocation');
  }
  if (stack.length) throw Error('Truncated invocation logs');
  if (!receipt) throw Error('Effective settlement receipt unavailable');
  return receipt;
}

// monitoringGreen rule (P0-33 run context): green only when there is at
// least one /api/status sample, no sample errored, and in every sample each
// check NOT in `ignore` has severity 'ok'. A sample whose checks are all
// ignored is not green. The ignore list defaults to ['indexer'] and is set
// with --monitoring-ignore (empty string = require every check).
function monitoringGreen(samples, ignore = DEFAULT_MONITORING_IGNORE) {
  const skip = new Set(ignore);
  const reasons = [];
  if (!samples.length) reasons.push('no /api/status samples');
  for (const sample of samples) {
    if (sample.error) { reasons.push(`${sample.at}: status unavailable (${sample.error})`); continue; }
    const checks = Object.entries(sample.body?.checks ?? {}).filter(([name]) => !skip.has(name));
    if (!checks.length) reasons.push(`${sample.at}: no checks outside the ignore list`);
    for (const [name, check] of checks) {
      if (check?.severity !== 'ok') reasons.push(`${sample.at}: ${name} is ${check?.severity ?? 'missing'}`);
    }
  }
  return { green: reasons.length === 0, reasons, ignored: [...skip] };
}

// Independent expectation: the issue #14 Fraction ledger via ledger_scenario.py.
function runLedgerModel(request) {
  const out = execFileSync('python3', ['-B', 'ledger_scenario.py'], {
    cwd: __dirname,
    input: JSON.stringify(request),
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

function decodePortfolio(data, user) {
  const portfolio = decodeAccount('Portfolio', data);
  if (user && b58(portfolio.user) !== b58(user)) throw Error(`portfolio user ${b58(portfolio.user)} is not ${b58(user)}`);
  const positions = portfolio.positions.slice(0, portfolio.positionsLen);
  const position = positions.find(item => item.instrumentId === 0 && item.qty !== 0n) ?? null;
  return {
    ...portfolio,
    positions,
    position,
    qty: position ? position.qty : 0n,
    openOrders: portfolio.orders.filter(order => order.remainingQty > 0n),
  };
}

// Exact entry as a fraction: entryVwap + entryRemainder / entryDenominator.
function entryFraction(position) {
  const den = position.entryDenominator > 0n ? position.entryDenominator : 1n;
  return { num: position.entryVwap * den + position.entryRemainder, den };
}

function decodeBook(data) {
  const header = decodeAccount('OrderBook', data);
  const base = layouts.OrderBook.size;
  const stride = layouts.RestingOrder.size;
  const orders = [];
  for (const levels of [header.bids, header.asks]) {
    for (const level of levels) {
      if (level.orderCount === 0) continue;
      const seen = new Set();
      for (let slot = level.firstOrderOffset; slot !== NULL_OFFSET;) {
        if (seen.has(slot)) throw Error('order book chain loops');
        seen.add(slot);
        const offset = base + slot * stride;
        if (offset + stride > data.length) throw Error(`order book slot ${slot} out of range`);
        const order = decodeStruct('RestingOrder', data, offset);
        if (order.qty > order.filledQty && order.orderId !== U64_MAX) {
          orders.push({ ...order, user: b58(order.user), open: order.qty - order.filledQty });
        }
        slot = order.nextOrderOffset;
      }
    }
  }
  return { bestBid: header.bestBid, bestAsk: header.bestAsk, nextOrderId: header.nextOrderId, orders };
}

// Per-price open quantity of the hosted maker: bids best-first (descending),
// asks best-first (ascending).
function hostedLadder(book, maker) {
  const sum = side => {
    const levels = new Map();
    for (const order of book.orders) {
      if (order.side === side && order.user === maker) levels.set(order.price, (levels.get(order.price) ?? 0n) + order.open);
    }
    return [...levels].map(([price, qty]) => ({ price, qty }));
  };
  return {
    bids: sum(BUY).sort((a, b) => (a.price > b.price ? -1 : 1)),
    asks: sum(SELL).sort((a, b) => (a.price < b.price ? -1 : 1)),
  };
}

// Limit price that crosses `qty` lots of the hosted ladder on the opposite
// side: the worst level needed (cumulative), or null if depth is short.
function crossingPrice(ladder, side, qty) {
  const levels = side === BUY ? ladder.asks : ladder.bids;
  let filled = 0n;
  for (const level of levels) {
    filled += level.qty;
    if (filled >= BigInt(qty)) return level.price;
  }
  return null;
}
function createDriver({
  connection,
  manifest,
  personas,
  now = Date.now,
  sleep = ms => new Promise(done => setTimeout(done, ms)),
  log = () => {},
  model = runLedgerModel,
  confirm = confirmSignature,
  pollMs = 1000,
  confirmTimeoutMs = 60000,
  settleTimeoutMs = 180000,
  expectedGenesis = DEVNET_GENESIS,
}) {
  if (!manifest.ready) throw Error('deployment manifest is not ready');
  if (manifest.marketSeed != null) throw Error('scoped markets (marketSeed) are not supported; use the schema-1 devnet manifest');
  if (!['devnet', 'localnet'].includes(manifest.cluster)) throw Error(`refusing cluster ${manifest.cluster}`);
  const core = new PublicKey(manifest.programs.perps_core);
  const matcher = new PublicKey(manifest.programs.perps_matcher);
  const oracleProgram = new PublicKey(manifest.programs.oracle);
  const ctx = createMarketContext(core, null);
  const keys = {
    registry: ctx.registry,
    vault: ctx.pda([Buffer.from('vault')])[0],
    instrument: ctx.pda([Buffer.from('instrument'), u16(0)])[0],
    book: ctx.pda([Buffer.from('book'), u16(0)], matcher)[0],
    oracle: new PublicKey(manifest.accounts.oracle),
    maker: new PublicKey(manifest.accounts.maker),
  };
  const batchKey = id => ctx.pda([Buffer.from('batch'), u64(id)])[0];
  const resultsKey = id => ctx.pda([Buffer.from('results'), u64(id)], matcher)[0];
  const portfolioKey = pk => ctx.pda([Buffer.from('portfolio'), new PublicKey(pk).toBuffer()])[0];
  const personaList = Object.values(personas);
  const personaKeys = new Set(personaList.map(p => p.publicKey.toBase58()));
  const records = [];
  let market = null;

  function assertPersona(persona) {
    if (!persona?.keypair || !personaKeys.has(persona.publicKey.toBase58())) throw Error('refusing to sign with a non-persona key');
    if (persona.publicKey.toBase58() === ADMIN_PUBKEY) throw Error('refusing to sign with the admin key');
  }

  async function init() {
    if (manifest.cluster === 'devnet') {
      const genesis = await connection.getGenesisHash();
      if (genesis !== expectedGenesis) throw Error(`genesis ${genesis} is not devnet (${expectedGenesis})`);
    }
    for (const [name, key] of [['registry', keys.registry], ['instrument', keys.instrument], ['insurance', keys.vault]]) {
      if (manifest.accounts[name] !== key.toBase58()) throw Error(`manifest ${name} ${manifest.accounts[name]} is not the PDA ${key.toBase58()}`);
    }
    const names = ['registry', 'instrument', 'vault', 'book', 'oracle'];
    const owners = [core, core, core, matcher, oracleProgram];
    const infos = await connection.getMultipleAccountsInfo(names.map(name => keys[name]), 'confirmed');
    infos.forEach((info, i) => {
      if (!info) throw Error(`${names[i]} account ${keys[names[i]].toBase58()} is missing`);
      if (!new PublicKey(info.owner).equals(owners[i])) throw Error(`${names[i]} is not owned by ${owners[i].toBase58()}`);
    });
    const registry = decodeAccount('Registry', infos[0].data);
    const instrument = decodeAccount('Instrument', infos[1].data);
    const oracle = decodeAccount('PriceOracle', infos[4].data);
    if (instrument.instrumentId !== 0) throw Error(`instrument id ${instrument.instrumentId} is not 0`);
    if (b58(instrument.oracleAddr) !== keys.oracle.toBase58()) throw Error('instrument oracle does not match the manifest oracle');
    if (instrument.takerFeeBps !== 5 || instrument.makerFeeBps !== 0) {
      throw Error(`instrument fees ${instrument.takerFeeBps}/${instrument.makerFeeBps} bps are not the 5/0 the reference model assumes`);
    }
    if (b58(oracle.instrument) !== keys.instrument.toBase58()) throw Error('oracle instrument does not match the instrument PDA');
    const refused = new Map([
      [ADMIN_PUBKEY, 'admin'],
      [b58(registry.governance), 'governance'],
      [b58(oracle.authority), 'oracle authority'],
      [keys.maker.toBase58(), 'hosted maker'],
    ]);
    for (const persona of personaList) {
      const why = refused.get(persona.publicKey.toBase58());
      if (why) throw Error(`Refusing persona ${persona.name}: it is the ${why} key`);
    }
    market = { tick: instrument.tickSize, lot: instrument.lotSize, governance: b58(registry.governance) };
    return market;
  }

  function decodeUsers(wallets, infos) {
    const users = {};
    wallets.forEach((wallet, i) => {
      const pf = infos[i];
      const account = infos[wallets.length + i];
      users[wallet.toBase58()] = {
        wallet: BigInt(account?.lamports ?? 0),
        portfolio: pf ? decodePortfolio(pf.data, wallet) : null,
        portfolioLamports: BigInt(pf?.lamports ?? 0),
      };
    });
    return users;
  }

  // One atomic multi-account read: registry, vault, oracle, book, the users'
  // portfolios and wallets, plus optional extra raw accounts.
  async function readState(users = [], { commitment = 'confirmed', minContextSlot, extra = [] } = {}) {
    const wallets = [...new Set(users.map(b58))].map(u => new PublicKey(u));
    const list = [keys.registry, keys.vault, keys.oracle, keys.book, ...wallets.map(portfolioKey), ...wallets, ...extra];
    const config = minContextSlot === undefined ? { commitment } : { commitment, minContextSlot };
    const { context, value } = await connection.getMultipleAccountsInfoAndContext(list, config);
    const [reg, vault, oracle, book] = value;
    if (!reg || !vault || !oracle || !book) throw Error('market account missing');
    const registry = { ...decodeAccount('Registry', reg.data), unsettled: reg.data[REGISTRY_UNSETTLED_OFFSET] !== 0 };
    return {
      slot: context.slot,
      registry,
      vault: { ...decodeAccount('Vault', vault.data), lamports: BigInt(vault.lamports) },
      oracle: decodeAccount('PriceOracle', oracle.data),
      book: decodeBook(book.data),
      users: decodeUsers(wallets, value.slice(4, 4 + 2 * wallets.length)),
      currentBatchId: registry.batchIdCounter - 1n,
      extra: value.slice(4 + 2 * wallets.length),
    };
  }

  const decodeBatchInfo = info => (info ? decodeAccount('Batch', info.data) : null);
  function decodeResultsInfo(info) {
    if (!info) return null;
    try { return decodeResults(info.data); } catch { return null; }
  }

  async function readBatch(id) {
    const [batch, results] = await connection.getMultipleAccountsInfo([batchKey(id), resultsKey(id)], 'confirmed');
    return { batch: decodeBatchInfo(batch), results: decodeResultsInfo(results) };
  }

  async function getTx(signature) {
    for (let i = 0; i < 20; i++) {
      const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (tx) return tx;
      await sleep(pollMs);
    }
    return null;
  }

  function toRecord(label, signature, tx, signers, signedAt, acceptedAt) {
    const message = tx.transaction.message;
    return {
      label,
      signature,
      slot: tx.slot,
      fee: BigInt(tx.meta.fee),
      signers: signers.map(p => p.name),
      signedAt,
      acceptedAt,
      accounts: (message.staticAccountKeys ?? message.accountKeys).map(b58),
      preBalances: tx.meta.preBalances.map(BigInt),
      postBalances: tx.meta.postBalances.map(BigInt),
      logs: tx.meta.logMessages ?? [],
      err: tx.meta.err ?? null,
    };
  }

  // Simulate (sigVerify) the exact signed bytes, then send; nothing is sent
  // when simulation fails. Acceptance is observed via confirmSignature.
  async function send(label, ixs, signers, { simulateOnly = false } = {}) {
    signers.forEach(assertPersona);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight });
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }), ...ixs);
    const signedAt = now();
    tx.sign(...signers.map(p => p.keypair));
    const raw = tx.serialize();
    const sim = await connection.simulateTransaction(VersionedTransaction.deserialize(raw), { sigVerify: true, commitment: 'confirmed' });
    if (sim.value.err) throw new SimulationError(label, sim.value.err, sim.value.logs, signedAt);
    if (simulateOnly) return { label, simulated: true, logs: sim.value.logs ?? [] };
    const signature = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 });
    log(`${label}: sent ${signature}`);
    try {
      await confirm(connection, signature, { timeoutMs: confirmTimeoutMs, pollIntervalMs: 500, lastValidBlockHeight });
    } catch (error) {
      error.signature = signature;
      error.signedAt = signedAt;
      const code = /"Custom":(\d+)/.exec(error.message);
      if (code) error.code = Number(code[1]);
      // A landed failure still paid its fee; keep it for wallet reconciliation.
      if (code) {
        const landed = await getTx(signature).catch(() => null);
        if (landed) records.push(toRecord(label, signature, landed, signers, signedAt, now()));
      }
      throw error;
    }
    const acceptedAt = now();
    const landed = await getTx(signature);
    if (!landed) throw Error(`${label}: confirmed ${signature} but the transaction is not retrievable`);
    const record = toRecord(label, signature, landed, signers, signedAt, acceptedAt);
    records.push(record);
    return record;
  }

  function delta(record, key) {
    const i = record.accounts.indexOf(b58(key));
    return i < 0 ? 0n : record.postBalances[i] - record.preBalances[i];
  }

  async function waitOpenBatch() {
    const deadline = now() + settleTimeoutMs;
    for (;;) {
      const state = await readState([]);
      const { batch } = await readBatch(state.currentBatchId);
      if (batch && batch.status === BATCH.committing && !state.registry.unsettled &&
          BigInt(state.slot) + 2n < batch.commitDeadlineSlot) {
        return { batchId: state.currentBatchId, batch, state };
      }
      if (now() > deadline) throw Error('no open batch within the settle timeout (is the hosted keeper running?)');
      await sleep(pollMs);
    }
  }

  // Sends when the market is open; retries a paused/unsettled (602) or
  // closed-batch (502) rejection with a freshly built instruction list.
  async function attempt(label, build, signers) {
    for (let i = 0; ; i++) {
      const open = await waitOpenBatch();
      try {
        return { ...(await send(label, build(open.batchId), signers)), batchId: open.batchId };
      } catch (error) {
        if (!RETRY_CODES.has(error.code) || i >= 5) throw error;
        log(`${label}: retry after custom error ${error.code}`);
      }
    }
  }

  // Simulation-only rejection probe: never sends.
  async function expectReject(label, ixs, signers, code) {
    try {
      const sim = await send(label, ixs, signers, { simulateOnly: true });
      return { code: null, logs: sim.logs, unexpected: `simulation succeeded; expected custom error ${code}` };
    } catch (error) {
      if (!(error instanceof SimulationError)) throw error;
      return { code: error.code ?? null, logs: error.logs, unexpected: error.code === code ? null : `custom error ${error.code}, expected ${code}` };
    }
  }

  const ix = (keysList, name, params) => new TransactionInstruction({
    programId: core,
    keys: keysList,
    data: Buffer.from(encodeInstruction('core', name, params, null)),
  });
  const ixInit = pk => ix([meta(pk, true, true), meta(portfolioKey(pk)), meta(SystemProgram.programId, false)],
    'InitPortfolioForUser', { user: pk.toBytes() });
  const ixDeposit = (pk, amount) => ix([meta(portfolioKey(pk)), meta(pk, true, true), meta(SystemProgram.programId, false), meta(keys.vault)],
    'Deposit', { amount: BigInt(amount) });
  const ixWithdraw = (pk, amount) => ix([meta(portfolioKey(pk)), meta(pk, true, true), meta(keys.vault),
    meta(keys.registry, false), meta(keys.instrument, false), meta(keys.oracle, false)], 'Withdraw', { amount: BigInt(amount) });
  const ixPost = (pk, batchId, order) => ix([meta(portfolioKey(pk)), meta(pk, false, true), meta(batchKey(batchId)),
    meta(keys.registry, false), meta(keys.book), meta(matcher, false), meta(keys.instrument, false), meta(keys.oracle, false),
    meta(keys.vault, false)], 'PostOrder', {
    side: order.side,
    isMaker: Boolean(order.isMaker),
    price: BigInt(order.price),
    qty: BigInt(order.qty),
    instrumentId: 0,
    reduceOnly: Boolean(order.reduceOnly),
  });
  const ixCancel = (pk, orderId) => ix([meta(portfolioKey(pk)), meta(pk, true, true), meta(keys.book), meta(matcher, false),
    meta(keys.registry, false)], 'CancelRestingOrder', { orderId: BigInt(orderId) });
  const ixCancelAll = pk => ix([meta(portfolioKey(pk)), meta(pk, false, true), meta(matcher, false), meta(keys.book),
    meta(keys.registry, false)], 'CancelAllRestingOrders', { numBooks: 1 });

  // InitPortfolioForUser (self-funded) only when the portfolio is missing.
  async function ensurePortfolio(persona) {
    const pk = persona.publicKey;
    const before = await readState([pk]);
    if (before.users[pk.toBase58()].portfolio) return null;
    const record = await send(`InitPortfolioForUser ${persona.name}`, [ixInit(pk)], [persona]);
    const after = await readState([pk], { minContextSlot: record.slot });
    const user = after.users[pk.toBase58()];
    if (!user.portfolio) throw Error(`${persona.name}: portfolio missing after InitPortfolioForUser`);
    const rent = user.portfolioLamports;
    if (delta(record, pk) !== -(record.fee + rent)) {
      throw Error(`${persona.name}: init wallet delta ${delta(record, pk)} is not -(fee ${record.fee} + rent ${rent})`);
    }
    return { record, rent };
  }

  async function deposit(persona, amount) {
    const value = BigInt(amount);
    if (value <= 0n || value > MAX_DEPOSIT) throw Error(`deposit ${value} outside (0, ${MAX_DEPOSIT}] lamports`);
    const pk = persona.publicKey;
    const before = await readState([pk]);
    const record = await attempt(`Deposit ${persona.name} ${value}`, () => [ixDeposit(pk, value)], [persona]);
    const after = await readState([pk], { minContextSlot: record.slot });
    return { record, before, after, amount: value };
  }

  async function withdraw(persona, amount) {
    const value = BigInt(amount);
    const pk = persona.publicKey;
    const before = await readState([pk]);
    const record = await attempt(`Withdraw ${persona.name} ${value}`, () => [ixWithdraw(pk, value)], [persona]);
    const after = await readState([pk], { minContextSlot: record.slot });
    return { record, before, after, amount: value };
  }

  const withdrawReject = (persona, amount) =>
    expectReject(`Withdraw ${persona.name} ${amount} (expect reject)`, [ixWithdraw(persona.publicKey, BigInt(amount))], [persona], ERR.insufficientFunds);

  // Posts every entry in ONE transaction (so all land in the same batch).
  // New order ids: per user, the new reservations in instruction order; ids
  // in one transaction are consecutive, which fills any already settled.
  async function postOrders(label, entries) {
    const signers = [...new Map(entries.map(e => [e.persona.publicKey.toBase58(), e.persona])).values()];
    const users = signers.map(p => p.publicKey);
    const before = await readState(users);
    const record = await attempt(label, id => entries.map(e => ixPost(e.persona.publicKey, id, e)), signers);
    const after = await readState(users, { minContextSlot: record.slot });
    const orders = entries.map(e => ({ ...e, user: e.persona.publicKey.toBase58(), orderId: null, initialReserve: null }));
    let base = null;
    for (const user of users.map(b58)) {
      const known = new Set(before.users[user].portfolio.orders.filter(o => o.remainingQty > 0n).map(o => o.orderId));
      const fresh = after.users[user].portfolio.orders
        .filter(o => o.remainingQty > 0n && !known.has(o.orderId))
        .sort((a, b) => (a.orderId < b.orderId ? -1 : 1));
      const mine = orders.map((o, i) => [o, i]).filter(([o]) => o.user === user);
      if (fresh.length === mine.length) {
        mine.forEach(([o, i], k) => {
          o.orderId = fresh[k].orderId;
          o.initialReserve = fresh[k].initialReserve;
          if (base === null) base = fresh[k].orderId - BigInt(i);
        });
      }
    }
    if (base !== null) orders.forEach((o, i) => { if (o.orderId === null) o.orderId = base + BigInt(i); });
    return { record, batchId: record.batchId, before, after, orders };
  }

  // Waits for the hosted keeper to settle the batch. Each poll reads the
  // batch, its results and every tracked portfolio in one atomic read, so
  // the last pre-settlement snapshot is consistent with the batch status.
  async function waitSettled(batchId, users = []) {
    const tracked = new Set([...users.map(b58), keys.maker.toBase58()]);
    const deadline = now() + settleTimeoutMs;
    const id = BigInt(batchId);
    let pre = null;
    for (;;) {
      const state = await readState([...tracked], { extra: [batchKey(id), resultsKey(id), batchKey(id + 1n)] });
      const [batchInfo, resultsInfo, nextInfo] = state.extra;
      const batch = decodeBatchInfo(batchInfo);
      const results = decodeResultsInfo(resultsInfo);
      const own = results && results.batchId === id ? results : null;
      const missing = (own ? own.fills.map(f => b58(f.user)) : []).filter(u => !tracked.has(u));
      missing.forEach(u => tracked.add(u));
      if (batch?.status === BATCH.settled) {
        const next = decodeBatchInfo(nextInfo);
        return { batchId: id, batch, results: own, pre, post: state, settledAt: now(), raced: next?.status === BATCH.settled };
      }
      if (!missing.length) pre = state;
      if (now() > deadline) throw Error(`batch ${id} not settled within ${settleTimeoutMs} ms (keeper down?)`);
      await sleep(pollMs);
    }
  }

  // The settle transaction is found through the results/batch account
  // history; its effective receipt is parsed from the core-level logs.
  async function findSettleTx(batchId, results) {
    const allocations = results ? results.fills.map(f => f.qty) : [];
    for (const address of [resultsKey(batchId), batchKey(batchId)]) {
      const signatures = await connection.getSignaturesForAddress(address, { limit: 25 }, 'confirmed');
      for (const item of signatures) {
        if (item.err) continue;
        const tx = await getTx(item.signature);
        if (!tx || tx.meta.err) continue;
        let receipt;
        try {
          receipt = settlementReceipt(tx.meta.logMessages, { programId: core, batchId, allocations });
        } catch (error) {
          if (error.message === 'Effective settlement receipt unavailable') continue;
          throw error;
        }
        const record = toRecord(`settle batch ${batchId}`, item.signature, tx, [], null, null);
        return { signature: item.signature, slot: tx.slot, receipt, vaultLamportDelta: delta(record, keys.vault) };
      }
    }
    return null;
  }

  // Oracle prices that may have been the settlement conversion: UpdatePrice
  // transactions in (fromSlot, toSlot], latest first, then the observed
  // pre/post oracle prices.
  async function conversionCandidates(fromSlot, toSlot, observed) {
    const prices = [];
    const signatures = await connection.getSignaturesForAddress(keys.oracle, { limit: 50 }, 'confirmed');
    for (const item of signatures) {
      if (item.err || item.slot <= fromSlot || item.slot > toSlot) continue;
      const tx = await getTx(item.signature);
      if (!tx) continue;
      const message = tx.transaction.message;
      const accounts = (message.staticAccountKeys ?? message.accountKeys).map(b58);
      for (const instruction of message.compiledInstructions ?? message.instructions) {
        if (accounts[instruction.programIdIndex] !== oracleProgram.toBase58()) continue;
        const data = Buffer.from(typeof instruction.data === 'string' ? bs58.decode(instruction.data) : instruction.data);
        if (data[0] === 1 && data.length >= 9) prices.push(data.readBigInt64LE(1));
      }
    }
    return [...new Set([...prices, ...observed].map(String))].map(BigInt);
  }

  // Exact model check of one settled batch against the reference ledger.
  async function verifyBatch(settled) {
    const failures = [];
    const { pre, post, results, batchId } = settled;
    if (!results) return { pass: false, failures: [`batch ${batchId}: results account unavailable`], fills: [], foreign: [] };
    if (!pre) return { pass: false, failures: [`batch ${batchId}: no pre-settlement snapshot (settled before the first poll)`], fills: [], foreign: [] };
    if (settled.raced) failures.push(`batch ${batchId}: batch ${batchId + 1n} settled before the post read; rerun`);
    const settle = results.numFills ? await findSettleTx(batchId, results) : null;
    if (!settle && results.numFills) return { pass: false, failures: [`batch ${batchId}: settle transaction receipt not found`], fills: [], foreign: [] };
    if (settle && settle.vaultLamportDelta !== 0n) failures.push(`settle moved ${settle.vaultLamportDelta} vault lamports (expected 0)`);
    const effective = settle ? settle.receipt : [];
    const fills = results.fills.map((f, i) => ({
      user: b58(f.user),
      orderId: f.orderId,
      allocated: f.qty,
      qty: effective[i] ?? 0n,
      price: f.price,
      isMaker: f.isMaker,
      auction: f.auction,
      signed: ((f.auction === 0) === f.isMaker ? 1n : -1n) * (effective[i] ?? 0n),
    }));
    const live = fills.filter(f => f.qty > 0n);
    const users = [...new Set(live.map(f => f.user))];
    const foreign = users.filter(u => !personaKeys.has(u));
    for (const user of users) {
      if (!pre.users[user]?.portfolio || !post.users[user]?.portfolio) failures.push(`fill user ${user} has no pre/post snapshot`);
    }
    if (failures.length) return { pass: false, failures, fills, foreign, settle };
    if (!users.length) return { pass: true, failures, fills, foreign, settle, conversion: null };
    const candidates = await conversionCandidates(pre.slot, settle.slot, [pre.oracle.price, post.oracle.price]);
    const attempts = [];
    for (const conversion of candidates) {
      const request = {
        fund: String(pre.vault.insuranceFund),
        collateral: Object.fromEntries(users.map(u => [u, String(pre.users[u].portfolio.equity)])),
        events: [
          ...users.flatMap(u => {
            const position = pre.users[u].portfolio.position;
            if (!position) return [];
            const entry = entryFraction(position);
            return [{ kind: 'position', account: u, quantity_lots: String(position.qty), entry_numerator: String(entry.num), entry_denominator: String(entry.den) }];
          }),
          ...live.map(f => ({ account: f.user, quantity_lots: String(f.signed), fill_price: String(f.price), conversion_price: String(conversion), maker: f.isMaker })),
        ],
      };
      const expected = model(request);
      const mismatches = [];
      const want = (label, actual, value) => { if (BigInt(actual) !== BigInt(value)) mismatches.push(`${label}: model ${value}, chain ${actual}`); };
      let sumEquity = 0n;
      for (const user of users) {
        const a = pre.users[user].portfolio;
        const b = post.users[user].portfolio;
        sumEquity += b.equity - a.equity;
        want(`${user} equity`, b.equity, expected.collateral[user]);
        const position = expected.positions[user];
        want(`${user} qty`, b.qty, position?.qty ?? 0);
        if (position && BigInt(position.qty) !== 0n && b.position) {
          const entry = entryFraction(b.position);
          if (BigInt(position.entry_numerator) * entry.den !== entry.num * BigInt(position.entry_denominator)) {
            mismatches.push(`${user} entry: model ${position.entry_numerator}/${position.entry_denominator}, chain ${entry.num}/${entry.den}`);
          }
        }
        want(`${user} fees delta`, b.feesPaid - a.feesPaid, expected.fees[user] ?? 0);
        want(`${user} realized lamports delta`, b.realizedLamports - a.realizedLamports, expected.realized_lamports[user] ?? 0);
        want(`${user} funding delta`, b.fundingPaid - a.fundingPaid, 0);
      }
      want('insurance fund', post.vault.insuranceFund, expected.fund);
      want('bad debt delta', post.vault.uncoveredBadDebt - pre.vault.uncoveredBadDebt, expected.debt);
      want('vault balance delta - lamport delta', (post.vault.balance - pre.vault.balance) - (post.vault.lamports - pre.vault.lamports), sumEquity);
      if (!mismatches.length) return { pass: !failures.length, failures, fills, foreign, settle, conversion, expected, request };
      attempts.push({ conversion: String(conversion), mismatches });
    }
    failures.push(`model mismatch for every conversion candidate: ${JSON.stringify(attempts)}`);
    return { pass: false, failures, fills, foreign, settle, attempts };
  }

  async function trade(label, entries) {
    const posted = await postOrders(label, entries);
    const settled = await waitSettled(posted.batchId, entries.map(e => e.persona.publicKey));
    const verdict = await verifyBatch(settled);
    return { label, posted, settled, verdict };
  }

  const floorTick = price => (BigInt(price) / market.tick) * market.tick;
  const ceilTick = price => ceilDiv(BigInt(price), market.tick) * market.tick;

  // Row prices sit strictly inside every non-persona quote, so scripted
  // fills only cross persona orders: center = oracle price floored to tick,
  // step = max(tick, 2 bps of center) narrowed until center +/- 2 steps
  // clears the foreign book. Computed before any deposit.
  function pricePlan(state) {
    const center = floorTick(state.oracle.price);
    const foreign = state.book.orders.filter(o => !personaKeys.has(o.user));
    const buys = foreign.filter(o => o.side === BUY).map(o => o.price);
    const sells = foreign.filter(o => o.side === SELL).map(o => o.price);
    const maxBuy = buys.length ? buys.reduce((a, b) => (a > b ? a : b)) : null;
    const minSell = sells.length ? sells.reduce((a, b) => (a < b ? a : b)) : null;
    const blocked = step => (maxBuy !== null && center - 2n * step <= maxBuy) || (minSell !== null && center + 2n * step >= minSell);
    let step = floorTick(center / 5000n);
    if (step < market.tick) step = market.tick;
    while (step > market.tick && blocked(step)) step -= market.tick;
    if (blocked(step)) throw Error(`hosted spread too tight around ${center} (best foreign bid ${maxBuy}, ask ${minSell})`);
    return { mid: center, step, maxBuy, minSell };
  }

  const cancelAll = persona => attempt(`CancelAll ${persona.name}`, () => [ixCancelAll(persona.publicKey)], [persona]);

  async function cancel(persona, orderId) {
    const pk = persona.publicKey;
    const before = await readState([pk]);
    const record = await attempt(`Cancel ${persona.name} #${orderId}`, () => [ixCancel(pk, orderId)], [persona]);
    const after = await readState([pk], { minContextSlot: record.slot });
    return { record, before, after };
  }

  // Leaves a persona flat with no orders and its free collateral withdrawn.
  async function cleanup(persona) {
    const pk = persona.publicKey;
    const user = pk.toBase58();
    const notes = [];
    let pf = (await readState([pk])).users[user].portfolio;
    if (!pf) return { flat: true, residualQty: '0', withdrawn: '0', equityLeft: '0', notes };
    if (pf.openOrders.length) await cancelAll(persona);
    for (let i = 0; i < 3; i++) {
      const state = await readState([pk]);
      pf = state.users[user].portfolio;
      if (pf.qty === 0n) break;
      const side = pf.qty > 0n ? SELL : BUY;
      const qty = abs(pf.qty);
      let price = crossingPrice(hostedLadder(state.book, keys.maker.toBase58()), side, qty);
      if (price === null) {
        price = side === SELL ? floorTick(state.oracle.price * 99n / 100n) : ceilTick(state.oracle.price * 101n / 100n);
        notes.push(`hosted depth short; closing at ${price}`);
      }
      const posted = await postOrders(`cleanup close ${persona.name}`, [{ persona, side, price, qty, isMaker: false, reduceOnly: true }]);
      await waitSettled(posted.batchId, [pk]);
    }
    pf = (await readState([pk])).users[user].portfolio;
    if (pf.openOrders.length) await cancelAll(persona);
    pf = (await readState([pk])).users[user].portfolio;
    let withdrawn = 0n;
    const amount = minBig(pf.equity, pf.freeCollateral);
    if (amount > 0n) {
      try {
        await withdraw(persona, amount);
        withdrawn = amount;
      } catch (error) {
        notes.push(`withdraw ${amount} failed: ${error.message}`);
      }
    }
    pf = (await readState([pk])).users[user].portfolio;
    return { flat: pf.qty === 0n && !pf.openOrders.length, residualQty: String(pf.qty), withdrawn: String(withdrawn), equityLeft: String(pf.equity), notes };
  }

  async function waitFinalized(users, slot) {
    const deadline = now() + settleTimeoutMs;
    for (;;) {
      const state = await readState(users, { commitment: 'finalized' });
      if (state.slot >= slot) return state;
      if (now() > deadline) throw Error(`slot ${slot} not finalized in time`);
      await sleep(pollMs);
    }
  }

  return {
    keys,
    core,
    matcher,
    personas,
    records,
    get market() { return market; },
    portfolioKey,
    init,
    readState,
    readBatch,
    send,
    delta,
    attempt,
    expectReject,
    withdrawReject,
    ensurePortfolio,
    deposit,
    withdraw,
    postOrders,
    ixPost,
    waitOpenBatch,
    waitSettled,
    findSettleTx,
    verifyBatch,
    trade,
    pricePlan,
    floorTick,
    ceilTick,
    cancel,
    cancelAll,
    cleanup,
    waitFinalized,
  };
}
// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------
function checker() {
  const steps = [];
  const push = (label, pass, expected, observed) => { steps.push({ label, pass, expected: String(expected), observed: String(observed) }); return pass; };
  return {
    steps,
    eq: (label, observed, expected) => push(label, String(observed) === String(expected), expected, observed),
    ok: (label, pass, expected, observed) => push(label, Boolean(pass), expected, observed),
    fail: (label, message) => push(label, false, 'no error', message),
    get pass() { return steps.length > 0 && steps.every(step => step.pass); },
  };
}

const userOf = (state, persona) => state.users[persona.publicKey.toBase58()];
const pfOf = (state, persona) => userOf(state, persona).portfolio;
const fillsOf = (verdict, persona) => verdict.fills.filter(f => f.user === persona.publicKey.toBase58() && f.qty > 0n);
const sum = values => values.reduce((a, b) => a + b, 0n);

function summarizePortfolio(pf) {
  if (!pf) return null;
  return {
    equity: pf.equity,
    principal: pf.principal,
    freeCollateral: pf.freeCollateral,
    reservedCollateral: pf.reservedCollateral,
    feesPaid: pf.feesPaid,
    realizedLamports: pf.realizedLamports,
    qty: pf.qty,
    entry: pf.position ? entryFraction(pf.position) : null,
    openOrders: pf.openOrders.map(o => ({ orderId: o.orderId, side: o.side, price: o.price, remainingQty: o.remainingQty, reserved: proRata(o.initialReserve, o.originalQty, o.remainingQty) })),
  };
}

function snapshot(state, personas) {
  return plain({
    slot: state.slot,
    oraclePrice: state.oracle.price,
    vault: { balance: state.vault.balance, lamports: state.vault.lamports, insuranceFund: state.vault.insuranceFund, uncoveredBadDebt: state.vault.uncoveredBadDebt },
    personas: Object.fromEntries(personas.map(p => [p.name, { wallet: userOf(state, p).wallet, portfolio: summarizePortfolio(pfOf(state, p)) }])),
  });
}

// Records a model-verified batch into the row checker.
function checkTrade(c, ctx, result) {
  ctx.batchIds.push(String(result.posted.batchId));
  ctx.verdicts.push(result.verdict);
  c.ok(`${result.label}: batch ${result.posted.batchId} matches the reference model`, result.verdict.pass,
    'exact equity, position, entry, fee, realized and fund deltas', result.verdict.failures.join('; ') || `conversion ${result.verdict.conversion}`);
  return result.verdict;
}

// Explicit 5 bps taker fee and fund delta for one verified batch.
function checkFees(c, label, result) {
  const { verdict, settled } = result;
  if (!verdict.pass) return;
  const conversion = verdict.conversion;
  const takerFills = verdict.fills.filter(f => f.qty > 0n && !f.isMaker);
  const fee = f => ceilDiv(f.qty * abs(f.price) * 500n, conversion);
  const expected = sum(takerFills.map(fee));
  const users = [...new Set(takerFills.map(f => f.user))];
  const charged = sum(users.map(u => settled.post.users[u].portfolio.feesPaid - settled.pre.users[u].portfolio.feesPaid));
  c.eq(`${label}: taker fees = sum ceil(qty*price*5bps/conversion)`, charged, expected);
  // The fund is the realized-PnL counterparty and debits floor away from zero,
  // so it also absorbs the negated realized PnL (rounding dust included).
  const fillUsers = [...new Set(verdict.fills.filter(f => f.qty > 0n).map(f => f.user))];
  const realized = sum(fillUsers.map(u => settled.post.users[u].portfolio.realizedLamports - settled.pre.users[u].portfolio.realizedLamports));
  c.eq(`${label}: insurance fund delta = taker fees - realized PnL`, settled.post.vault.insuranceFund - settled.pre.vault.insuranceFund, expected - realized);
  for (const f of verdict.fills.filter(item => item.qty > 0n && item.isMaker)) {
    c.eq(`${label}: maker ${f.user} pays no fee`, settled.post.users[f.user].portfolio.feesPaid - settled.pre.users[f.user].portfolio.feesPaid, 0);
  }
}

// Closes X's position against persona maker M at mid in one batch.
async function closePair(driver, ctx, c, M, X, plan) {
  const state = await driver.readState([X.publicKey]);
  const qty = pfOf(state, X).qty;
  if (qty === 0n) return null;
  const side = qty > 0n ? SELL : BUY;
  const result = await driver.trade(`close ${X.name}`, [
    { persona: M, side: side === SELL ? BUY : SELL, price: plan.mid, qty: abs(qty), isMaker: true },
    { persona: X, side, price: plan.mid, qty: abs(qty), isMaker: false, reduceOnly: true },
  ]);
  checkTrade(c, ctx, result);
  c.eq(`close ${X.name}: flat`, pfOf(result.settled.post, X).qty, 0);
  return result;
}

async function rowPlan(driver) {
  return driver.pricePlan(await driver.readState([]));
}

const ROWS = {
  'P0-1': {
    personas: ['qa'],
    async run(driver, P, c) {
      const qa = P.qa;
      const amount = P01_DEPOSIT;
      const dep = await driver.deposit(qa, amount);
      const r = dep.record;
      c.eq('deposit: wallet tx delta = -(amount + fee)', driver.delta(r, qa.publicKey), -(amount + r.fee));
      c.eq('deposit: vault lamports tx delta = +amount', driver.delta(r, driver.keys.vault), amount);
      c.eq('deposit: collateral (equity) delta', pfOf(dep.after, qa).equity - pfOf(dep.before, qa).equity, amount);
      c.eq('deposit: principal delta', pfOf(dep.after, qa).principal - pfOf(dep.before, qa).principal, amount);
      const reloaded = await driver.waitFinalized([qa.publicKey], r.slot);
      c.eq('reload (finalized): collateral survives', pfOf(reloaded, qa).equity, pfOf(dep.after, qa).equity);
      const wd = await driver.withdraw(qa, amount);
      c.eq('withdraw 0.2 SOL: wallet tx delta = amount - fee', driver.delta(wd.record, qa.publicKey), amount - wd.record.fee);
      c.eq('withdraw 0.2 SOL: vault lamports tx delta = -amount', driver.delta(wd.record, driver.keys.vault), -amount);
      c.eq('withdraw 0.2 SOL: collateral delta', pfOf(wd.after, qa).equity - pfOf(wd.before, qa).equity, -amount);
    },
  },
  'P0-4': {
    personas: ['qa'],
    async run(driver, P, c) {
      const qa = P.qa;
      const dep = await driver.deposit(qa, ROW_DEPOSIT);
      c.eq('deposit: vault lamports tx delta', driver.delta(dep.record, driver.keys.vault), ROW_DEPOSIT);
      const pf = pfOf(dep.after, qa);
      c.eq('flat before withdraw', pf.qty, 0);
      const free = pf.freeCollateral;
      c.ok('free collateral positive', free > 0n, '> 0', free);
      const over = await driver.withdrawReject(qa, free + 1n);
      c.eq('over-withdraw (free + 1) rejects InsufficientFunds (simulation, not sent)', over.code, ERR.insufficientFunds);
      const wd = await driver.withdraw(qa, free);
      c.eq('withdraw free: vault lamports tx delta = -free', driver.delta(wd.record, driver.keys.vault), -free);
      c.eq('withdraw free: wallet tx delta = free - fee', driver.delta(wd.record, qa.publicKey), free - wd.record.fee);
      c.eq('withdraw free: collateral delta', pfOf(wd.after, qa).equity - pfOf(wd.before, qa).equity, -free);
      const second = await driver.withdrawReject(qa, 1n);
      c.eq('second withdrawal (1 lamport) rejects InsufficientFunds (simulation, not sent)', second.code, ERR.insufficientFunds);
    },
  },
  'P0-5': {
    personas: ['maker'],
    async run(driver, P, c) {
      const M = P.maker;
      const plan = await rowPlan(driver);
      await driver.deposit(M, ROW_DEPOSIT);
      const price = driver.floorTick(plan.mid * 98n / 100n);
      const posted = await driver.postOrders('P0-5 maker bid', [{ persona: M, side: BUY, price, qty: 1n, isMaker: true }]);
      const [order] = posted.orders;
      const a = pfOf(posted.before, M);
      const b = pfOf(posted.after, M);
      const reserved = b.reservedCollateral - a.reservedCollateral;
      c.eq('reservation delta = new order initial reserve', reserved, order.initialReserve);
      const options = [posted.before.oracle.price, posted.after.oracle.price].map(conv => reservation(1n, price, conv));
      c.ok('reservation = reservation(1 lot, limit, conversion)', options.some(v => v === reserved), options.join(' or '), reserved);
      const free = b.freeCollateral;
      const over = await driver.withdrawReject(M, free + 1n);
      c.eq('withdraw free + 1 rejects InsufficientFunds (simulation, not sent)', over.code, ERR.insufficientFunds);
      const wd = await driver.withdraw(M, free);
      c.eq('withdraw capped by the reservation: vault tx delta = -free', driver.delta(wd.record, driver.keys.vault), -free);
      c.ok('free collateral excludes the reservation', pfOf(wd.after, M).equity >= reserved, `equity >= ${reserved}`, pfOf(wd.after, M).equity);
      const cancelled = await driver.cancel(M, order.orderId);
      c.eq('cancel releases the full reservation', pfOf(cancelled.before, M).reservedCollateral - pfOf(cancelled.after, M).reservedCollateral, order.initialReserve);
    },
  },
  'P0-6': {
    personas: ['maker', 'taker', 'qa'],
    async run(driver, P, c, ctx) {
      const { maker: M, taker: T, qa: Q } = P;
      const plan = await rowPlan(driver);
      for (const persona of [M, T, Q]) await driver.deposit(persona, ROW_DEPOSIT);
      const up = plan.mid + plan.step;
      const open = await driver.trade('P0-6 open', [
        { persona: M, side: SELL, price: plan.mid, qty: 3n, isMaker: true },
        { persona: T, side: BUY, price: plan.mid, qty: 2n, isMaker: false },
        { persona: Q, side: BUY, price: plan.mid, qty: 1n, isMaker: false },
      ]);
      checkTrade(c, ctx, open);
      checkFees(c, 'open', open);
      c.eq('open: taker long 2', pfOf(open.settled.post, T).qty, 2);
      c.eq('open: qa long 1', pfOf(open.settled.post, Q).qty, 1);
      const partial = await driver.trade('P0-6 partial close', [
        { persona: M, side: BUY, price: up, qty: 2n, isMaker: true },
        { persona: T, side: SELL, price: up, qty: 1n, isMaker: false, reduceOnly: true },
        { persona: Q, side: SELL, price: up, qty: 1n, isMaker: false, reduceOnly: true },
      ]);
      checkTrade(c, ctx, partial);
      checkFees(c, 'partial close', partial);
      for (const persona of [T, Q]) {
        const realized = pfOf(partial.settled.post, persona).realizedLamports - pfOf(partial.settled.pre, persona).realizedLamports;
        c.ok(`partial close: ${persona.name} realized PnL positive (exact value model-checked)`, realized > 0n, '> 0', realized);
      }
      const full = await driver.trade('P0-6 full close', [
        { persona: M, side: BUY, price: up, qty: 1n, isMaker: true },
        { persona: T, side: SELL, price: up, qty: 1n, isMaker: false, reduceOnly: true },
      ]);
      checkTrade(c, ctx, full);
      checkFees(c, 'full close', full);
      for (const persona of [M, T]) c.eq(`full close: ${persona.name} flat`, pfOf(full.settled.post, persona).qty, 0);
      c.eq('partial close: qa flat', pfOf(partial.settled.post, Q).qty, 0);
    },
  },
  'P0-7': {
    personas: ['maker', 'taker'],
    async run(driver, P, c, ctx) {
      const { maker: M, taker: T } = P;
      const plan = await rowPlan(driver);
      for (const persona of [M, T]) await driver.deposit(persona, ROW_DEPOSIT);
      const low = plan.mid - plan.step;
      const high = plan.mid + plan.step;
      // Taker orders first: maker role comes from designation, not arrival.
      const both = await driver.trade('P0-7 both auctions', [
        { persona: T, side: SELL, price: low, qty: 1n, isMaker: false },
        { persona: T, side: BUY, price: high, qty: 1n, isMaker: false },
        { persona: M, side: BUY, price: low, qty: 1n, isMaker: true },
        { persona: M, side: SELL, price: high, qty: 1n, isMaker: true },
      ]);
      checkTrade(c, ctx, both);
      const { batch } = both.settled;
      c.eq('bid auction clears at its own uniform price', batch.bidClearingPrice, low);
      c.eq('ask auction clears at its own uniform price', batch.askClearingPrice, high);
      c.eq('bid auction matched qty', batch.matchedBidQty, 1);
      c.eq('ask auction matched qty', batch.matchedAskQty, 1);
      for (const f of both.verdict.fills.filter(item => item.qty > 0n)) {
        const isM = f.user === M.publicKey.toBase58();
        c.eq(`fill #${f.orderId}: maker flag by designation`, f.isMaker, isM);
      }
      for (const persona of [M, T]) c.eq(`${persona.name} flat after both auctions`, pfOf(both.settled.post, persona).qty, 0);
    },
  },
  'P0-9': {
    personas: ['maker', 'taker'],
    async run(driver, P, c, ctx) {
      const { maker: M, taker: T } = P;
      const plan = await rowPlan(driver);
      for (const persona of [M, T]) await driver.deposit(persona, ROW_DEPOSIT);
      const first = await driver.trade('P0-9 partial fill', [
        { persona: M, side: SELL, price: plan.mid, qty: 3n, isMaker: true },
        { persona: T, side: BUY, price: plan.mid, qty: 1n, isMaker: false },
      ]);
      checkTrade(c, ctx, first);
      const askId = first.posted.orders[0].orderId;
      const fills1 = fillsOf(first.verdict, M).filter(f => f.orderId === askId);
      c.eq('batch 1: resting ask filled 1', sum(fills1.map(f => f.qty)), 1);
      const resting1 = pfOf(first.settled.post, M).openOrders.find(o => o.orderId === askId);
      c.eq('batch 1: filled + remaining = submitted', 1n + (resting1?.remainingQty ?? 0n), 3);
      const second = await driver.trade('P0-9 next-batch fill', [
        { persona: T, side: BUY, price: plan.mid, qty: 2n, isMaker: false },
      ]);
      checkTrade(c, ctx, second);
      const fills2 = fillsOf(second.verdict, M).filter(f => f.orderId === askId);
      c.eq('batch 2: same order fills the remaining 2', sum(fills2.map(f => f.qty)), 2);
      c.eq('batch 2: one fill row for the order (no duplicate)', fills2.length, 1);
      c.ok('order fully consumed', !pfOf(second.settled.post, M).openOrders.some(o => o.orderId === askId), 'no remaining reservation', 'checked');
      c.eq('taker long 3 = 1 + 2 (no duplicate fill)', pfOf(second.settled.post, T).qty, 3);
      await closePair(driver, ctx, c, M, T, plan);
    },
  },
  'P0-10': {
    personas: ['maker', 'taker'],
    async run(driver, P, c, ctx) {
      const { maker: M, taker: T } = P;
      const plan = await rowPlan(driver);
      for (const persona of [M, T]) await driver.deposit(persona, ROW_DEPOSIT);
      const unfilled = await driver.postOrders('P0-10 unfilled bid', [{ persona: M, side: BUY, price: plan.mid - 2n * plan.step, qty: 1n, isMaker: true }]);
      const u = unfilled.orders[0];
      const c1 = await driver.cancel(M, u.orderId);
      c.eq('cancel unfilled: full reservation released', pfOf(c1.before, M).reservedCollateral - pfOf(c1.after, M).reservedCollateral, u.initialReserve);
      const part = await driver.trade('P0-10 partial fill', [
        { persona: M, side: BUY, price: plan.mid - plan.step, qty: 3n, isMaker: true },
        { persona: T, side: SELL, price: plan.mid - plan.step, qty: 1n, isMaker: false },
      ]);
      checkTrade(c, ctx, part);
      const o = part.posted.orders[0];
      const c2 = await driver.cancel(M, o.orderId);
      c.eq('cancel partial: reservation released pro rata (2 of 3)', pfOf(c2.before, M).reservedCollateral - pfOf(c2.after, M).reservedCollateral, proRata(o.initialReserve, 3n, 2n));
      c.eq('cancel partial: settled fill untouched', pfOf(c2.after, M).qty, pfOf(part.settled.post, M).qty);
      c.eq('cancel partial: maker long 1', pfOf(c2.after, M).qty, 1);
      await closePair(driver, ctx, c, M, T, plan);
    },
  },
  'P0-12': {
    personas: ['maker', 'taker'],
    async run(driver, P, c, ctx) {
      const { maker: M, taker: T } = P;
      const plan = await rowPlan(driver);
      for (const persona of [M, T]) await driver.deposit(persona, ROW_DEPOSIT);
      const { mid, step } = plan;
      const tFill = result => fillsOf(result.verdict, T)[0]?.price;
      const entryOf = result => pfOf(result.settled.post, T).position;
      const open = await driver.trade('P0-12 open', [
        { persona: M, side: SELL, price: mid, qty: 1n, isMaker: true },
        { persona: T, side: BUY, price: mid, qty: 1n, isMaker: false },
      ]);
      checkTrade(c, ctx, open);
      const px1 = tFill(open);
      const add = await driver.trade('P0-12 add', [
        { persona: M, side: SELL, price: mid + step, qty: 1n, isMaker: true },
        { persona: T, side: BUY, price: mid + step, qty: 1n, isMaker: false },
      ]);
      checkTrade(c, ctx, add);
      const px2 = tFill(add);
      const e2 = entryFraction(entryOf(add));
      // Weighted entry (px1 + px2) / 2, allowing the 1e-12 entry quantum.
      const err = abs(e2.num * 2n - (px1 + px2) * e2.den);
      c.ok('add: weighted entry = (px1 + px2) / 2', err * 1_000_000_000_000n <= 2n * e2.den, `${px1 + px2}/2`, `${e2.num}/${e2.den}`);
      const partial = await driver.trade('P0-12 partial close', [
        { persona: M, side: BUY, price: mid + 2n * step, qty: 1n, isMaker: true },
        { persona: T, side: SELL, price: mid + 2n * step, qty: 1n, isMaker: false, reduceOnly: true },
      ]);
      checkTrade(c, ctx, partial);
      const e3 = entryFraction(entryOf(partial));
      c.eq('partial close: entry unchanged', e3.num * e2.den, e2.num * e3.den);
      c.eq('partial close: long 1', pfOf(partial.settled.post, T).qty, 1);
      const flip = await driver.trade('P0-12 flip', [
        { persona: M, side: BUY, price: mid - step, qty: 2n, isMaker: true },
        { persona: T, side: SELL, price: mid - step, qty: 2n, isMaker: false },
      ]);
      checkTrade(c, ctx, flip);
      const e4 = entryFraction(entryOf(flip));
      c.eq('flip: short 1', pfOf(flip.settled.post, T).qty, -1);
      c.eq('flip: new entry = flip fill price', e4.num, tFill(flip) * e4.den);
      const close = await driver.trade('P0-12 full close', [
        { persona: M, side: SELL, price: mid, qty: 1n, isMaker: true },
        { persona: T, side: BUY, price: mid, qty: 1n, isMaker: false, reduceOnly: true },
      ]);
      checkTrade(c, ctx, close);
      const done = pfOf(close.settled.post, T);
      c.eq('full close: flat', done.qty, 0);
      c.eq('full close: flat position deleted', done.positions.filter(p => p.instrumentId === 0).length, 0);
    },
  },
  'P0-13': {
    personas: ['maker', 'taker'],
    async run(driver, P, c, ctx) {
      const { maker: M, taker: T } = P;
      const plan = await rowPlan(driver);
      for (const persona of [M, T]) await driver.deposit(persona, ROW_DEPOSIT);
      const open = await driver.trade('P0-13 open long 1', [
        { persona: M, side: SELL, price: plan.mid, qty: 1n, isMaker: true },
        { persona: T, side: BUY, price: plan.mid, qty: 1n, isMaker: false },
      ]);
      checkTrade(c, ctx, open);
      c.eq('taker long 1', pfOf(open.settled.post, T).qty, 1);
      const both = await driver.trade('P0-13 two concurrent reduce-only closes', [
        { persona: M, side: BUY, price: plan.mid, qty: 2n, isMaker: true },
        { persona: T, side: SELL, price: plan.mid, qty: 1n, isMaker: false, reduceOnly: true },
        { persona: T, side: SELL, price: plan.mid, qty: 1n, isMaker: false, reduceOnly: true },
      ]);
      checkTrade(c, ctx, both);
      c.eq('effective receipt: taker sells exactly the remaining 1', sum(fillsOf(both.verdict, T).map(f => f.qty)), 1);
      const tAfter = pfOf(both.settled.post, T);
      c.eq('taker flat (nothing opens or flips)', tAfter.qty, 0);
      c.eq('excess reduce-only cancelled (no open taker orders)', tAfter.openOrders.length, 0);
      const open2 = await driver.waitOpenBatch();
      const stale = await driver.expectReject('P0-13 stale reduce-only', [
        driver.ixPost(T.publicKey, open2.batchId, { side: SELL, price: plan.mid, qty: 1n, isMaker: false, reduceOnly: true }),
      ], [T], ERR.reduceOnly);
      c.eq('stale reduce-only after close rejects (simulation, not sent)', stale.code, ERR.reduceOnly);
    },
  },
};
// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------
const lamportsToSol = n => (Number(n) / 1e9).toFixed(9);

// Lamports a persona's wallet lost over a set of records (fees + rent +
// collateral still in the vault).
function walletSpend(driver, records, persona) {
  return -sum(records.map(record => driver.delta(record, persona.publicKey)));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(plain(value), null, 2)}\n`);
}

// Merges row fragments into <out>/rows.json by id (report.js input).
function mergeRows(out, rows) {
  const path = join(out, 'rows.json');
  let existing = [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    existing = Array.isArray(parsed) ? parsed : parsed.rows ?? [];
  } catch (error) {
    if (error.code !== 'ENOENT') throw Error(`${path}: ${error.message}`);
  }
  const byId = new Map(existing.map(row => [row.id, row]));
  for (const row of rows) byId.set(row.id, row);
  const merged = [...byId.values()];
  writeJson(path, merged);
  return merged;
}

const stepLines = (steps, key) => steps.map(s => `${s.pass ? '' : '[FAIL] '}${s.label}: ${s[key]}`).join('\n');

async function runRow(driver, id, { out, log = () => {} } = {}) {
  const spec = ROWS[id];
  if (!spec) throw Error(`unknown row ${id}`);
  const P = {};
  for (const name of spec.personas) {
    if (!driver.personas[name]) throw Error(`${id}: persona ${name} not loaded`);
    P[name] = driver.personas[name];
  }
  const list = Object.values(P);
  const pks = list.map(p => p.publicKey);
  const c = checker();
  const ctx = { batchIds: [], verdicts: [] };
  const notes = [];
  const startRecord = driver.records.length;
  log(`${id}: start`);
  const start = await driver.readState(pks);
  let rent = 0n;
  try {
    for (const persona of list) {
      const init = await driver.ensurePortfolio(persona);
      if (init) {
        rent += init.rent;
        notes.push(`${persona.name}: InitPortfolioForUser (self-funded, rent ${init.rent})`);
      }
    }
    await spec.run(driver, P, c, ctx);
  } catch (error) {
    c.fail(`${id}: run`, error.message);
  }
  const cleanups = {};
  for (const persona of list) {
    try {
      cleanups[persona.name] = await driver.cleanup(persona);
      const done = cleanups[persona.name];
      if (!done.flat) notes.push(`${persona.name}: not flat after cleanup (qty ${done.residualQty})`);
      notes.push(...done.notes.map(note => `${persona.name}: ${note}`));
    } catch (error) {
      c.fail(`${persona.name}: cleanup`, error.message);
    }
  }
  const records = driver.records.slice(startRecord);
  const end = await driver.readState(pks, records.length ? { minContextSlot: Math.max(...records.map(r => r.slot)) } : {});
  for (const persona of list) {
    const observed = userOf(end, persona).wallet - userOf(start, persona).wallet;
    c.eq(`${persona.name}: wallet delta reconciles to the row's transactions`, observed, -walletSpend(driver, records, persona));
  }
  const foreign = [...new Set(ctx.verdicts.flatMap(v => v.foreign ?? []))];
  c.ok('no fills against non-persona orders', foreign.length === 0, 'none', foreign.join(', ') || 'none');
  const fees = sum(records.map(r => r.fee));
  const spent = sum(list.map(p => userOf(start, p).wallet - userOf(end, p).wallet));
  notes.push(`SOL spent ${lamportsToSol(spent)} (fees ${fees}, portfolio rent ${rent}, ${records.length} transactions)`);
  log(`${id}: ${c.pass ? 'pass' : 'fail'}; SOL spent ${lamportsToSol(spent)}`);
  const row = {
    id,
    status: c.pass ? 'pass' : 'fail',
    tier: 'D',
    batchIds: ctx.batchIds,
    signatures: records.map(r => r.signature),
    preSnapshot: snapshot(start, list),
    postSnapshot: snapshot(end, list),
    expected: stepLines(c.steps, 'expected'),
    observed: stepLines(c.steps, 'observed'),
    notes: notes.join('\n'),
  };
  const evidence = { row, steps: c.steps, records, verdicts: ctx.verdicts, cleanups, spent: { lamports: spent, fees, rent } };
  if (out) writeJson(join(out, `${id}.json`), evidence);
  return { row, spent, evidence };
}

async function runRows({ driver, rowIds, out, log = () => {} }) {
  await driver.init();
  mkdirSync(out, { recursive: true });
  const rows = [];
  let spent = 0n;
  for (const id of rowIds) {
    const result = await runRow(driver, id, { out, log });
    rows.push(result.row);
    spent += result.spent;
    mergeRows(out, [result.row]);
  }
  log(`total SOL spent ${lamportsToSol(spent)}`);
  return { rows, spent };
}

// Next scripted taker order: reduce an open position, otherwise alternate.
function nextTakerSide(qty, last) {
  if (qty > 0n) return { side: SELL, reduceOnly: true };
  if (qty < 0n) return { side: BUY, reduceOnly: true };
  return { side: last === BUY ? SELL : BUY, reduceOnly: false };
}

// One 1-lot taker order against the hosted maker ladder. Returns the posted
// order, its settlement and whether the hosted ladder could cross it.
async function takerOrder(driver, persona, label, last) {
  const state = await driver.readState([persona.publicKey]);
  const { side, reduceOnly } = nextTakerSide(pfOf(state, persona).qty, last);
  const ladder = hostedLadder(state.book, driver.keys.maker.toBase58());
  let price = crossingPrice(ladder, side, 1n);
  const onLadder = price !== null;
  if (!onLadder) {
    price = side === SELL ? driver.floorTick(state.oracle.price * 99n / 100n) : driver.ceilTick(state.oracle.price * 101n / 100n);
  }
  const posted = await driver.postOrders(label, [{ persona, side, price, qty: 1n, isMaker: false, reduceOnly }]);
  const settled = await driver.waitSettled(posted.batchId, [persona.publicKey]);
  const filled = sum((settled.results?.fills ?? [])
    .filter(f => b58(f.user) === persona.publicKey.toBase58() && f.orderId === posted.orders[0].orderId).map(f => f.qty));
  if (pfOf(settled.post, persona).openOrders.length) await driver.cancelAll(persona);
  return { side, price, onLadder, posted, settled, filled };
}

async function sampleStatus(fetchStatus, now) {
  const at = now();
  try {
    return { at, body: await fetchStatus() };
  } catch (error) {
    return { at, error: error.message };
  }
}

// P0-33: scripted taker orders spaced over spanMs, recorded by
// LatencyRecorder from chain confirmation (accept) and observed settlement.
async function runLatency({
  driver,
  persona,
  orders = 30,
  spanMs = 32 * 60 * 1000,
  fetchStatus,
  monitoringIgnore = DEFAULT_MONITORING_IGNORE,
  now = Date.now,
  sleep = ms => new Promise(done => setTimeout(done, ms)),
  out,
  log = () => {},
}) {
  await driver.init();
  if (out) mkdirSync(out, { recursive: true });
  const startRecord = driver.records.length;
  const start = await driver.readState([persona.publicKey]);
  const recorder = new LatencyRecorder(now);
  const samples = [];
  const trades = [];
  const notes = [];
  let againstMakerLadder = true;
  let last = SELL;
  const gap = orders > 1 ? Math.floor(spanMs / (orders - 1)) : 0;
  const t0 = now();
  let error = null;
  try {
    const init = await driver.ensurePortfolio(persona);
    if (init) notes.push(`InitPortfolioForUser (self-funded, rent ${init.rent})`);
    await driver.deposit(persona, ROW_DEPOSIT);
    for (let i = 0; i < orders; i++) {
      const wait = t0 + i * gap - now();
      if (wait > 0) await sleep(wait);
      samples.push(await sampleStatus(fetchStatus, now));
      const id = `taker-${i + 1}`;
      let trade;
      try {
        trade = await takerOrder(driver, persona, `P0-33 ${id}`, last);
      } catch (failure) {
        // A sent order that never confirmed or settled stays in the gate as
        // unaccepted/unsettled; it is never silently dropped.
        if (failure.signedAt !== undefined) {
          recorder.sign(id, failure.signedAt, { coldStart: i === 0, role: 'taker' });
        }
        notes.push(`${id}: ${failure.message}`);
        trades.push({ id, error: failure.message });
        continue;
      }
      const record = trade.posted.record;
      recorder.sign(id, record.signedAt, { coldStart: i === 0, role: 'taker' });
      recorder.accept(id, record.acceptedAt);
      recorder.settle(id, trade.settled.settledAt);
      if (!trade.onLadder) againstMakerLadder = false;
      last = trade.side;
      trades.push({
        id, signature: record.signature, batchId: trade.posted.batchId, side: trade.side, price: trade.price,
        onLadder: trade.onLadder, filled: trade.filled, signedAt: record.signedAt, acceptedAt: record.acceptedAt, settledAt: trade.settled.settledAt,
      });
      log(`${id}: accepted ${record.acceptedAt - record.signedAt} ms, settled ${trade.settled.settledAt - record.signedAt} ms, filled ${trade.filled}`);
    }
  } catch (failure) {
    error = failure.message;
    notes.push(`run aborted: ${failure.message}`);
  }
  samples.push(await sampleStatus(fetchStatus, now));
  const monitoring = monitoringGreen(samples, monitoringIgnore);
  recorder.setRunContext({ againstMakerLadder, monitoringGreen: monitoring.green });
  let cleanup = null;
  try {
    cleanup = await driver.cleanup(persona);
  } catch (failure) {
    notes.push(`cleanup failed: ${failure.message}`);
  }
  const records = driver.records.slice(startRecord);
  const end = await driver.readState([persona.publicKey]);
  const spent = userOf(start, persona).wallet - userOf(end, persona).wallet;
  const summary = recorder.summary();
  const pass = summary.verdict.pass && !error;
  log(`P0-33: ${pass ? 'pass' : 'fail'}; SOL spent ${lamportsToSol(spent)}`);
  const rule = `monitoringGreen = every /api/status sample reachable and every check except [${[...monitoringIgnore].join(', ')}] has severity ok`;
  const row = {
    id: 'P0-33',
    status: pass ? 'pass' : 'fail',
    tier: 'D',
    batchIds: trades.filter(t => t.batchId !== undefined).map(t => String(t.batchId)),
    signatures: records.map(r => r.signature),
    expected: '>= 30 taker orders over >= 30 min incl. cold start; accepted p95 <= 5 s; settled p50 <= 20 s, max <= 60 s; against the maker ladder; monitoring green',
    observed: JSON.stringify(plain({ accepted: summary.accepted, settled: summary.settled, failures: summary.verdict.failures })),
    notes: [rule, `againstMakerLadder ${againstMakerLadder}`, ...monitoring.reasons, ...notes, `SOL spent ${lamportsToSol(spent)}`].join('\n'),
  };
  const result = { row, summary, samples, monitoring: { ...monitoring, rule }, trades, cleanup, records, spent };
  if (out) {
    writeJson(join(out, 'P0-33-latency.json'), result);
    mergeRows(out, [row]);
  }
  return result;
}

// P0-35: drive hook for soak.js runSoak. Every `everyPolls` polls it places
// one 1-lot taker order against the hosted ladder, closing any position
// first, so the net position stays within one lot and spend stays minimal.
function createSoakDrive({ driver, persona, everyPolls = 12, depositLamports = ROW_DEPOSIT, log = () => {} }) {
  const stats = { orders: 0, filled: 0n, skipped: 0, batchIds: [], startWallet: null };
  let ready = null;
  let last = SELL;
  async function setup() {
    await driver.init();
    stats.startWallet = userOf(await driver.readState([persona.publicKey]), persona).wallet;
    await driver.ensurePortfolio(persona);
    await driver.deposit(persona, depositLamports);
  }
  async function drive(poll) {
    if (!ready) ready = setup();
    await ready;
    if (poll % everyPolls !== 0) return;
    const state = await driver.readState([persona.publicKey]);
    const { side } = nextTakerSide(pfOf(state, persona).qty, last);
    if (crossingPrice(hostedLadder(state.book, driver.keys.maker.toBase58()), side, 1n) === null) {
      stats.skipped++;
      log(`soak drive ${poll}: no hosted ${side === BUY ? 'ask' : 'bid'} level; skipped`);
      return;
    }
    const trade = await takerOrder(driver, persona, `P0-35 soak taker ${poll}`, last);
    last = trade.side;
    stats.orders++;
    stats.filled += trade.filled;
    stats.batchIds.push(String(trade.posted.batchId));
  }
  drive.cleanup = async () => {
    if (!ready) return null;
    await ready.catch(() => {});
    return driver.cleanup(persona);
  };
  drive.stats = async () => {
    const wallet = stats.startWallet === null ? null : userOf(await driver.readState([persona.publicKey]), persona).wallet;
    return { ...stats, spent: wallet === null ? 0n : stats.startWallet - wallet };
  };
  return drive;
}

async function runSoakMode({ driver, persona, options, log, soak = require('./soak'), audit = require('../runtime/audit') }) {
  mkdirSync(options.out, { recursive: true });
  const deployment = options.deployment;
  const drive = createSoakDrive({ driver, persona, everyPolls: options.driveEvery, log });
  const report = await soak.runSoak({
    durationMs: options.soakMs,
    pollMs: options.soakPollMs,
    observe: () => soak.observeDeployment({ rpcUrl: options.rpc, deployment }),
    audit: () => audit.auditDeployment({ rpcUrl: options.rpc, deployment }),
    drive,
  });
  let cleanup = null;
  const notes = [];
  try {
    cleanup = await drive.cleanup();
  } catch (error) {
    notes.push(`cleanup failed: ${error.message}`);
  }
  const stats = await drive.stats();
  const pass = report.pass === true && stats.orders > 0;
  log(`P0-35: ${pass ? 'pass' : 'fail'}; ${stats.orders} taker orders; SOL spent ${lamportsToSol(stats.spent)}`);
  const row = {
    id: 'P0-35',
    status: pass ? 'pass' : 'fail',
    tier: 'D',
    batchIds: stats.batchIds,
    expected: 'end-of-run audit clean; no stuck Cleared batch; no missing batch; scripted taker active',
    observed: JSON.stringify(plain({ pass: report.pass, failures: report.failures ?? [], takerOrders: stats.orders, filled: stats.filled, skipped: stats.skipped })),
    notes: [...notes, `SOL spent ${lamportsToSol(stats.spent)}`].join('\n'),
  };
  writeJson(join(options.out, 'P0-35.json'), { row, report, stats, cleanup });
  mergeRows(options.out, [row]);
  return { row, report, stats };
}

function personaNames(options) {
  if (options.mode !== 'rows') return ['taker'];
  return [...new Set(options.rows.flatMap(id => ROWS[id].personas))];
}

async function main(argv = process.argv.slice(2), { log = console.log, error = console.error, fetchImpl = globalThis.fetch } = {}) {
  let options;
  let driver;
  try {
    options = parseArgs(argv);
    const manifest = loadManifest(JSON.parse(readFileSync(options.deployment, 'utf8')));
    options.manifest = manifest;
    const personas = loadPersonas({ dir: options.keys, names: personaNames(options), forbiddenPubkeys: [manifest.accounts.maker] });
    const connection = new Connection(options.rpc, 'confirmed');
    driver = createDriver({ connection, manifest, personas, log });
  } catch (failure) {
    error(failure.message);
    return 2;
  }
  try {
    if (options.mode === 'rows') {
      const { rows } = await runRows({ driver, rowIds: options.rows, out: options.out, log });
      return rows.every(row => row.status === 'pass') ? 0 : 1;
    }
    const persona = driver.personas.taker;
    if (options.mode === 'latency') {
      const fetchStatus = async () => {
        const response = await fetchImpl(options.statusUrl);
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        return response.json();
      };
      const result = await runLatency({
        driver, persona, orders: options.orders, spanMs: options.spanMs, fetchStatus,
        monitoringIgnore: options.monitoringIgnore, out: options.out, log,
      });
      return result.row.status === 'pass' ? 0 : 1;
    }
    const result = await runSoakMode({ driver, persona, options, log });
    return result.row.status === 'pass' ? 0 : 1;
  } catch (failure) {
    error(failure.message);
    return /^(Refusing|refusing|genesis|manifest|deployment|scoped)/.test(failure.message) ? 2 : 1;
  }
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; });
}

module.exports = {
  ADMIN_PUBKEY,
  PERSONA_FILES,
  D_ROWS,
  DEFAULT_MONITORING_IGNORE,
  ROW_DEPOSIT,
  loadPersonas,
  parseArgs,
  createDriver,
  reservation,
  proRata,
  settlementReceipt,
  monitoringGreen,
  decodeBook,
  hostedLadder,
  crossingPrice,
  nextTakerSide,
  ROWS,
  checker,
  checkFees,
  runRow,
  runRows,
  runLatency,
  createSoakDrive,
  mergeRows,
  main,
};
