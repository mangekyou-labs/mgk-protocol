'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair } = require('@solana/web3.js');
const drows = require('./drows');

const ADMIN = 'GBz4U7gb3nqALmtBBYajKgngFjbEsjPzM86X7ZADPwt4';

function keyFiles(entries) {
  const files = new Map(entries.map(([name, keypair]) => [`/keys/${name}`, JSON.stringify([...keypair.secretKey])]));
  return {
    readFile: path => {
      if (!files.has(path)) throw Error(`ENOENT ${path}`);
      return files.get(path);
    },
    realpath: path => path,
  };
}

test('loadPersonas reads only the named persona files', () => {
  const maker = Keypair.generate(), taker = Keypair.generate(), qa = Keypair.generate();
  const reads = [];
  const io = keyFiles([['mgk-trader-maker.json', maker], ['mgk-trader-taker.json', taker], ['mgk-demo-qa.json', qa]]);
  const personas = drows.loadPersonas({ dir: '/keys', names: ['maker', 'qa'], readFile: p => (reads.push(p), io.readFile(p)), realpath: io.realpath });
  assert.deepEqual(reads, ['/keys/mgk-trader-maker.json', '/keys/mgk-demo-qa.json']);
  assert.equal(personas.maker.publicKey.toBase58(), maker.publicKey.toBase58());
  assert.equal(personas.qa.publicKey.toBase58(), qa.publicKey.toBase58());
  assert.equal(personas.taker, undefined);
});

test('loadPersonas refuses an admin-keyed persona file', () => {
  // The admin secret is unavailable, so stub the decoded pubkey through the keypair factory seam.
  const fake = Keypair.generate();
  const io = keyFiles([['mgk-demo-qa.json', fake]]);
  assert.throws(
    () => drows.loadPersonas({ dir: '/keys', names: ['qa'], ...io, fromSecretKey: () => ({ publicKey: { toBase58: () => ADMIN } }) }),
    /admin/,
  );
});

test('loadPersonas refuses forbidden pubkeys, duplicate keys and operator key files behind symlinks', () => {
  const hosted = Keypair.generate(), other = Keypair.generate();
  assert.throws(
    () => drows.loadPersonas({ dir: '/keys', names: ['maker'], ...keyFiles([['mgk-trader-maker.json', hosted]]), forbiddenPubkeys: [hosted.publicKey.toBase58()] }),
    /operator/,
  );
  assert.throws(
    () => drows.loadPersonas({ dir: '/keys', names: ['maker', 'taker'], ...keyFiles([['mgk-trader-maker.json', other], ['mgk-trader-taker.json', other]]) }),
    /duplicate/,
  );
  const io = keyFiles([['mgk-trader-taker.json', other]]);
  assert.throws(
    () => drows.loadPersonas({ dir: '/keys', names: ['taker'], readFile: io.readFile, realpath: () => '/keys/mgk-keeper.json' }),
    /operator key file/,
  );
  assert.throws(() => drows.loadPersonas({ dir: '/keys', names: ['admin'], ...io }), /Unknown persona/);
});

