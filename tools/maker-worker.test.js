"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Keypair, PublicKey, Transaction } = require("@solana/web3.js");
const { layouts } = require("../mgk-frontend/packages/layout");
const { createMakerWorker } = require("./maker-worker");
function fixture() {
  const payer = Keypair.generate(),
    core = Keypair.generate().publicKey,
    matcher = Keypair.generate().publicKey,
    oracleProgram = Keypair.generate().publicKey;
  const pda = (seeds, owner = core) =>
    PublicKey.findProgramAddressSync(
      seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s)),
      owner,
    )[0];
  const registry = pda(["registry"]),
    instrument = pda(["instrument", Buffer.alloc(2)]),
    vault = pda(["vault"]),
    portfolio = pda(["portfolio", payer.publicKey.toBuffer()]),
    batch = pda(["batch", Buffer.alloc(8)]),
    oracle = Keypair.generate().publicKey;
  const accounts = new Map();
  function put(key, name, fields = {}, owner = core) {
    const data = Buffer.alloc(layouts[name].size);
    data[0] = layouts[name].discriminator;
    data[1] = layouts[name].version;
    for (const [k, v] of Object.entries(fields)) {
      const [o, t] = layouts[name].fields[k];
      if (t === "pubkey") v.toBuffer().copy(data, o);
      else if (t === "bool" || t === "u8") data[o] = Number(v);
      else if (t === "u16") data.writeUInt16LE(v, o);
      else if (t === "u64") data.writeBigUInt64LE(BigInt(v), o);
      else if (t === "i64") data.writeBigInt64LE(BigInt(v), o);
      else if (t === "i128" || t === "u128") {
        data.writeBigUInt64LE(BigInt.asUintN(64, BigInt(v)), o);
        data.writeBigInt64LE(BigInt(v) >> 64n, o + 8);
      } else throw Error(t);
    }
    accounts.set(String(key), { owner, data });
    return data;
  }
  put(registry, "Registry", { batchIdCounter: 1n, maxOrdersPerBatch: 12 });
  put(instrument, "Instrument", {
    instrumentId: 0,
    oracleAddr: oracle,
    isActive: true,
    tickSize: 1n,
    lotSize: 1n,
  });
  const p = put(portfolio, "Portfolio", {
    user: payer.publicKey,
    equity: 1000000000n,
  });
  put(vault, "Vault", { insuranceFund: 20000000000n });
  put(batch, "Batch", { batchId: 0n, status: 0, commitDeadlineSlot: 100n });
  put(
    oracle,
    "PriceOracle",
    {
      instrument,
      price: 100000000n,
      timestamp: 1000n,
      confidence: 100n,
      isActive: true,
    },
    oracleProgram,
  );
  const book = pda(["book", Buffer.alloc(2)], matcher);
  put(book, "OrderBook", { instrumentId: 0 }, matcher);
  const manifest = {
    schema_version: 1,
    name: "maker-test",
    cluster: "localnet",
    programs: {
      perps_core: String(core),
      perps_matcher: String(matcher),
      oracle: String(oracleProgram),
    },
    accounts: Object.fromEntries(
      Object.entries({
        registry,
        instrument,
        oracle,
        insurance: vault,
        maker: payer.publicKey,
      }).map(([k, v]) => [k, { status: "deployed", address: String(v) }]),
    ),
    start_slot: { status: "set", slot: 0 },
  };
  const sent = [],
    alerts = [];
  let simulationError = null;
  const connection = {
    getAccountInfo: async (k) => accounts.get(String(k)) ?? null,
    getSlot: async () => 0,
    getBalance: async () => 2e9,
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    }),
    simulateTransaction: async () => ({ value: { err: simulationError } }),
    getSignatureStatuses: async () => ({
      value: [{ err: null, confirmationStatus: "confirmed" }],
    }),
    sendRawTransaction: async (raw) => {
      assert.ok(raw.length <= 1232);
      const tx = Transaction.from(raw);
      assert.ok(tx.verifySignatures());
      sent.push(tx);
      return "signature";
    },
    getProgramAccounts: async () => [],
  };
  return {
    options: {
      payer,
      manifest,
      connection,
      now: () => 1000000,
      alert: (v) => alerts.push(v),
    },
    put,
    accounts,
    sent,
    alerts,
    portfolio,
    oracle,
    payer,
    core,
    matcher,
    registry,
    instrument,
    vault,
    batch,
    book,
    p,
    setSimulationError: (e) => (simulationError = e),
  };
}
test("maker posts an atomic three-level ladder per side at 10, 20 and 30 bps, never taker", async () => {
  const f = fixture();
  const result = await (await createMakerWorker(f.options)).tick();
  assert.equal(result.status, "quoted");
  const orders = f.sent[0].instructions.filter((ix) => ix.data[0] === 20);
  assert.equal(orders.length, 6);
  assert.deepEqual(
    orders.map((ix) => ix.data.readBigInt64LE(3)),
    [99900000n, 99800000n, 99700000n, 100100000n, 100200000n, 100300000n],
  );
  for (const ix of orders) {
    assert.equal(ix.data[2], 1);
    assert.equal(ix.data.readBigUInt64LE(11), 100n);
  }
  assert.equal(f.sent.length, 1);
});
module.exports = { fixture };
function seedOrders(
  f,
  prices = [
    99900000n,
    99800000n,
    99700000n,
    100100000n,
    100200000n,
    100300000n,
  ],
) {
  const base = layouts.Portfolio.fields.orders[0],
    size = layouts.OrderReservation.size;
  prices.forEach((price, index) => {
    const b = f.p.subarray(base + index * size);
    b.writeBigUInt64LE(BigInt(index + 1), 0);
    b.writeBigUInt64LE(100n, 8);
    b.writeBigUInt64LE(100n, 16);
    b.writeBigInt64LE(price, 24);
    b[50] = index < 3 ? 0 : 1;
  });
}
test("maker restart and next batch preserve existing ladder without stacking GTCs", async () => {
  const f = fixture();
  seedOrders(f);
  for (let n = 0; n < 2; n++) {
    if (n === 1) {
      f.accounts
        .get(String(f.registry))
        .data.writeBigUInt64LE(2n, layouts.Registry.fields.batchIdCounter[0]);
      const id = Buffer.alloc(8);
      id.writeBigUInt64LE(1n);
      const next = PublicKey.findProgramAddressSync(
        [Buffer.from("batch"), id],
        f.core,
      )[0];
      f.put(next, "Batch", {
        batchId: 1n,
        status: 0,
        commitDeadlineSlot: 100n,
      });
    }
    assert.equal(
      (await (await createMakerWorker(f.options)).tick()).status,
      "resting",
    );
  }
  assert.equal(f.sent.length, 0);
});
test("invalid oracle cancels all quotes and never posts, including malformed and foreign data", async () => {
  for (const mode of [
    "stale",
    "future",
    "inactive",
    "zero",
    "confidence",
    "instrument",
    "owner",
    "version",
    "missing",
  ]) {
    const f = fixture();
    seedOrders(f);
    const a = f.accounts.get(String(f.oracle));
    if (mode === "stale") a.data.writeBigInt64LE(939n, 88);
    if (mode === "future") a.data.writeBigInt64LE(1001n, 88);
    if (mode === "inactive") a.data[10] = 0;
    if (mode === "zero") a.data.writeBigInt64LE(0n, 80);
    if (mode === "confidence") a.data.writeBigInt64LE(1000001n, 96);
    if (mode === "instrument")
      Keypair.generate().publicKey.toBuffer().copy(a.data, 48);
    if (mode === "owner") a.owner = f.core;
    if (mode === "version") a.data[1] = 2;
    if (mode === "missing") f.accounts.delete(String(f.oracle));
    const result = await (await createMakerWorker(f.options)).tick();
    assert.equal(result.status, "invalid_price", mode);
    assert.deepEqual(
      f.sent.flatMap((tx) =>
        tx.instructions
          .filter((ix) => ix.programId.equals(f.core))
          .map((ix) => ix.data[0]),
      ),
      [13],
      mode,
    );
  }
});
test("price changes atomically cancel old quotes and replace six levels", async () => {
  const f = fixture();
  seedOrders(f);
  f.accounts.get(String(f.oracle)).data.writeBigInt64LE(200000000n, 80);
  assert.equal(
    (await (await createMakerWorker(f.options)).tick()).status,
    "quoted",
  );
  assert.deepEqual(
    f.sent[0].instructions
      .filter((ix) => ix.programId.equals(f.core))
      .map((ix) => ix.data[0]),
    [13, 20, 20, 20, 20, 20, 20],
  );
});
test("maker acts as last-resort liquidator using canonical victim and clears own reservations first", async () => {
  const f = fixture();
  seedOrders(f);
  const victim = Keypair.generate().publicKey;
  const victimPortfolio = PublicKey.findProgramAddressSync(
    [Buffer.from("portfolio"), victim.toBuffer()],
    f.core,
  )[0];
  const data = f.put(victimPortfolio, "Portfolio", {
    user: victim,
    equity: 0n,
    positionsLen: 1,
  });
  const offset = layouts.Portfolio.fields.positions[0];
  data.writeBigInt64LE(1000n, offset + layouts.Position.fields.qty[0]);
  data.writeBigInt64LE(
    100000000n,
    offset + layouts.Position.fields.entryVwap[0],
  );
  f.options.connection.getProgramAccounts = async () => [
    { pubkey: victimPortfolio, account: { owner: f.core, data } },
  ];
  const result = await (await createMakerWorker(f.options)).tick();
  assert.equal(result.status, "liquidated");
  assert.deepEqual(
    f.sent[0].instructions
      .filter((ix) => ix.programId.equals(f.core))
      .map((ix) => ix.data[0]),
    [13, 9],
  );
  const liquidation = f.sent[0].instructions.at(-1);
  assert.equal(String(liquidation.keys[0].pubkey), String(victimPortfolio));
  assert.equal(String(liquidation.keys[4].pubkey), String(f.portfolio));
});
test("maker cancels quotes when collateral or exposure limits prevent replacing the ladder", async () => {
  for (const mode of [
    "collateral",
    "portfolio_cap",
    "market_cap",
    "insurance_floor",
  ]) {
    const f = fixture();
    seedOrders(f);
    if (mode === "collateral")
      f.p.writeBigInt64LE(100n, layouts.Portfolio.fields.equity[0]);
    if (mode === "portfolio_cap") {
      f.p.writeUInt16LE(1, layouts.Portfolio.fields.positionsLen[0]);
      const o = layouts.Portfolio.fields.positions[0];
      f.p.writeBigInt64LE(9800n, o + layouts.Position.fields.qty[0]);
      f.p.writeBigInt64LE(100000000n, o + layouts.Position.fields.entryVwap[0]);
    }
    if (mode === "market_cap")
      f.accounts
        .get(String(f.vault))
        .data.writeBigUInt64LE(
          49900n,
          layouts.Vault.fields.openInterestLong[0],
        );
    if (mode === "insurance_floor")
      f.accounts
        .get(String(f.vault))
        .data.writeBigUInt64LE(1n, layouts.Vault.fields.insuranceFund[0]);
    const result = await (await createMakerWorker(f.options)).tick();
    assert.equal(result.status, "blocked", mode);
    assert.deepEqual(
      f.sent[0].instructions
        .filter((ix) => ix.programId.equals(f.core))
        .map((ix) => ix.data[0]),
      [13],
    );
  }
});
test("simulation failure never sends an unfunded or unsafe ladder", async () => {
  const f = fixture();
  f.setSimulationError({ InstructionError: [1, "Custom"] });
  assert.equal(
    (await (await createMakerWorker(f.options)).tick()).status,
    "retry",
  );
  assert.equal(f.sent.length, 0);
  assert.equal(f.alerts[0].code, "cycle_failed");
});
test("liquidator skips an unserviceable victim and takes over the next eligible portfolio", async () => {
  const f = fixture();
  const candidates = [];
  for (let n = 0; n < 2; n++) {
    const user = Keypair.generate().publicKey,
      pubkey = PublicKey.findProgramAddressSync(
        [Buffer.from("portfolio"), user.toBuffer()],
        f.core,
      )[0],
      data = f.put(pubkey, "Portfolio", { user, equity: 0n, positionsLen: 1 }),
      o = layouts.Portfolio.fields.positions[0];
    data.writeBigInt64LE(1000n, o + layouts.Position.fields.qty[0]);
    data.writeBigInt64LE(100000000n, o + layouts.Position.fields.entryVwap[0]);
    candidates.push({ pubkey, account: { owner: f.core, data } });
  }
  f.options.connection.getProgramAccounts = async () => candidates;
  let simulations = 0;
  f.options.connection.simulateTransaction = async () => ({
    value: {
      err: simulations++ === 0 ? { InstructionError: [1, "Custom"] } : null,
    },
  });
  const result = await (await createMakerWorker(f.options)).tick();
  assert.equal(result.status, "liquidated");
  assert.equal(result.victim, String(candidates[1].pubkey));
  assert.equal(f.sent.length, 1);
});
test("oracle accepts exact 60 second age and 1 percent confidence boundaries", async () => {
  const f = fixture();
  f.options.now = () => 1060000;
  f.accounts.get(String(f.oracle)).data.writeBigInt64LE(1000000n, 96);
  assert.equal(
    (await (await createMakerWorker(f.options)).tick()).status,
    "quoted",
  );
});
test("pause flags cancel maker quotes while a cleared batch waits for settlement", async () => {
  for (const flags of [1, 16]) {
    const f = fixture();
    seedOrders(f);
    f.accounts.get(String(f.registry)).data[
      layouts.Registry.fields.pauseFlags[0]
    ] = flags;
    assert.equal(
      (await (await createMakerWorker(f.options)).tick()).status,
      "blocked",
    );
    assert.deepEqual(
      f.sent[0].instructions
        .filter((ix) => ix.programId.equals(f.core))
        .map((ix) => ix.data[0]),
      [13],
    );
  }
  const f = fixture();
  seedOrders(f);
  f.accounts.get(String(f.batch)).data[layouts.Batch.fields.status[0]] = 4;
  assert.equal(
    (await (await createMakerWorker(f.options)).tick()).status,
    "awaiting_settlement",
  );
  assert.equal(f.sent.length, 0);
});
test("low fee SOL and a missing current batch fail closed with no orders", async () => {
  const f = fixture();
  f.options.connection.getBalance = async () => 1;
  assert.equal(
    (await (await createMakerWorker(f.options)).tick()).status,
    "low_fee_sol",
  );
  assert.equal(f.sent.length, 0);
  assert.equal(f.alerts[0].code, "low_fee_sol");
  const other = fixture();
  other.accounts.delete(String(other.batch));
  assert.equal(
    (await (await createMakerWorker(other.options)).tick()).status,
    "retry",
  );
  assert.equal(other.sent.length, 0);
});
test("maker rejects signer and canonical manifest binding mismatches at startup", async () => {
  const f = fixture();
  await assert.rejects(
    createMakerWorker({ ...f.options, payer: Keypair.generate() }),
    /maker signer/,
  );
  const g = fixture();
  g.options.manifest.accounts.registry.address = String(
    Keypair.generate().publicKey,
  );
  await assert.rejects(createMakerWorker(g.options), /canonical/);
});
test("maker CLI rejects unsafe role overrides and unsupported arguments without exposing secrets", () => {
  const { spawnSync } = require("node:child_process");
  const { resolve } = require("node:path");
  for (const config of [
    { args: ["--taker"], env: {} },
    {
      args: ["--once"],
      env: {
        ADMIN_KEYPAIR: "private-path-do-not-print",
        RPC_URL: "https://private-endpoint.invalid/secret",
      },
    },
  ]) {
    const result = spawnSync(
      process.execPath,
      [resolve(__dirname, "maker-worker-cli.js"), ...config.args],
      { env: { ...process.env, ...config.env }, encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /startup_validation_failed/);
    assert.doesNotMatch(result.stderr, /private-path|private-endpoint|secret/);
  }
});
