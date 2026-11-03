'use strict';
// End-to-end gate proof in the signed local runtime (issue #35): set up the
// minimal market, post maker + taker orders, let the keeper clear + settle,
// feed the real sign/accept/settle timestamps to the LatencyRecorder, run a
// shortened soak ending in the scenario audit, and build a candidate-pinned
// report. Requires MGK_CANDIDATE_MANIFEST; absence fails, never skips.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { Keypair, PublicKey, TransactionInstruction, SystemProgram } = require('@solana/web3.js');
const { LocalRuntime } = require('../runtime/harness');
const { decodeAccount, decodeResults } = require('../../mgk-frontend/packages/layout');
const { encodeInstruction } = require('../../mgk-frontend/packages/layout/instructions');
const { programsFrom } = require('../runtime/invariants');
const { auditScenario } = require('../runtime/audit');
const { LatencyRecorder } = require('./latency');
const { runSoak, observeDeployment } = require('./soak');
const { buildReport } = require('./report');
const deployment = require('../../deployments/devnet.json');

const CORE = new PublicKey(deployment.programs.perps_core);
const MATCHER = new PublicKey(deployment.programs.perps_matcher);
const ORACLE = new PublicKey(deployment.programs.oracle);
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const pda = (seeds, owner = CORE) => PublicKey.findProgramAddressSync(seeds, owner);
const meta = (pubkey, isWritable = true, isSigner = false) => ({ pubkey, isWritable, isSigner });
const ix = (name, params, keys) => new TransactionInstruction({
  programId: CORE, keys, data: Buffer.from(encodeInstruction('core', name, params)),
});

// Collect a keeper worker's stdout/stderr JSON-lines records.
function collectKeeperOutput(keeper) {
  keeper.records = [];
  keeper.output = '';
  for (const stream of [keeper.stdout, keeper.stderr]) {
    let pending = '';
    stream.on('data', chunk => {
      keeper.output += String(chunk);
      pending += String(chunk);
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try { keeper.records.push(JSON.parse(line)); } catch { /* keeper log line */ }
      }
    });
  }
  return keeper;
}