test('parseArgs accepts the row, latency and soak modes and rejects unsafe input', () => {
  const base = ['--rpc', 'https://rpc.example', '--deployment', 'd.json', '--keys', '/keys', '--out', '/ev'];
  const status = ['--status-url', 'https://i/api/status'];
  const rows = drows.parseArgs([...base, '--rows', 'P0-1,P0-13']);
  assert.equal(rows.mode, 'rows');
  assert.deepEqual(rows.rows, ['P0-1', 'P0-13']);
  assert.equal(rows.rpc, 'https://rpc.example');
  assert.deepEqual(drows.parseArgs([...base]).rows, ['P0-1', 'P0-4', 'P0-5', 'P0-6', 'P0-7', 'P0-9', 'P0-10', 'P0-12', 'P0-13']);
  const latency = drows.parseArgs([...base, '--latency', '--orders', '30', '--span-min', '32', ...status, '--monitoring-ignore', 'indexer,rpc']);
  assert.equal(latency.mode, 'latency');
  assert.equal(latency.orders, 30);
  assert.equal(latency.spanMs, 32 * 60 * 1000);
  assert.equal(latency.statusUrl, 'https://i/api/status');
  assert.deepEqual(latency.monitoringIgnore, ['indexer', 'rpc']);
  assert.deepEqual(drows.parseArgs([...base, '--latency', ...status]).monitoringIgnore, ['indexer']);
  assert.deepEqual(drows.parseArgs([...base, '--latency', ...status, '--monitoring-ignore', '']).monitoringIgnore, []);
  const soak = drows.parseArgs([...base, '--soak', '--duration-min', '120', '--drive-every', '6']);
  assert.equal(soak.mode, 'soak');
  assert.equal(soak.soakMs, 120 * 60 * 1000);
  assert.equal(soak.driveEvery, 6);
  assert.throws(() => drows.parseArgs([...base, '--latency']), /--status-url/);
  assert.throws(() => drows.parseArgs([...base, '--rows', 'P0-2']), /not a tier-D row/);
  assert.throws(() => drows.parseArgs([...base, '--rows', 'P0-28']), /already proven/);
  assert.throws(() => drows.parseArgs([...base, '--rows', 'P0-33']), /own driver/);
  assert.throws(() => drows.parseArgs(['--deployment', 'd.json', '--out', '/ev']), /--rpc/);
  assert.throws(() => drows.parseArgs(['--rpc', 'x', '--deployment', 'd.json']), /--out/);
  assert.throws(() => drows.parseArgs([...base, '--crank']), /unknown argument/);
  assert.throws(() => drows.parseArgs([...base, '--latency', '--soak']), /one mode/);
  assert.throws(() => drows.parseArgs([...base, '--orders', '-1']), /positive/);
});

test('parseArgs takes a cold-start command, defaulting its order to midway', () => {
  const base = ['--rpc', 'https://rpc.example', '--deployment', 'd.json', '--out', '/ev', '--latency', '--status-url', 'https://i/api/status'];
  assert.equal(drows.parseArgs(base).coldStartCmd, null);
  const midway = drows.parseArgs([...base, '--cold-start-cmd', 'restart keeper', '--orders', '30']);
  assert.equal(midway.coldStartCmd, 'restart keeper');
  assert.equal(midway.coldStartAt, 16);
  assert.equal(drows.parseArgs([...base, '--orders', '31', '--cold-start-cmd', 'x']).coldStartAt, 16);
  assert.equal(drows.parseArgs([...base, '--cold-start-cmd', 'x', '--cold-start-at', '1']).coldStartAt, 1);
  assert.throws(() => drows.parseArgs([...base, '--cold-start-at', '3']), /--cold-start-at needs --cold-start-cmd/);
  assert.throws(() => drows.parseArgs([...base, '--cold-start-cmd', 'x', '--cold-start-at', '31']), /between 1 and 30/);
  assert.throws(() => drows.parseArgs([...base, '--cold-start-cmd', 'x', '--cold-start-at', '2.5']), /between 1 and 30/);
  assert.throws(() => drows.parseArgs([...base, '--cold-start-cmd', '']), /--cold-start-cmd/);
  assert.throws(() => drows.parseArgs(['--rpc', 'x', '--out', '/ev', '--cold-start-cmd', 'x']), /only with --latency/);
});

test('reservation and pro-rata release match the on-chain formulas', () => {
  // 3 lots at limit 101 with conversion 100: notional 303e6 at max(101, 100).
  assert.equal(drows.reservation(3n, 101n, 100n), 607515n);
  assert.equal(drows.reservation(3n, 101n, 100n, true), 1515n);
  assert.equal(drows.reservation(1n, 99n, 100n), 200500n);
  assert.equal(drows.proRata(607515n, 3n, 2n), 405010n);
  assert.equal(drows.proRata(607515n, 3n, 0n), 0n);
  assert.equal(drows.proRata(10n, 3n, 1n), 4n);
});

