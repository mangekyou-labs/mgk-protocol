'use strict';
// Public instruction boundary against pinned SBF bytes. These local scenarios
// verify isolation; they do not count as the live D′ runbook evidence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram,
  ComputeBudgetProgram } = require('@solana/web3.js');
const { LocalRuntime } = require('./harness');
const { encodeInstruction } = require('../../mgk-frontend/packages/layout/instructions');
const { decodeAccount, decodeResults } = require('../../mgk-frontend/packages/layout');
const deployment = require('../../deployments/devnet.json');
const CORE = new PublicKey(deployment.programs.perps_core);
const MATCHER = new PublicKey(deployment.programs.perps_matcher);
const ORACLE = new PublicKey(deployment.programs.oracle);
const CLOCK = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const meta = (pubkey, isWritable = true, isSigner = false) => ({ pubkey, isWritable, isSigner });

async function snapshot(runtime, addresses) {
  return Promise.all(addresses.map(async address => {
    const info = await runtime.rpc('getAccountInfo', [String(address), { encoding: 'base64' }]);
    return info.value;
  }));
}

async function rejectsUnchanged(runtime, instruction, signers, watched, label) {
  const before = await snapshot(runtime, watched);
  const tx = new Transaction({ feePayer: signers[0].publicKey,
    ...await runtime.connection.getLatestBlockhash('confirmed') });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction);
  tx.sign(...signers);
  const result = await runtime.rpc('simulateTransaction', [tx.serialize().toString('base64'),
    { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }]);
  assert.notEqual(result.value.err, null, `${label}: unexpectedly accepted`);
  assert.deepEqual(await snapshot(runtime, watched), before, `${label}: state changed`);
}

async function createMarket(runtime, payer, identity, users) {
  const seed = identity?.publicKey.toBuffer();
  const registrySeeds = [Buffer.from('registry'), ...(seed ? [seed] : [])];
  const [registry, registryBump] = PublicKey.findProgramAddressSync(registrySeeds, CORE);
  const derive = (tag, suffix = [], owner = CORE) => PublicKey.findProgramAddressSync(
    [Buffer.from(tag), ...(seed ? [registry.toBuffer()] : []), ...suffix], owner);
  const [instrument, instrumentBump] = derive('instrument', [Buffer.alloc(2)]);
  const [vault, vaultBump] = derive('vault');
  const [book] = derive('book', [Buffer.alloc(2)], MATCHER);
  const oracle = Keypair.generate().publicKey;
  const batch = id => derive('batch', [u64(id)])[0];
  const results = id => derive('results', [u64(id)], MATCHER)[0];
  const portfolios = users.map(user => derive('portfolio', [user.publicKey.toBuffer()])[0]);
  const ix = (name, params, keys) => {
    const inner = Buffer.from(encodeInstruction('core', name, params));
    return new TransactionInstruction({ programId: CORE, keys,
      data: seed ? Buffer.concat([Buffer.from([29]), seed, inner]) : inner });
  };
  const send = (label, instruction, signers = [payer]) => runtime.send(label, [instruction], signers);
  const freshOracle = async (price = 100_000_000) => runtime.setOracle(oracle, {
    owner: ORACLE, authority: payer.publicKey, instrument, price,
    publishTime: Number((await runtime.account(CLOCK)).data.readBigInt64LE(32)), confidence: 12,
  });
  await freshOracle();
  await send('initialize market', ix('Initialize', {
    governance: payer.publicKey.toBytes(), instrumentCount: 1, volatilityMultiplier: 10000,
    batchIdCounter: 0n, baseDeposit: 1000000n, nMin: 1, tMinSlots: 10n, tMaxSlots: 25n,
    tRevealSlots: 25n, instrumentId: 0, tickSize: 1n, lotSize: 1n, imrBps: 2000, mmrBps: 1000,
    takerFeeBps: 5, makerFeeBps: 0, oracleAddr: oracle.toBytes(), registryBump, instrumentBump, vaultBump,
  }, [meta(registry), meta(payer.publicKey, true, true), meta(instrument),
    meta(SystemProgram.programId, false), meta(vault), ...(identity ? [meta(identity.publicKey, false, true)] : [])]),
  identity ? [payer, identity] : [payer]);
  const initBook = () => ix('InitializeBook', { instrumentId: 0 }, [meta(registry, false), meta(book),
    meta(payer.publicKey, true, true), meta(SystemProgram.programId, false), meta(MATCHER, false)]);
  await runtime.send('initialize market book', [initBook(), initBook(), initBook()], [payer]);
  await runtime.setAccount(batch(0), { owner: CORE, data: Buffer.alloc(176) });
  await send('create market batch', ix('CreateBatch', { bump: derive('batch', [u64(0)])[1] },
    [meta(batch(0)), meta(registry)]));
  await send('fund insurance', ix('TopUp', { amount: 2_000_000_000n },
    [meta(payer.publicKey, true, true), meta(vault), meta(SystemProgram.programId, false)]));
  for (let i = 0; i < users.length; i++) {
    await runtime.setAccount(portfolios[i], { owner: CORE, data: Buffer.alloc(2848) });
    await send('initialize market portfolio', ix('InitPortfolio', {
      user: users[i].publicKey.toBytes(), bump: derive('portfolio', [users[i].publicKey.toBuffer()])[1],
    }, [meta(portfolios[i]), meta(users[i].publicKey, true, true)]), [payer, users[i]]);
    await send('deposit market collateral', ix('Deposit', { amount: 1_000_000_000n },
      [meta(portfolios[i]), meta(users[i].publicKey, true, true), meta(SystemProgram.programId, false), meta(vault)]),
    [payer, users[i]]);
  }
  const m = { registry, instrument, vault, book, oracle, batch, results, portfolios, ix, freshOracle, send,
    watched: [registry, instrument, vault, book, oracle, batch(0), ...portfolios],
    post: (i, params = {}, batchId = 0) => ix('PostOrder', { side: i, isMaker: i === 0, price: 100_000_000n, qty: 10n,
      instrumentId: 0, reduceOnly: false, ...params }, [meta(portfolios[i]), meta(users[i].publicKey, true, true),
      meta(batch(batchId)), meta(registry, false), meta(book), meta(MATCHER, false), meta(instrument, false),
      meta(oracle, false), meta(vault, false)]),
    pause: flags => ix('SetPauseFlags', { flags },
      [meta(registry), meta(payer.publicKey, false, true)]),
  };
  m.clear = (id = 0) => ix('ClearBatch', { numCommitments: 0, numInstruments: 1, numPortfolios: 0 },
    [meta(batch(id)), meta(book), meta(results(id)), meta(MATCHER, false), meta(registry),
      meta(instrument, false), meta(payer.publicKey, true, true), meta(SystemProgram.programId, false)]);
  m.settle = (id = 0) => ix('SettleBatch', { numCommitments: 0, numPortfolios: 2 },
    [meta(batch(id)), meta(registry), meta(vault), meta(results(id)), meta(instrument), meta(book),
      meta(oracle, false), meta(MATCHER, false), ...portfolios.map(p => meta(p)), meta(batch(id + 1))]);
  return m;
}

