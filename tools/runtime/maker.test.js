"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { once } = require("node:events");
const {
  Keypair,
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} = require("@solana/web3.js");
const { LocalRuntime } = require("./harness");
const {
  decodeAccount,
  decodeStruct,
  layouts,
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
const pda = (seeds, owner = CORE) =>
  PublicKey.findProgramAddressSync(seeds, owner);
const meta = (pubkey, isWritable = true, isSigner = false) => ({
  pubkey,
  isWritable,
  isSigner,
});
const ix = (name, params, keys) =>
  new TransactionInstruction({
    programId: CORE,
    keys,
    data: Buffer.from(encodeInstruction("core", name, params)),
  });
test(
  "maker CLI: GTC ladder, taker settlement, invalid-price cancellation recovery and last-resort takeover",
  { timeout: 150000 },
  async (t) => {
    assert.ok(
      process.env.MGK_CANDIDATE_MANIFEST,
      "MGK_CANDIDATE_MANIFEST required",
    );
    const candidate = JSON.parse(
      readFileSync(process.env.MGK_CANDIDATE_MANIFEST, "utf8"),
    );
    const runtime = await LocalRuntime.start({
      candidates: candidate.programs,
      port: Number(process.env.MGK_MAKER_PORT ?? 20019),
      reportPath: process.env.MGK_MAKER_REPORT,
    });
    t.after(() => runtime.close());
    runtime.report.candidateCommit = candidate.commit;
    const directory = mkdtempSync(join(tmpdir(), "maker-config-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const payer = Keypair.generate(),
      maker = Keypair.generate(),
      taker = Keypair.generate();
    for (const wallet of [payer, maker, taker])
      await runtime.setAccount(wallet.publicKey, {
        owner: SystemProgram.programId,
        lamports: 50e9,
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
    const freshOracle = async (price = 100000000) =>
      runtime.setOracle(oracle, {
        owner: ORACLE,
        authority: payer.publicKey,
        instrument,
        price,
        publishTime: Math.min(
          Math.floor(Date.now() / 1000),
          Number(
            (
              await runtime.account(
                "SysvarC1ock11111111111111111111111111111111",
              )
            ).data.readBigInt64LE(32),
          ),
        ),
        confidence: 12,
      });
    await freshOracle();
    await runtime.send(
      "initialize maker market",
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
          ],
        ),
      ],
      [payer],
    );
    await runtime.send(
      "initialize maker book",
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
        ix("TopUp", { amount: 20000000000n }, [
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
    }
    const manifest = {
      ...deployment,
      cluster: "localnet",
      name: "maker-runtime",
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
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(payerPath, JSON.stringify([...payer.secretKey]), {
      mode: 0o600,
    });
    const launch = async (entry, keypairPath) => {
      const worker = await runtime.launchWorker(
        process.execPath,
        [resolve(__dirname, "..", entry), "--once"],
        {
          env: {
            [entry.startsWith("maker") ? "MAKER_KEYPAIR" : "KEEPER_KEYPAIR"]:
              keypairPath,
            DEPLOYMENT_MANIFEST: manifestPath,
            MONITORING_CONFIG: resolve(
              __dirname,
              "../../deployments/monitoring.json",
            ),
          },
        },
      );
      let output = "";
      for (const stream of [worker.stdout, worker.stderr])
        stream.on("data", (chunk) => {
          output += String(chunk);
        });
      const [code] = await once(worker, "exit");

      const records = output.split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      const result = records.findLast((record) => record.status);
      assert.equal(code, result?.status === "invalid_price" ? 1 : 0, output);
      return result;
    };
    const makerPath = join(directory, "maker.json");
    writeFileSync(makerPath, JSON.stringify([...maker.secretKey]), {
      mode: 0o600,
    });
    const state = async (address, name) =>
      decodeAccount(name, (await runtime.account(address)).data);
    const orders = async () => {
      const data = (await runtime.account(book)).data;
      const decoded = decodeAccount("OrderBook", data);
      const found = [];
      for (const levels of [
        decoded.bids.slice(0, decoded.bidCount),
        decoded.asks.slice(0, decoded.askCount),
      ]) {
        for (const level of levels) {
          let offset = level.firstOrderOffset;
          for (let i = 0; i < level.orderCount; i++) {
            const order = decodeStruct(
              "RestingOrder",
              data,
              layouts.OrderBook.size + offset * layouts.RestingOrder.size,
            );
            if (order.qty > order.filledQty) found.push(order);
            offset = order.nextOrderOffset;
          }
        }
      }
      return found;
    };
    const makerTick = async () => {
      const before = await runtime.invariants.before();
      const result = await launch("maker-worker-cli.js", makerPath);
      runtime.report.makerTransitions ??= [];
      runtime.report.makerTransitions.push(result);
      await runtime.invariants.after(before, {
        label: "maker " + result.status,
        signature: result.signature,
        programIds: [String(CORE)],
      });
      runtime.flushReport();
      return result;
    };
    await freshOracle();
    assert.equal((await makerTick()).status, "quoted");
    const quotes = await orders();
    assert.equal(quotes.length, 6);
    assert.deepEqual(
      quotes.map((o) => o.price).sort((a, b) => Number(a - b)),
      [99700000n, 99800000n, 99900000n, 100100000n, 100200000n, 100300000n],
    );
    for (const quote of quotes) {
      assert.equal(quote.isMaker, true);
      assert.equal(quote.qty, 100n);
      assert.equal(
        new PublicKey(quote.user).toBase58(),
        maker.publicKey.toBase58(),
      );
      assert.equal(quote.batchPlaced, 0n);
    }
    assert.equal((await makerTick()).status, "resting");
    assert.equal(
      (await orders()).length,
      6,
      "restarting must not duplicate quotes",
    );
    await runtime.send(
      "taker sells into protocol maker",
      [
        ix(
          "PostOrder",
          {
            side: 1,
            isMaker: false,
            price: 99900000n,
            qty: 100n,
            instrumentId: 0,
            reduceOnly: false,
          },
          [
            meta(portfolios[1][0]),
            meta(taker.publicKey, true, true),
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
      [payer, taker],
    );
    await runtime.advanceSlots(30);
    await freshOracle();
    for (const expected of ["closed", "cleared", "settled"]) {
      const before = await runtime.invariants.before();
      const result = await launch("keeper-worker-cli.js", payerPath);
      assert.equal(result.status, expected, JSON.stringify(result));
      await runtime.invariants.after(before, {
        label: "keeper " + expected,
        signature: result.signature,
        programIds: [String(CORE)],
      });
    }
    const fills = decodeResults((await runtime.account(results)).data);
    assert.equal(fills.spent, true);
    assert.equal(fills.numFills, 2);
    assert.equal(fills.bidClearingPrice, 99900000n);
    for (let i = 0; i < 2; i++) {
      const portfolio = await state(portfolios[i][0], "Portfolio");
      assert.equal(portfolio.positionsLen, 1);
      assert.equal(portfolio.positions[0].qty, i === 0 ? 100n : -100n);
      assert.equal(portfolio.positions[0].entryVwap, 99900000n);
      assert.equal(portfolio.feesPaid, i === 0 ? 0n : 49950n);
      assert.equal(portfolio.equity, i === 0 ? 1000000000n : 999950050n);
    }
    // The remaining five GTC orders survive settlement. An invalid oracle
    // must cancel them through real signed core instructions without new quotes.
    assert.equal((await orders()).length, 5);
    await runtime.setOracle(oracle, {
      owner: ORACLE,
      authority: payer.publicKey,
      instrument,
      price: 100000000,
      publishTime: 0,
      confidence: 12,
    });
    const invalid = await makerTick();
    assert.ok(
      ["invalid_price", "cancelled"].includes(invalid.status),
      JSON.stringify(invalid),
    );
    assert.equal((await orders()).length, 0);
    assert.equal(
      (await state(portfolios[0][0], "Portfolio")).reservedCollateral,
      0n,
    );
    assert.equal((await makerTick()).status, "invalid_price");
    assert.equal((await orders()).length, 0);
    await freshOracle();
    assert.equal((await makerTick()).status, "quoted");
    assert.equal((await orders()).length, 6);
    await runtime.send(
      "withdraw taker collateral before adverse move",
      [
        ix(
          "Withdraw",
          {
            amount: 969950050n,
          },
          [
            meta(portfolios[1][0]),
            meta(taker.publicKey, true, true),
            meta(vault),
            meta(registry, false),
            meta(instrument, false),
            meta(oracle, false),
          ],
        ),
      ],
      [payer, taker],
    );
    assert.equal(
      (await state(portfolios[1][0], "Portfolio")).equity,
      30000000n,
    );
    await freshOracle(200000000);
    const takeover = await makerTick();
    assert.equal(takeover.status, "liquidated", JSON.stringify(takeover));
    assert.equal(takeover.victim, String(portfolios[1][0]));
    assert.equal(
      (await orders()).length,
      0,
      "maker quotes cancel before takeover",
    );
    const liquidator = await state(portfolios[0][0], "Portfolio");
    const victim = await state(portfolios[1][0], "Portfolio");
    const liquidatorQty = liquidator.positionsLen
      ? liquidator.positions[0].qty
      : 0n;
    const victimQty = victim.positionsLen ? victim.positions[0].qty : 0n;
    assert.equal(
      liquidatorQty,
      0n,
      "opposite maker position closes against the entire insolvent short",
    );
    assert.equal(victimQty, 0n, "insolvent short is fully taken over");
    assert.equal(
      liquidatorQty + victimQty,
      0n,
      "takeover conserves signed base",
    );
    runtime.report.maker = {
      ladder: "pass",
      restart: "pass",
      takerSettlement: "pass",
      invalidPriceCancellation: "pass",
      recovery: "pass",
      takeover: "pass",
      invariants: "pass",
    };
    runtime.flushReport();
  },
);