const CORE = Keypair.generate().publicKey;
const receiptLine = (batchId, qtys) => {
  const data = Buffer.alloc(10 + qtys.length * 8);
  data.writeBigUInt64LE(BigInt(batchId), 0);
  data.writeUInt16LE(qtys.length, 8);
  qtys.forEach((q, i) => data.writeBigUInt64LE(BigInt(q), 10 + i * 8));
  return `Program data: ${Buffer.from('mgk-settlement-v1').toString('base64')} ${data.toString('base64')}`;
};

test('settlementReceipt accepts only a complete core-level receipt', () => {
  const other = Keypair.generate().publicKey.toBase58();
  const core = CORE.toBase58();
  const ok = [`Program ${core} invoke [1]`, receiptLine(7, [2, 0]), `Program ${core} success`];
  assert.deepEqual(drows.settlementReceipt(ok, { programId: CORE, batchId: 7n, allocations: [2n, 1n] }), [2n, 0n]);
  const nested = [`Program ${core} invoke [1]`, `Program ${other} invoke [2]`, receiptLine(7, [2, 0]), `Program ${other} success`, `Program ${core} success`];
  assert.throws(() => drows.settlementReceipt(nested, { programId: CORE, batchId: 7n, allocations: [2n, 1n] }), /unavailable/);
  assert.throws(() => drows.settlementReceipt(ok, { programId: CORE, batchId: 7n, allocations: [1n, 1n] }), /exceeds allocation/);
  assert.throws(() => drows.settlementReceipt(ok, { programId: CORE, batchId: 7n, allocations: [2n] }), /Incomplete/);
  assert.throws(() => drows.settlementReceipt(ok.slice(0, 2), { programId: CORE, batchId: 7n, allocations: [2n, 1n] }), /Truncated invocation/);
  assert.throws(() => drows.settlementReceipt(ok, { programId: CORE, batchId: 8n, allocations: [2n, 1n] }), /unavailable/);
});

test('monitoringGreen ignores only the configured checks', () => {
  const sample = (checks, at = 1) => ({ at, body: { checks } });
  const ok = { severity: 'ok' };
  const lagging = sample({ rpc: ok, keeper: ok, indexer: { severity: 'critical' } });
  assert.equal(drows.monitoringGreen([lagging]).green, true);
  assert.deepEqual(drows.monitoringGreen([lagging]).ignored, ['indexer']);
  const strict = drows.monitoringGreen([lagging], []);
  assert.equal(strict.green, false);
  assert.match(strict.reasons[0], /indexer is critical/);
  assert.equal(drows.monitoringGreen([sample({ rpc: ok, keeper: { severity: 'warning' } })]).green, false);
  assert.equal(drows.monitoringGreen([{ at: 2, error: 'HTTP 503' }]).green, false);
  assert.equal(drows.monitoringGreen([]).green, false);
  assert.equal(drows.monitoringGreen([sample({ indexer: ok })]).green, false, 'only ignored checks is not green');
});

test('hostedLadder and crossingPrice read only the hosted maker depth', () => {
  const maker = 'MAKER';
  const book = { orders: [
    { side: 1, price: 105n, open: 1n, user: maker },
    { side: 1, price: 103n, open: 1n, user: maker },
    { side: 1, price: 102n, open: 5n, user: 'someone' },
    { side: 0, price: 98n, open: 2n, user: maker },
  ] };
  const ladder = drows.hostedLadder(book, maker);
  assert.deepEqual(ladder.asks.map(l => l.price), [103n, 105n]);
  assert.equal(drows.crossingPrice(ladder, 0, 1n), 103n);
  assert.equal(drows.crossingPrice(ladder, 0, 2n), 105n);
  assert.equal(drows.crossingPrice(ladder, 0, 3n), null);
  assert.equal(drows.crossingPrice(ladder, 1, 2n), 98n);
  assert.deepEqual(drows.nextTakerSide(1n, 0), { side: 1, reduceOnly: true });
  assert.deepEqual(drows.nextTakerSide(-2n, 1), { side: 0, reduceOnly: true });
  assert.deepEqual(drows.nextTakerSide(0n, 0), { side: 1, reduceOnly: false });
  assert.deepEqual(drows.nextTakerSide(0n, 1), { side: 0, reduceOnly: false });
});

