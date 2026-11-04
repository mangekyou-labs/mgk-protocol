"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { once } = require("node:events");
const { setTimeout: sleep } = require("node:timers/promises");
const {
  Keypair,
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} = require("@solana/web3.js");
const { LocalRuntime } = require("./harness");
const {
  decodeAccount,
  decodeResults,
} = require("../../mgk-frontend/packages/layout");
const {
  encodeInstruction,
} = require("../../mgk-frontend/packages/layout/instructions");
const deployment = require("../../deployments/devnet.json");
const CORE = new PublicKey(deployment.programs.perps_core),
  MATCHER = new PublicKey(deployment.programs.perps_matcher),
  ORACLE = new PublicKey(deployment.programs.oracle);
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const meta = (pubkey, isWritable = true, isSigner = false) => ({
  pubkey,
  isWritable,
  isSigner,
});
for (const identity of [null, Keypair.generate()]) test(
  `keeper CLI: crash after filled clear, concurrent restart, fee starvation and missing batch (${identity ? "scoped" : "default"})`,
  { timeout: 150000 },
  async (t) => {
    assert.ok(
      process.env.MGK_CANDIDATE_MANIFEST,
      "MGK_CANDIDATE_MANIFEST required",
    );
    const candidate = JSON.parse(
      readFileSync(process.env.MGK_CANDIDATE_MANIFEST, "utf8"),
    );
    const marketSeed = identity?.publicKey.toBase58();
    const context = require('../market-context').createMarketContext(CORE, marketSeed);
    const pda = (seeds, owner = CORE) => context.pda(seeds, owner);
    const ix = (name, params, keys) => new TransactionInstruction({programId: CORE, keys,
      data: Buffer.from(encodeInstruction('core', name, params, marketSeed))});
    const runtime = await LocalRuntime.start({
      candidates: candidate.programs,
      port: Number(process.env.MGK_KEEPER_PORT ?? 19919) + (identity ? 400 : 0),
      marketSeeds: [marketSeed ?? null],
      reportPath: process.env.MGK_KEEPER_REPORT,
    });
    t.after(() => runtime.close());
    runtime.report.candidateCommit = candidate.commit;
    const directory = mkdtempSync(join(tmpdir(), "keeper-config-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const payer = Keypair.generate(),
      maker = Keypair.generate(),
      taker = Keypair.generate();
    for (const wallet of [payer, maker, taker])
      await runtime.setAccount(wallet.publicKey, {
        owner: SystemProgram.programId,
        lamports: 20e9,
      });
    const [registry, registryBump] = pda([Buffer.from("registry")]),
      [instrument, instrumentBump] = pda([
        Buffer.from("instrument"),
        Buffer.alloc(2),
      ]),
      [vault] = pda([Buffer.from("vault")]),
      [batch, batchBump] = pda([Buffer.from("batch"), u64(0)]),
      [book] = pda([Buffer.from("book"), Buffer.alloc(2)], MATCHER),
      [results] = pda([Buffer.from("results"), u64(0)], MATCHER);
    const oracle = Keypair.generate().publicKey;
    const traders = [maker, taker],
      portfolios = traders.map((user) =>
        pda([Buffer.from("portfolio"), user.publicKey.toBuffer()]),
      );
    const rent = await runtime.rpc("getMinimumBalanceForRentExemption", [80]);
    for (const [address, owner, size] of [
      [registry, CORE, 94],
      [instrument, CORE, 352],
      [vault, CORE, 80],
      [batch, CORE, 176],
      [book, MATCHER, 27712],
      ...portfolios.map(([address]) => [address, CORE, 2848]),
    ])
      await runtime.setAccount(address, {
        owner,
        data: Buffer.alloc(size),
        ...(address === vault ? { lamports: rent } : {}),
      });
    const freshOracle = async () =>
      runtime.setOracle(oracle, {
        owner: ORACLE,
        authority: payer.publicKey,
        instrument,
        price: 100000000,
        publishTime: Number(
          (
            await runtime.account("SysvarC1ock11111111111111111111111111111111")
          ).data.readBigInt64LE(32),
        ),
        confidence: 12,
      });
    await freshOracle();
    await runtime.send(
      "initialize keeper market",
      [
        ix(
          "Initialize",
          {
            governance: payer.publicKey.toBytes(),
            instrumentCount: 1,
            volatilityMultiplier: 10000,
            batchIdCounter: 0n,
            baseDeposit: 1000000n,
            nMin: 1,
            tMinSlots: 10n,
            tMaxSlots: 25n,
            tRevealSlots: 25n,
            instrumentId: 0,
            tickSize: 1n,
            lotSize: 1n,
            imrBps: 2000,
            mmrBps: 1000,
            takerFeeBps: 5,
            makerFeeBps: 0,
            oracleAddr: oracle.toBytes(),
            registryBump,
            instrumentBump,
          },
          [
            meta(registry),
            meta(payer.publicKey, true, true),
            meta(instrument),
            meta(SystemProgram.programId, false),
            meta(vault),
            ...(identity ? [meta(identity.publicKey, false, true)] : []),
          ],
        ),
      ],
      identity ? [payer, identity] : [payer],
    );
    await runtime.send(
      "initialize keeper book",
      [
        ix("InitializeBook", { instrumentId: 0 }, [
          meta(registry, false),
          meta(book),
          meta(payer.publicKey, true, true),
          meta(SystemProgram.programId, false),
          meta(MATCHER, false),
        ]),
      ],
      [payer],
    );
    await runtime.send(
      "create initial batch",
      [ix("CreateBatch", { bump: batchBump }, [meta(batch), meta(registry)])],
      [payer],
    );
    await runtime.send(
      "fund insurance",
      [
        ix("TopUp", { amount: 100000000n }, [
          meta(payer.publicKey, true, true),
          meta(vault),
          meta(SystemProgram.programId, false),
        ]),
      ],
      [payer],
    );
    for (let i = 0; i < 2; i++) {
      const user = traders[i],
        [portfolio, bump] = portfolios[i];
      await runtime.send(
        "init trader " + i,
        [
          ix("InitPortfolio", { user: user.publicKey.toBytes(), bump }, [
            meta(portfolio),
            meta(user.publicKey, true, true),
          ]),
        ],
        [payer, user],
      );
      await runtime.send(
        "deposit trader " + i,
        [
          ix("Deposit", { amount: 1000000000n }, [
            meta(portfolio),
            meta(user.publicKey, true, true),
            meta(SystemProgram.programId, false),
            meta(vault),
          ]),
        ],
        [payer, user],
      );
      await runtime.send(
        "post trader " + i,
        [
          ix(
            "PostOrder",
            {
              side: i,
              isMaker: i === 0,
              price: 100000000n,
              qty: 1n,
              instrumentId: 0,
              reduceOnly: false,
            },
            [
              meta(portfolio),
              meta(user.publicKey, true, true),
              meta(batch),
              meta(registry, false),
              meta(book),
              meta(MATCHER, false),
              meta(instrument, false),
              meta(oracle, false),
              meta(vault, false),
            ],
          ),
        ],
        [payer, user],
      );
    }
    const manifest = {
      ...deployment,
      ...(marketSeed ? {schema_version: 2, market_seed: marketSeed} : {}),
      cluster: "localnet",
      name: "keeper-runtime",
      accounts: Object.fromEntries(
        Object.entries({
          registry,
          instrument,
          oracle,
          insurance: vault,
          maker: maker.publicKey,
        }).map(([key, value]) => [
          key,
          { status: "deployed", address: String(value) },
        ]),
      ),
      start_slot: { status: "set", slot: 0 },
    };
    const manifestPath = join(directory, "deployment.json"),
      payerPath = join(directory, "payer.json");
    const monitoringPath = join(directory, "monitoring.json");
    const monitoring = structuredClone(require('../../deployments/monitoring.json'));
    monitoring.feePayers.keeper = payer.publicKey.toBase58();
    writeFileSync(monitoringPath, JSON.stringify(monitoring));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(payerPath, JSON.stringify([...payer.secretKey]), {
      mode: 0o600,
    });
    const launch = async (entry = "ops-keeper.js") => {
      const worker = await runtime.launchWorker(
        process.execPath,
        [resolve(__dirname, "..", entry), "--loop"],
        {
          env: {
            KEEPER_KEYPAIR: payerPath,
            DEPLOYMENT_MANIFEST: manifestPath,
            MONITORING_CONFIG: monitoringPath,
          },
        },
      );
      worker.records = [];
      worker.output = "";
      for (const stream of [worker.stdout, worker.stderr]) {
        let pending = "";
        stream.on("data", (chunk) => {
          worker.output += String(chunk);
          pending += String(chunk);
          let newline;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            try {
              worker.records.push(JSON.parse(line));
            } catch {}
          }
        });
      }
      return worker;
    };
    const wait = async (predicate, workers = []) => {
      const deadline = Date.now() + 30000;
      while (!(await predicate())) {
        assert.ok(
          Date.now() < deadline,
          "keeper timed out: " + workers.map((w) => w.output).join("\n"),
        );
        await sleep(50);
      }
    };
    const stop = async (worker) => {
      if (worker.exitCode === null && worker.signalCode === null) {
        const done = once(worker, "exit");
        worker.kill("SIGKILL");
        await done;
      }
    };
    const state = async (address, name) =>
      decodeAccount(name, (await runtime.account(address)).data);
    await runtime.advanceSlots(30);
    await freshOracle();
    const first = await launch();
    await wait(
      () => first.records.some((r) => r.status === "cleared"),
      [first],
    );
    await stop(first);
    assert.equal((await state(batch, "Batch")).status, 4);
    assert.equal(
      decodeResults((await runtime.account(results)).data).numFills,
      2,
    );
    assert.equal(
      decodeResults((await runtime.account(results)).data).spent,
      false,
    );
    const before = await runtime.invariants.before();
    const [second, third] = await Promise.all([
      launch(),
      launch("keeper-crank.js"),
    ]);
    await wait(
      () =>
        [second, third].some((w) =>
          w.records.some(
            (r) => r.status === "settled" && r.batchId === "0" && r.signature,
          ),
        ),
      [second, third],
    );
    // Both processes must finish a cycle before either is killed. This also
    // observes the losing keeper's reconciliation rather than merely its spawn.
    await wait(
      () =>
        [second, third].every((w) =>
          w.records.some((r) =>
            ["settled", "advanced", "collecting", "retry", "backoff"].includes(
              r.status,
            ),
          ),
        ),
      [second, third],
    );
    assert.ok(
      [second, third].every(
        (w) =>
          !w.records.some((r) =>
            ["halted", "startup_validation_failed", "cycle_failed"].includes(
              r.status,
            ),
          ),
      ),
    );
    const settled = [second, third]
      .flatMap((w) => w.records)
      .find((r) => r.status === "settled" && r.batchId === "0" && r.signature);
    await Promise.all([stop(second), stop(third)]);
    assert.equal(
      decodeResults((await runtime.account(results)).data).spent,
      true,
    );
    assert.equal((await state(registry, "Registry")).batchIdCounter, 2n);
    for (let i = 0; i < portfolios.length; i++) {
      const portfolio = await state(portfolios[i][0], "Portfolio");
      assert.equal(portfolio.positionsLen, 1);
      assert.equal(
        portfolio.positions[0].qty,
        i === 0 ? 1n : -1n,
        "one fill applied exactly once",
      );
      assert.equal(portfolio.positions[0].entryVwap, 100000000n);
      assert.equal(
        portfolio.feesPaid,
        i === 0 ? 0n : 500n,
        "5bps on 0.001 SOL costs 500 lamports",
      );
      assert.equal(portfolio.equity, i === 0 ? 1000000000n : 999999500n);
    }
    const [next] = pda([Buffer.from("batch"), u64(1)]);
    assert.equal((await state(next, "Batch")).status, 0);
    await runtime.invariants.after(before, {
      label: "concurrent keeper settlement",
      signature: settled.signature,
      programIds: [String(CORE)],
    });
    runtime.report.keeper = {
      crashRecovered: true,
      concurrent: true,
      concurrentOutcomes: [second, third].map((w) =>
        w.records.filter((r) => r.status).map((r) => r.status),
      ),
      invariants: "pass",
      settlementSignature: settled.signature,
    };
    runtime.flushReport();
    await runtime.setAccount(payer.publicKey, {
      owner: SystemProgram.programId,
      lamports: 1,
    });
    await runtime.advanceSlots(30);
    await freshOracle();
    const starved = await launch();
    await wait(
      () => starved.records.some((r) => r.code === "low_fee_sol"),
      [starved],
    );
    assert.equal((await state(next, "Batch")).status, 0);
    await runtime.setAccount(payer.publicKey, {
      owner: SystemProgram.programId,
      lamports: 2e9,
    });
    await wait(
      async () => (await state(next, "Batch")).status === 3,
      [starved],
    );
    await stop(starved);
    runtime.report.keeper.feeStarvationRecovered = true;
    const [missing] = pda([Buffer.from("batch"), u64(2)]);
    await runtime.setAccount(missing, {
      owner: SystemProgram.programId,
      lamports: 0,
    });
    const halted = await launch();
    await wait(
      () => halted.records.some((r) => r.code === "missing_batch"),
      [halted],
    );
    if (halted.exitCode === null) await once(halted, "exit");
    assert.equal(halted.exitCode, 1);
    assert.equal((await state(registry, "Registry")).batchIdCounter, 3n);
    runtime.report.keeper.missingBatchHalted = true;
    runtime.flushReport();
  },
);