test('same IDs isolate default and two scoped markets through funding, pause, matching and settlement',
  { timeout: 300000 }, async t => {
    assert.ok(process.env.MGK_CANDIDATE_MANIFEST, 'MGK_CANDIDATE_MANIFEST required');
    const candidate = JSON.parse(readFileSync(process.env.MGK_CANDIDATE_MANIFEST, 'utf8'));
    const identities = [Keypair.generate(), Keypair.generate()];
    const runtime = await LocalRuntime.start({ candidates: candidate.programs, port: 20239,
      marketSeeds: [null, ...identities.map(i => i.publicKey.toBase58())],
      reportPath: process.env.MGK_ISOLATION_REPORT });
    t.after(() => runtime.close());
    const payer = Keypair.generate(), users = [Keypair.generate(), Keypair.generate()];
    for (const wallet of [payer, ...users]) await runtime.setAccount(wallet.publicKey,
      { owner: SystemProgram.programId, lamports: 100_000_000_000 });
    const legacy = await createMarket(runtime, payer, null, users);
    const original = await snapshot(runtime, legacy.watched);
    const a = await createMarket(runtime, payer, identities[0], users);
    const b = await createMarket(runtime, payer, identities[1], users);
    const watched = [...legacy.watched, ...a.watched, ...b.watched];
    const substitute = (instruction, index, pubkey) => new TransactionInstruction({
      programId: instruction.programId, data: instruction.data,
      keys: instruction.keys.map((key, at) => at === index ? { ...key, pubkey } : key),
    });
    for (const m of [legacy, a, b]) {
      for (const instruction of [
        m.ix('InitVault', { bump: 0 }, [meta(m.vault)]),
        m.ix('CreatePortfolio', { bump: 0 }, [meta(m.portfolios[0]), meta(users[0].publicKey, true, true)]),
        m.ix('InitPortfolioForUser', { user: users[0].publicKey.toBytes() },
          [meta(users[0].publicKey, true, true), meta(m.portfolios[0])]),
      ]) await rejectsUnchanged(runtime, instruction,
        instruction.keys.some(k => k.pubkey.equals(users[0].publicKey)) ? [payer, users[0]] : [payer],
        watched, 'funded account reset');
      const before = await snapshot(runtime, m.watched);
      await m.send('idempotent portfolio initialization', m.ix('InitPortfolio', {
        user: users[0].publicKey.toBytes(), bump: 0,
      }, [meta(m.portfolios[0]), meta(users[0].publicKey, true, true)]), [payer, users[0]]);
      assert.deepEqual(await snapshot(runtime, m.watched), before, 'idempotent initializer preserves funded state');
    }
    for (const data of [Buffer.from([29]), Buffer.concat([Buffer.from([29]), identities[0].publicKey.toBuffer()]),
      Buffer.concat([Buffer.from([29]), identities[0].publicKey.toBuffer(), Buffer.from([29, 0])])])
      await rejectsUnchanged(runtime, new TransactionInstruction({ programId: CORE, data, keys: [] }),
        [payer], watched, 'malformed market envelope');
    for (const foreign of [b, legacy]) {
      for (const [index, address] of [[0, foreign.portfolios[0]], [2, foreign.batch(0)],
        [3, foreign.registry], [4, foreign.book], [6, foreign.instrument], [7, foreign.oracle], [8, foreign.vault]]) {
        await rejectsUnchanged(runtime, substitute(a.post(0), index, address), [payer, users[0]], watched,
          `foreign post account ${index}`);
      }
      const deposit = a.ix('Deposit', { amount: 1n }, [meta(a.portfolios[0]),
        meta(users[0].publicKey, true, true), meta(SystemProgram.programId, false), meta(a.vault)]);
      for (const [index, address] of [[0, foreign.portfolios[0]], [3, foreign.vault]])
        await rejectsUnchanged(runtime, substitute(deposit, index, address), [payer, users[0]], watched,
          `foreign deposit account ${index}`);
    }
    // Unwrapped legacy instructions cannot access scoped state, even with
    // the correct user/admin signatures and correctly typed account bodies.
    for (const instruction of [
      legacy.ix('Deposit', { amount: 1n }, [meta(a.portfolios[0]), meta(users[0].publicKey, true, true),
        meta(SystemProgram.programId, false), meta(a.vault)]),
      legacy.ix('InitVault', { bump: 0 }, [meta(a.vault)]),
      legacy.ix('InitPortfolioForUser', { user: users[0].publicKey.toBytes() },
        [meta(users[0].publicKey, true, true), meta(a.portfolios[0])]),
      legacy.ix('SetPauseFlags', { flags: 7 }, [meta(a.registry), meta(payer.publicKey, false, true)]),
    ]) await rejectsUnchanged(runtime, instruction,
      instruction.keys.some(k => k.pubkey.equals(users[0].publicKey)) ? [payer, users[0]] : [payer], watched, 'legacy bypass');
    await a.send('pause scoped A', a.pause(7));
    await rejectsUnchanged(runtime, a.post(0), [payer, users[0]], watched, 'paused A rejects posting');
    for (let i = 0; i < 2; i++) await b.send('post in B while A paused', b.post(i), [payer, users[i]]);
    await a.send('unpause scoped A', a.ix('Unpause', { resumeWithdrawals: true, resumeTrading: true },
      [meta(a.registry), meta(a.vault, false), meta(payer.publicKey, false, true)]));
    for (let i = 0; i < 2; i++) await a.send('post in A', a.post(i), [payer, users[i]]);
    await runtime.advanceSlots(40);
    for (const m of [a, b]) {
      await m.send('close market', m.ix('CloseCommitting', {}, [meta(m.batch(0)), meta(m.registry)]));
      await m.send('clear market', m.clear());
      assert.equal(decodeResults((await runtime.account(m.results(0))).data).numFills, 2);
      await runtime.setAccount(m.batch(1), { owner: CORE, data: Buffer.alloc(176) });
      await m.freshOracle();
      const foreign = m === a ? b : a;
      for (const [index, address] of [[1, foreign.registry], [2, foreign.vault], [3, foreign.results(0)],
        [4, foreign.instrument], [5, foreign.book], [8, foreign.portfolios[0]],
        [9, foreign.portfolios[1]], [10, foreign.batch(1)]]) {
        // The other next batch may not exist yet; rejection is still required.
        await rejectsUnchanged(runtime, substitute(m.settle(), index, address), [payer], watched,
          `foreign settlement account ${index}`);
      }
      await m.send('settle market', m.settle());
      assert.equal(decodeAccount('Batch', (await runtime.account(m.batch(0))).data).status, 3);
      assert.equal(decodeResults((await runtime.account(m.results(0))).data).spent, true);
      assert.equal(decodeAccount('Portfolio', (await runtime.account(m.portfolios[0])).data).positions[0].qty, 10n);
      await rejectsUnchanged(runtime, m.settle(), [payer], watched, 'settlement replay');
    }
    assert.deepEqual(await snapshot(runtime, legacy.watched), original,
      'default account bytes and lamports unchanged by scoped operations');
  });