// ---------------------------------------------------------------------------
// Chain driver against a mocked connection
// ---------------------------------------------------------------------------
function manifestFor() {
  return {
    ready: true,
    marketSeed: null,
    cluster: 'devnet',
    programs: { perps_core: CORE.toBase58(), perps_matcher: Keypair.generate().publicKey.toBase58(), oracle: Keypair.generate().publicKey.toBase58() },
    accounts: { oracle: Keypair.generate().publicKey.toBase58(), maker: Keypair.generate().publicKey.toBase58() },
  };
}

function personaOf(name) {
  const keypair = Keypair.generate();
  return { name, file: `${name}.json`, keypair, publicKey: keypair.publicKey };
}

function fakeConnection({ simErr = null, txErr = null } = {}) {
  const calls = [];
  return {
    calls,
    getLatestBlockhash: async () => (calls.push('blockhash'), { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
    simulateTransaction: async (tx, config) => {
      calls.push(`simulate:${config.sigVerify}`);
      return { value: { err: simErr, logs: ['sim log'] } };
    },
    sendRawTransaction: async () => (calls.push('send'), 'SIG1'),
    getTransaction: async signature => {
      calls.push(`getTransaction:${signature}`);
      return {
        slot: 42,
        transaction: { message: { staticAccountKeys: [] } },
        meta: { fee: 5000, preBalances: [], postBalances: [], logMessages: [], err: txErr },
      };
    },
    getGenesisHash: async () => 'not-devnet',
  };
}

test('createDriver refuses non-devnet manifests, scoped markets and non-persona signers', async () => {
  const qa = personaOf('qa');
  const connection = fakeConnection();
  assert.throws(() => drows.createDriver({ connection, manifest: { ...manifestFor(), cluster: 'mainnet-beta' }, personas: { qa } }), /refusing cluster/);
  assert.throws(() => drows.createDriver({ connection, manifest: { ...manifestFor(), marketSeed: 'x' }, personas: { qa } }), /marketSeed/);
  assert.throws(() => drows.createDriver({ connection, manifest: { ...manifestFor(), ready: false }, personas: { qa } }), /not ready/);
  const driver = drows.createDriver({ connection, manifest: manifestFor(), personas: { qa } });
  await assert.rejects(driver.send('x', [], [personaOf('stranger')]), /non-persona/);
  assert.deepEqual(connection.calls, [], 'nothing is fetched or signed for a refused signer');
  await assert.rejects(driver.init(), /not devnet/);
});

test('send simulates the signed bytes with sigVerify before sending', async () => {
  const qa = personaOf('qa');
  const connection = fakeConnection();
  let t = 1000;
  const driver = drows.createDriver({
    connection, manifest: manifestFor(), personas: { qa }, now: () => (t += 10), sleep: async () => {},
    confirm: async () => connection.calls.push('confirm'),
  });
  const record = await driver.send('noop', [], [qa]);
  assert.deepEqual(connection.calls, ['blockhash', 'simulate:true', 'send', 'confirm', 'getTransaction:SIG1']);
  assert.equal(record.signature, 'SIG1');
  assert.equal(record.fee, 5000n);
  assert.ok(record.acceptedAt > record.signedAt);
  assert.equal(driver.records.length, 1);
});

test('a failed simulation never sends; expectReject is simulation-only', async () => {
  const qa = personaOf('qa');
  const connection = fakeConnection({ simErr: { InstructionError: [1, { Custom: 4 }] } });
  const driver = drows.createDriver({ connection, manifest: manifestFor(), personas: { qa }, confirm: async () => assert.fail('no confirm') });
  await assert.rejects(driver.send('withdraw', [], [qa]), /simulation failed/);
  const reject = await driver.expectReject('over-withdraw', [], [qa], 4);
  assert.equal(reject.code, 4);
  assert.equal(reject.unexpected, null);
  const wrong = await driver.expectReject('over-withdraw', [], [qa], 606);
  assert.match(wrong.unexpected, /custom error 4, expected 606/);
  assert.ok(!connection.calls.includes('send'));
  assert.equal(driver.records.length, 0);
});

test('a landed failure is still recorded for wallet reconciliation', async () => {
  const qa = personaOf('qa');
  const connection = fakeConnection({ txErr: { InstructionError: [1, { Custom: 602 }] } });
  const driver = drows.createDriver({
    connection, manifest: manifestFor(), personas: { qa }, sleep: async () => {},
    confirm: async () => { throw Error('Transaction SIG1 failed: {"InstructionError":[1,{"Custom":602}]}'); },
  });
  await assert.rejects(driver.send('deposit', [], [qa]), error => error.code === 602 && error.signature === 'SIG1');
  assert.equal(driver.records.length, 1);
  assert.equal(driver.records[0].fee, 5000n);
});

// ---------------------------------------------------------------------------
// Row runner against an in-memory driver
// ---------------------------------------------------------------------------
const VAULT = Keypair.generate().publicKey;

function memoryDriver(personas, { vaultShortBy = 0n } = {}) {
  const wallets = new Map(Object.values(personas).map(p => [p.publicKey.toBase58(), 400_000_000n]));
  const equity = new Map(Object.values(personas).map(p => [p.publicKey.toBase58(), 0n]));
  const records = [];
  let slot = 10;
  const pf = key => ({ equity: equity.get(key), principal: equity.get(key), freeCollateral: equity.get(key), reservedCollateral: 0n,
    feesPaid: 0n, realizedLamports: 0n, qty: 0n, position: null, positions: [], openOrders: [] });
  const readState = async users => ({
    slot,
    oracle: { price: 100n },
    vault: { balance: 0n, lamports: 0n, insuranceFund: 0n, uncoveredBadDebt: 0n },
    users: Object.fromEntries(users.map(u => [u.toBase58(), { wallet: wallets.get(u.toBase58()), portfolio: pf(u.toBase58()) }])),
  });
  const move = (persona, label, amount) => {
    const key = persona.publicKey.toBase58();
    const fee = 5000n;
    const pre = [wallets.get(key), 1_000_000_000n];
    wallets.set(key, wallets.get(key) - amount - fee);
    equity.set(key, equity.get(key) + amount);
    slot++;
    const vaultMove = amount > 0n ? amount - vaultShortBy : amount;
    const record = { label, signature: `sig${records.length}`, slot, fee, accounts: [key, VAULT.toBase58()], preBalances: pre,
      postBalances: [wallets.get(key), pre[1] + vaultMove] };
    records.push(record);
    return record;
  };
  const transfer = async (persona, amount, label) => {
    const before = await readState([persona.publicKey]);
    const record = move(persona, label, amount);
    return { record, before, after: await readState([persona.publicKey]), amount };
  };
  return {
    keys: { vault: VAULT },
    personas,
    records,
    init: async () => ({}),
    readState,
    delta: (record, key) => {
      const i = record.accounts.indexOf(typeof key === 'string' ? key : key.toBase58());
      return i < 0 ? 0n : record.postBalances[i] - record.preBalances[i];
    },
    ensurePortfolio: async () => null,
    deposit: (persona, amount) => transfer(persona, BigInt(amount), 'deposit'),
    withdraw: (persona, amount) => transfer(persona, -BigInt(amount), 'withdraw'),
    waitFinalized: async users => readState(users),
    cleanup: async () => ({ flat: true, residualQty: '0', withdrawn: '0', equityLeft: '0', notes: [] }),
  };
}

test('runRow P0-1 passes on exact lamport deltas and emits a report.js row', async () => {
  const { mkdtempSync, readFileSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const out = mkdtempSync(join(tmpdir(), 'drows-'));
  const qa = personaOf('qa');
  const driver = memoryDriver({ qa });
  const { rows } = await drows.runRows({ driver, rowIds: ['P0-1'], out });
  const [row] = rows;
  assert.equal(row.status, 'pass', row.observed);
  assert.equal(row.tier, 'D');
  assert.deepEqual(row.signatures, ['sig0', 'sig1']);
  assert.equal(typeof row.expected, 'string');
  assert.match(row.expected, /200000000/);
  assert.match(row.notes, /SOL spent 0\.000010000/);
  const fragment = JSON.parse(readFileSync(join(out, 'rows.json'), 'utf8'));
  assert.equal(fragment.length, 1);
  assert.equal(fragment[0].id, 'P0-1');
  const evidence = JSON.parse(readFileSync(join(out, 'P0-1.json'), 'utf8'));
  assert.equal(evidence.spent.fees, '10000');
  const { buildReport } = require('./report');
  const report = buildReport({ commit: 'abc', cluster: 'devnet', programs: [{ name: 'core', programId: 'X', sha256: 'a'.repeat(64) }], rows: fragment });
  assert.match(report, /P0-1/);
});

test('runRow P0-1 fails when the vault receives less than the deposit', async () => {
  const qa = personaOf('qa');
  const { row } = await drows.runRow(memoryDriver({ qa }, { vaultShortBy: 1n }), 'P0-1');
  assert.equal(row.status, 'fail');
  assert.match(row.observed, /\[FAIL\] deposit: vault lamports tx delta = \+amount: 199999999/);
});

test('mergeRows replaces rows by id', () => {
  const { mkdtempSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const out = mkdtempSync(join(tmpdir(), 'drows-'));
  drows.mergeRows(out, [{ id: 'P0-1', status: 'fail' }, { id: 'P0-4', status: 'pass' }]);
  const merged = drows.mergeRows(out, [{ id: 'P0-1', status: 'pass' }]);
  assert.deepEqual(merged.map(r => [r.id, r.status]), [['P0-1', 'pass'], ['P0-4', 'pass']]);
});

// ---------------------------------------------------------------------------
// P0-33 latency and P0-35 soak taker against a scripted driver
// ---------------------------------------------------------------------------
function takerDriver({ ladder = true } = {}) {
  const taker = personaOf('taker');
  const maker = Keypair.generate().publicKey;
  let clock = 0;
  let qty = 0n;
  let batch = 100n;
  const posts = [];
  const key = taker.publicKey.toBase58();
  const state = () => ({
    slot: 1,
    oracle: { price: 100_000n },
    book: { orders: ladder ? [
      { side: 0, price: 99_000n, open: 5n, user: maker.toBase58() },
      { side: 1, price: 101_000n, open: 5n, user: maker.toBase58() },
    ] : [] },
    users: { [key]: { wallet: 1_000_000_000n - BigInt(posts.length) * 5500n, portfolio: { qty, openOrders: [] } } },
  });
  return {
    clock: () => clock,
    advance: ms => { clock += ms; },
    posts,
    taker,
    driver: {
      keys: { maker },
      personas: { taker },
      records: [],
      market: { tick: 1000n },
      init: async () => ({}),
      readState: async () => state(),
      ensurePortfolio: async () => null,
      deposit: async () => ({}),
      floorTick: p => (p / 1000n) * 1000n,
      ceilTick: p => ((p + 999n) / 1000n) * 1000n,
      postOrders: async (label, [entry]) => {
        const signedAt = clock;
        clock += 400;
        batch += 1n;
        posts.push(entry);
        return { batchId: batch, record: { signature: `s${posts.length}`, signedAt, acceptedAt: clock, slot: 1 }, orders: [{ orderId: BigInt(posts.length) }] };
      },
      waitSettled: async batchId => {
        clock += 8000;
        qty += posts[posts.length - 1].side === 0 ? 1n : -1n;
        return {
          batchId, settledAt: clock, post: state(),
          results: { fills: [{ user: taker.publicKey.toBytes(), orderId: BigInt(posts.length), qty: 1n }] },
        };
      },
      cancelAll: async () => ({}),
      cleanup: async () => ({ flat: true, residualQty: String(qty), withdrawn: '0', equityLeft: '0', notes: [] }),
    },
  };
}

const greenStatus = async () => ({ checks: { rpc: { severity: 'ok' } } });

test('runLatency feeds LatencyRecorder from chain timestamps and alternates flat', async () => {
  const fake = takerDriver();
  const result = await drows.runLatency({
    driver: fake.driver, persona: fake.taker, orders: 30, spanMs: 31 * 60 * 1000,
    fetchStatus: async () => ({ checks: { rpc: { severity: 'ok' }, indexer: { severity: 'critical' } } }),
    now: fake.clock, sleep: async ms => fake.advance(ms),
    coldStartCmd: 'restart', coldStartAt: 16, runCommand: async () => 0,
  });
  assert.equal(result.summary.verdict.pass, true, JSON.stringify(result.summary.verdict.failures));
  assert.equal(result.row.status, 'pass');
  assert.equal(result.monitoring.green, true);
  assert.match(result.monitoring.rule, /except \[indexer\]/);
  assert.equal(result.trades.length, 30);
  assert.deepEqual(fake.posts.slice(0, 4).map(p => [p.side, p.reduceOnly, p.price]),
    [[0, false, 101_000n], [1, true, 99_000n], [0, false, 101_000n], [1, true, 99_000n]]);
  assert.ok(fake.posts.every(p => p.qty === 1n && p.isMaker === false));
});

test('runLatency runs the cold-start command before order N and reports that sample separately', async () => {
  const fake = takerDriver();
  const calls = [];
  const lines = [];
  const result = await drows.runLatency({
    driver: fake.driver, persona: fake.taker, orders: 30, spanMs: 31 * 60 * 1000, fetchStatus: greenStatus,
    now: fake.clock, sleep: async ms => fake.advance(ms), log: line => lines.push(line),
    coldStartCmd: 'render restart keeper', coldStartAt: 16,
    runCommand: async cmd => { calls.push({ cmd, ordersBefore: fake.posts.length }); fake.advance(45_000); return 0; },
  });
  assert.deepEqual(calls, [{ cmd: 'render restart keeper', ordersBefore: 15 }]);
  assert.deepEqual(result.trades.filter(t => t.coldStart).map(t => t.id), ['taker-16']);
  const cold = result.coldStart;
  assert.equal(cold.id, 'taker-16');
  assert.equal(cold.at, 16);
  assert.equal(cold.cmd, 'render restart keeper');
  assert.equal(cold.commandMs, 45_000);
  assert.equal(cold.acceptedMs, 400);
  assert.equal(cold.settledMs, 8400);
  assert.equal(result.summary.coldStart, true);
  assert.equal(result.row.status, 'pass', JSON.stringify(result.summary.verdict.failures));
  assert.match(result.row.notes, /cold start: taker-16 after `render restart keeper` \(45000 ms\); accepted 400 ms, settled 8400 ms/);
  assert.ok(lines.some(l => /cold start/.test(l)));
});

test('runLatency without a cold-start command labels no sample a cold start and says so', async () => {
  const fake = takerDriver();
  const result = await drows.runLatency({
    driver: fake.driver, persona: fake.taker, orders: 30, spanMs: 31 * 60 * 1000, fetchStatus: greenStatus,
    now: fake.clock, sleep: async ms => fake.advance(ms),
  });
  assert.equal(result.coldStart, null);
  assert.ok(result.trades.every(t => !t.coldStart));
  assert.equal(result.summary.coldStart, false);
  assert.match(result.row.notes, /no cold start: run without --cold-start-cmd/);
  assert.equal(result.row.status, 'fail');
  assert.ok(result.summary.verdict.failures.some(f => /cold/.test(f)));
});

test('runLatency aborts when the cold-start command exits non-zero, flagging no sample', async () => {
  const fake = takerDriver();
  const result = await drows.runLatency({
    driver: fake.driver, persona: fake.taker, orders: 4, spanMs: 1000, fetchStatus: greenStatus,
    now: fake.clock, sleep: async ms => fake.advance(ms),
    coldStartCmd: 'restart', coldStartAt: 3, runCommand: async () => 7,
  });
  assert.equal(fake.posts.length, 2);
  assert.equal(result.coldStart, null);
  assert.equal(result.row.status, 'fail');
  assert.match(result.row.notes, /cold-start command `restart` exited 7/);
});

test('runLatency fails without the maker ladder or with red monitoring', async () => {
  const fake = takerDriver({ ladder: false });
  const result = await drows.runLatency({
    driver: fake.driver, persona: fake.taker, orders: 2, spanMs: 1000,
    fetchStatus: async () => ({ checks: { rpc: { severity: 'critical' } } }),
    now: fake.clock, sleep: async ms => fake.advance(ms),
  });
  assert.equal(result.row.status, 'fail');
  const failures = result.summary.verdict.failures.join('; ');
  assert.match(failures, /maker ladder/);
  assert.match(failures, /monitoring not green/);
});

test('createSoakDrive trades every N polls, keeps the position within one lot and plugs into runSoak', async () => {
  const fake = takerDriver();
  const drive = drows.createSoakDrive({ driver: fake.driver, persona: fake.taker, everyPolls: 2 });
  for (let poll = 0; poll < 8; poll++) await drive(poll);
  assert.equal(fake.posts.length, 4);
  assert.deepEqual(fake.posts.map(p => p.side), [0, 1, 0, 1]);
  const stats = await drive.stats();
  assert.equal(stats.orders, 4);
  assert.equal(stats.filled, 4n);
  assert.ok((await drive.cleanup()).flat);
  const { runSoak } = require('./soak');
  let t = 0;
  const verdict = await runSoak({
    durationMs: 30, pollMs: 10, minBatches: 0, now: () => t, sleep: async ms => { t += ms; },
    observe: async () => ({ currentBatchId: 1, batches: [] }), audit: async () => ({ violations: [] }),
    drive: drows.createSoakDrive({ driver: fake.driver, persona: fake.taker, everyPolls: 1 }),
  });
  assert.ok(!verdict.failures.some(f => /drive failed/.test(f)), verdict.failures.join('; '));
});

test('createSoakDrive skips a poll when the hosted ladder has no level', async () => {
  const fake = takerDriver({ ladder: false });
  const drive = drows.createSoakDrive({ driver: fake.driver, persona: fake.taker, everyPolls: 1 });
  await drive(0);
  assert.equal(fake.posts.length, 0);
  assert.equal((await drive.stats()).skipped, 1);
});

test('checkFees credits the fund with fees minus realized PnL rounding dust', () => {
  const pf = (feesPaid, realizedLamports) => ({ portfolio: { feesPaid, realizedLamports } });
  const result = {
    verdict: { pass: true, conversion: 93255000n, fills: [
      { user: 'M', qty: 2n, price: 93255000n, isMaker: true },
      { user: 'T', qty: 1n, price: 93255000n, isMaker: false },
      { user: 'Q', qty: 1n, price: 93255000n, isMaker: false },
    ] },
    settled: {
      pre: { vault: { insuranceFund: 0n }, users: { M: pf(0n, 0n), T: pf(0n, 0n), Q: pf(0n, 0n) } },
      post: { vault: { insuranceFund: 1001n }, users: { M: pf(0n, -401n), T: pf(500n, 200n), Q: pf(500n, 200n) } },
    },
  };
  const c = drows.checker();
  drows.checkFees(c, 'close', result);
  assert.equal(c.pass, true, JSON.stringify(c.steps));
  result.settled.post.vault.insuranceFund = 1000n;
  const strict = drows.checker();
  drows.checkFees(strict, 'close', result);
  assert.equal(strict.pass, false);
});