test('gate tooling end-to-end: market fill and settle, latency, shortened soak, pinned report', { timeout: 300000 }, async t => {
  assert.ok(process.env.MGK_CANDIDATE_MANIFEST, 'MGK_CANDIDATE_MANIFEST required');
  const candidate = JSON.parse(readFileSync(process.env.MGK_CANDIDATE_MANIFEST, 'utf8'));
  const runtime = await LocalRuntime.start({
    candidates: candidate.programs,
    port: Number(process.env.MGK_GATE_PORT ?? 19931),
  });
  t.after(() => runtime.close());
  const directory = mkdtempSync(join(tmpdir(), 'gate-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const payer = Keypair.generate();
  const maker = Keypair.generate();
  const taker = Keypair.generate();
  for (const wallet of [payer, maker, taker]) {
    await runtime.setAccount(wallet.publicKey, { owner: SystemProgram.programId, lamports: 20e9 });
  }
  const [registry, registryBump] = pda([Buffer.from('registry')]);
  const [instrument, instrumentBump] = pda([Buffer.from('instrument'), Buffer.alloc(2)]);
  const [vault] = pda([Buffer.from('vault')]);
  const [batch, batchBump] = pda([Buffer.from('batch'), u64(0)]);
  const [book] = pda([Buffer.from('book'), Buffer.alloc(2)], MATCHER);
  const [results] = pda([Buffer.from('results'), u64(0)], MATCHER);
  const oracle = Keypair.generate().publicKey;
  const traders = [maker, taker];
  const portfolios = traders.map(user => pda([Buffer.from('portfolio'), user.publicKey.toBuffer()]));
  const rent = await runtime.rpc('getMinimumBalanceForRentExemption', [80]);
  for (const [address, owner, size] of [
    [registry, CORE, 94], [instrument, CORE, 352], [vault, CORE, 80],
    [batch, CORE, 176], [book, MATCHER, 27712],
    ...portfolios.map(([address]) => [address, CORE, 2848]),
  ]) {
    await runtime.setAccount(address, {
      owner, data: Buffer.alloc(size),
      ...(address === vault ? { lamports: rent } : {}),
    });
  }
  const freshOracle = async () => runtime.setOracle(oracle, {
    owner: ORACLE, authority: payer.publicKey, instrument, price: 100000000,
    publishTime: Number((await runtime.account('SysvarC1ock11111111111111111111111111111111')).data.readBigInt64LE(32)),
    confidence: 12,
  });
  await freshOracle();
  await runtime.send('initialize gate market', [ix('Initialize', {
    governance: payer.publicKey.toBytes(), instrumentCount: 1, volatilityMultiplier: 10000,
    batchIdCounter: 0n, baseDeposit: 1000000n, nMin: 1, tMinSlots: 10n, tMaxSlots: 25n,
    tRevealSlots: 25n, instrumentId: 0, tickSize: 1n, lotSize: 1n, imrBps: 2000, mmrBps: 1000,
    takerFeeBps: 5, makerFeeBps: 0, oracleAddr: oracle.toBytes(), registryBump, instrumentBump,
  }, [meta(registry), meta(payer.publicKey, true, true), meta(instrument),
    meta(SystemProgram.programId, false), meta(vault)])], [payer]);
  await runtime.send('initialize gate book', [ix('InitializeBook', { instrumentId: 0 },
    [meta(registry, false), meta(book), meta(payer.publicKey, true, true),
      meta(SystemProgram.programId, false), meta(MATCHER, false)])], [payer]);
  await runtime.send('create initial batch', [ix('CreateBatch', { bump: batchBump },
    [meta(batch), meta(registry)])], [payer]);
  await runtime.send('fund insurance', [ix('TopUp', { amount: 100000000n },
    [meta(payer.publicKey, true, true), meta(vault), meta(SystemProgram.programId, false)])], [payer]);

  // Latency gate context: the taker order runs against the maker ladder
  // posted below. The harness has no monitoring worker, so monitoring is
  // declared green for this local mechanism check only.
  const recorder = new LatencyRecorder();
  recorder.setRunContext({ againstMakerLadder: true, monitoringGreen: true });
  for (let i = 0; i < 2; i++) {
    const user = traders[i];
    const [portfolio, bump] = portfolios[i];
    await runtime.send(`init trader ${i}`, [ix('InitPortfolio', { user: user.publicKey.toBytes(), bump },
      [meta(portfolio), meta(user.publicKey, true, true)])], [payer, user]);
    await runtime.send(`deposit trader ${i}`, [ix('Deposit', { amount: 1000000000n },
      [meta(portfolio), meta(user.publicKey, true, true), meta(SystemProgram.programId, false), meta(vault)])], [payer, user]);
    const orderId = i === 0 ? 'maker-buy' : 'taker-sell';
    // Only the taker order counts for latency; as the first (only) included
    // order it carries the cold-start flag.
    if (i === 1) recorder.sign(orderId, Date.now(), { coldStart: true, role: 'taker' });
    await runtime.send(`post trader ${i}`, [ix('PostOrder', {
      side: i, isMaker: i === 0, price: 100000000n, qty: 1n, instrumentId: 0, reduceOnly: false,
    }, [meta(portfolio), meta(user.publicKey, true, true), meta(batch), meta(registry, false),
      meta(book), meta(MATCHER, false), meta(instrument, false), meta(oracle, false), meta(vault, false)])], [payer, user]);
    if (i === 1) recorder.accept(orderId, Date.now());
  }

  // Drive clear + settle with the real keeper worker, as in keeper.test.js.
  const manifest = {
    ...deployment, cluster: 'localnet', name: 'gate-runtime',
    accounts: Object.fromEntries(Object.entries({ registry, instrument, oracle, insurance: vault, maker: maker.publicKey })
      .map(([key, value]) => [key, { status: 'deployed', address: String(value) }])),
    start_slot: { status: 'set', slot: 0 },
  };
  const manifestPath = join(directory, 'deployment.json');
  const payerPath = join(directory, 'payer.json');
  const monitoringPath = join(directory, 'monitoring.json');
  const monitoring = structuredClone(require('../../deployments/monitoring.json'));
  monitoring.feePayers.keeper = payer.publicKey.toBase58();
  writeFileSync(monitoringPath, JSON.stringify(monitoring));
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(payerPath, JSON.stringify([...payer.secretKey]), { mode: 0o600 });
  const keeper = await runtime.launchWorker(process.execPath,
    [resolve(__dirname, '..', 'ops-keeper.js'), '--loop'], {
      env: {
        KEEPER_KEYPAIR: payerPath, DEPLOYMENT_MANIFEST: manifestPath,
        MONITORING_CONFIG: monitoringPath,
      },
    });
  collectKeeperOutput(keeper);
  // Start the shortened soak now so it observes the batch live while the
  // keeper clears and settles it, then run the scenario audit at the end.
  const programs = programsFrom(candidate);
  const soakPromise = runSoak({
    durationMs: 8000, pollMs: 250,
    observe: () => observeDeployment({ rpc: (method, params) => runtime.rpc(method, params), programs }),
    audit: () => auditScenario('gate harness soak', {
      rpc: (method, params) => runtime.rpc(method, params), programs,
    }),
  });
  await runtime.advanceSlots(30);
  await freshOracle();
  const deadline = Date.now() + 120000;
  while (!keeper.records.some(r => r.status === 'settled' && r.batchId === '0' && r.signature)) {
    assert.ok(Date.now() < deadline, `keeper did not settle batch 0: ${keeper.output}`);
    await sleep(100);
  }
  if (keeper.exitCode === null && keeper.signalCode === null) {
    const done = once(keeper, 'exit');
    keeper.kill('SIGKILL');
    await done;
  }
  recorder.settle('taker-sell', Date.now());
  assert.equal(decodeAccount('Batch', (await runtime.account(batch)).data).status, 3);
  assert.equal(decodeResults((await runtime.account(results)).data).numFills, 2);
  assert.equal(decodeResults((await runtime.account(results)).data).spent, true);

  const latency = recorder.summary();
  assert.equal(latency.accepted.count, 1);
  assert.equal(latency.settled.count, 1);
  assert.deepEqual(latency.unsettled, []);
  assert.ok(latency.accepted.max >= 0 && latency.settled.max >= 0);
  // One harness taker order can never meet the 30-order / 30-minute gate bar.
  assert.equal(latency.verdict.pass, false);
  assert.ok(latency.verdict.failures.some(f => /fewer than 30|span/.test(f)), JSON.stringify(latency.verdict));

  // The soak started above observed the live batch transition and ends in
  // the scenario audit.
  const soak = await soakPromise;
  assert.equal(soak.pass, true, JSON.stringify(soak));
  assert.ok(soak.polls >= 4, `soak polls ${soak.polls}`);
  assert.ok(soak.batchesSeen >= 1, `soak batchesSeen ${soak.batchesSeen}`);

  // Report pinned to the candidate manifest. The L-tier pass below only
  // proves buildReport accepts a pass at the required local tier inside the
  // harness; D-tier rows without devnet evidence stay "not run".
  const report = buildReport({
    commit: candidate.commit, cluster: 'localnet', programs: candidate.programs,
    rows: [{ id: 'P0-8', status: 'pass', tier: 'L', notes: 'gate harness mechanism check' }],
  });
  assert.ok(report.includes(candidate.commit));
  for (const program of candidate.programs) {
    assert.ok(report.includes(program.programId), program.programId);
    assert.ok(report.includes(program.sha256), program.sha256);
  }
  assert.ok(report.split('\n').find(l => l.includes('P0-8')).includes('pass'));
  assert.ok(report.split('\n').find(l => l.includes('P0-1')).includes('not run'));
  assert.ok(report.split('\n').find(l => l.includes('P0-35')).includes('not run'));
  // A pass at the wrong tier renders as "not run", never as a pass.
  const wrongTier = buildReport({
    commit: candidate.commit, cluster: 'localnet', programs: candidate.programs,
    rows: [{ id: 'P0-35', status: 'pass', tier: 'L' }],
  });
  const p35 = wrongTier.split('\n').find(l => l.includes('P0-35'));
  assert.ok(p35.includes('not run'), p35);
  assert.ok(p35.includes('recorded tier L, requires D'), p35);
});