test('insurance exhaustion and staged recovery are confined to their scoped market',
  { timeout: 300000 }, async t => {
    assert.ok(process.env.MGK_CANDIDATE_MANIFEST, 'MGK_CANDIDATE_MANIFEST required');
    const candidate = JSON.parse(readFileSync(process.env.MGK_CANDIDATE_MANIFEST, 'utf8'));
    const identity = Keypair.generate();
    const runtime = await LocalRuntime.start({ candidates: candidate.programs, port: 20249,
      marketSeeds: [null, identity.publicKey.toBase58()] });
    t.after(() => runtime.close());
    const payer = Keypair.generate(), users = [Keypair.generate(), Keypair.generate()];
    for (const wallet of [payer, ...users]) await runtime.setAccount(wallet.publicKey,
      { owner: SystemProgram.programId, lamports: 100_000_000_000 });
    const legacy = await createMarket(runtime, payer, null, users);
    const baseline = await snapshot(runtime, legacy.watched);
    const m = await createMarket(runtime, payer, identity, users);
    for (const id of [0, 1]) {
      await m.freshOracle();
      for (let i = 0; i < 2; i++) await m.send('post exhaustion scenario', m.post(i,
        { side: id === 0 ? i : 1 - i, price: id === 0 ? 100_000_000n : 20_000_000n,
          qty: 1000n, reduceOnly: id === 1 }, id), [payer, users[i]]);
      await runtime.advanceSlots(40);
      await m.send('close exhaustion scenario', m.ix('CloseCommitting', {}, [meta(m.batch(id)), meta(m.registry)]));
      await m.send('clear exhaustion scenario', m.clear(id));
      await runtime.setAccount(m.batch(id + 1), { owner: CORE, data: Buffer.alloc(176) });
      await m.freshOracle(id === 0 ? 100_000_000 : 20_000_000);
      await m.send('settle exhaustion scenario', m.settle(id));
    }
    const vault = decodeAccount('Vault', (await runtime.account(m.vault)).data);
    const registry = decodeAccount('Registry', (await runtime.account(m.registry)).data);
    assert.equal(vault.insuranceFund, 0n);
    assert.ok(vault.uncoveredBadDebt > 0n, 'winner payout exceeds collected collateral and fund');
    assert.equal(registry.pauseFlags & 3, 3, 'trading and withdrawals pause together');
    assert.deepEqual(await snapshot(runtime, legacy.watched), baseline, 'exhaustion leaves default accounts unchanged');
    const unpause = (resumeWithdrawals, resumeTrading) => m.ix('Unpause', { resumeWithdrawals, resumeTrading },
      [meta(m.registry), meta(m.vault, false), meta(payer.publicKey, false, true)]);
    await rejectsUnchanged(runtime, unpause(true, false), [payer], m.watched, 'unfunded recovery');
    await m.send('top up scoped debt and reserve', m.ix('TopUp', { amount: vault.uncoveredBadDebt + 2_000_000_000n },
      [meta(payer.publicKey, true, true), meta(m.vault), meta(SystemProgram.programId, false)]));
    await rejectsUnchanged(runtime, unpause(false, true), [payer], m.watched, 'trading before withdrawals');
    await m.send('resume scoped withdrawals', unpause(true, false));
    assert.equal(decodeAccount('Registry', (await runtime.account(m.registry)).data).pauseFlags & 3, 1);
    // The default market remains live while the scoped market is risk-off.
    await legacy.freshOracle();
    await legacy.send('default accepts order during scoped recovery', legacy.post(0), [payer, users[0]]);
    await m.send('resume scoped trading', unpause(false, true));
    assert.equal(decodeAccount('Registry', (await runtime.account(m.registry)).data).pauseFlags & 3, 0);
    assert.equal(decodeAccount('Vault', (await runtime.account(m.vault)).data).uncoveredBadDebt, 0n);
  });
