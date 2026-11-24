"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Keypair, PublicKey, Transaction } = require("@solana/web3.js");
const { layouts } = require("../mgk-frontend/packages/layout");
const { createKeeperWorker } = require("./keeper-worker");
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
function fixture(id = 0n, marketSeed = null) {
  const payer = Keypair.generate(),
    core = Keypair.generate().publicKey,
    matcher = Keypair.generate().publicKey,
    oracle = Keypair.generate().publicKey;
  const context=require("./market-context").createMarketContext(core,marketSeed);
  const pda = (seeds, owner = core) =>
    context.pda(
      seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s)),
      owner,
    )[0];
  const registry = pda(["registry"]),
    instrument = pda(["instrument", Buffer.alloc(2)]),
    vault = pda(["vault"]),
    batch = pda(["batch", u64(id)]),
    oracleAccount = Keypair.generate().publicKey;
  const accounts = new Map();
  const put = (key, name, fields = {}) => {
    const data = Buffer.from(layouts[name].fixture);
    for (const [field, value] of Object.entries(fields)) {
      const [offset, type] = layouts[name].fields[field];
      if (type === "u64") data.writeBigUInt64LE(BigInt(value), offset);
      else if (type === "pubkey") value.toBuffer().copy(data, offset);
      else if (type === "u16") data.writeUInt16LE(value, offset);
      else if (type === "u32") data.writeUInt32LE(value, offset);
      else data[offset] = value;
    }
    accounts.set(String(key), { owner: core, data });
    return data;
  };
  const reg = put(registry, "Registry", { batchIdCounter: id + 1n });
  const inst = put(instrument, "Instrument", {
    instrumentId: 0,
    oracleAddr: oracleAccount,
  });
  const b = put(batch, "Batch", { batchId: id, status: 0, totalCommitments: 1 });
  const [deadline] = layouts.Batch.fields.commitDeadlineSlot;
  b.writeBigUInt64LE(25n, deadline);
  const manifest = {
    schema_version: marketSeed ? 2 : 1,
    ...(marketSeed ? {market_seed:marketSeed} : {}),
    name: "keeper-test",
    cluster: "localnet",
    programs: {
      perps_core: String(core),
      perps_matcher: String(matcher),
      oracle: String(oracle),
    },
    accounts: Object.fromEntries(
      Object.entries({
        registry,
        instrument,
        oracle: oracleAccount,
        insurance: vault,
        maker: payer.publicKey,
      }).map(([k, v]) => [k, { status: "deployed", address: String(v) }]),
    ),
    start_slot: { status: "set", slot: 0 },
  };
  const sent = [],
    alerts = [];
  let slot = 0,
    balance = 2e9,
    fail = false,
    time = 0;
  const connection = {
    getAccountInfo: async (key) => accounts.get(String(key)) ?? null,
    // Routes through getAccountInfo so tests that override it see the same reads.
    getMultipleAccountsInfoAndContext: async (keys) => ({
      context: { slot },
      value: await Promise.all(
        keys.map((key) =>
          key.equals(payer.publicKey)
            ? { owner: PublicKey.default, lamports: balance, data: Buffer.alloc(0) }
            : connection.getAccountInfo(key),
        ),
      ),
    }),
    getSlot: async () => slot,
    getBalance: async () => balance,
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    }),
    getSignatureStatuses: async () => ({
      value: [{ err: null, confirmationStatus: "confirmed" }],
    }),
    sendRawTransaction: async (raw) => {
      assert.ok(raw.length <= 1232, "signed packet fits Solana limit");
      const tx = Transaction.from(raw);
      assert.ok(tx.verifySignatures());
      const ixs = tx.instructions.filter((ix) => ix.programId.equals(core));
      sent.push(...ixs);
      if (fail) throw Error("RPC credentials must stay private");
      for (const ix of ixs) {
      const data=marketSeed ? ix.data.subarray(33) : ix.data;
      if (data[0] === 30) {
        const closed = data.readBigUInt64LE(1);
        assert.ok(ix.keys[3].pubkey.equals(payer.publicKey) && ix.keys[3].isSigner);
        accounts.delete(String(pda(["batch", u64(closed)])));
        accounts.delete(String(pda(["results", u64(closed)], matcher)));
      }
      if (data[0] === 6) b[layouts.Batch.fields.status[0]] = 2;
      if (data[0] === 7) {
        b[layouts.Batch.fields.status[0]] = 4;
        const data = Buffer.alloc(51);
        data[0] = 8;
        data[1] = 1;
        data.writeBigUInt64LE(id, 8);
        accounts.set(String(pda(["results", u64(id)], matcher)), {
          owner: matcher,
          data,
        });
      }
      if (data[0] === 8) {
        b[layouts.Batch.fields.status[0]] = 3;
        reg.writeBigUInt64LE(
          id + 2n,
          layouts.Registry.fields.batchIdCounter[0],
        );
        put(pda(["batch", u64(id + 1n)]), "Batch", {
          batchId: id + 1n,
          status: 0,
        });
      }
      }
      return "signature";
    },
  };
  return {
    options: {
      manifest,
      payer,
      connection,
      now: () => time,
      alert: (a) => alerts.push(a),
    },
    accounts,
    pda,
    core,
    matcher,
    b,
    reg,
    inst,
    batch,
    sent,
    alerts,
    setSlot: (v) => (slot = v),
    setBalance: (v) => (balance = v),
    setFail: (v) => (fail = v),
    setTime: (v) => (time = v),
    // Settled history below the current batch, each with spent results.
    settle: (ids) => {
      for (const n of ids) {
        put(pda(["batch", u64(n)]), "Batch", { batchId: n, status: 3 });
        const r = Buffer.alloc(51);
        r[0] = 8;
        r.writeBigUInt64LE(BigInt(n), 8);
        r[16] = 1;
        accounts.set(String(pda(["results", u64(n)], matcher)), { owner: matcher, data: r });
      }
    },
  };
}
test("current collecting batch waits for deadline, then clears and restart settles", async () => {
  const f = fixture();
  const w = await createKeeperWorker(f.options);
  assert.equal((await w.tick()).status, "collecting");
  assert.equal(f.sent.length, 0);
  f.setSlot(26);
  assert.equal((await w.tick()).status, "closed");
  assert.equal((await w.tick()).status, "cleared");
  const restarted = await createKeeperWorker(f.options);
  assert.equal((await restarted.tick()).status, "settled");
  assert.deepEqual(
    f.sent.map((ix) => ix.data[0]),
    [6, 7, 8],
  );
  assert.equal((await restarted.tick()).batchId, 1n);
});
test("a collecting batch sleeps until its deadline and steady ticks cost one read", async () => {
  const f = fixture();
  // Count only the worker's own RPC calls, not the mock's internal reads.
  const calls = [];
  let depth = 0;
  for (const [name, fn] of Object.entries(f.options.connection))
    f.options.connection[name] = async (...args) => {
      if (depth === 0) calls.push(name);
      depth++;
      try {
        return await fn(...args);
      } finally {
        depth--;
      }
    };
  const w = await createKeeperWorker(f.options);
  calls.length = 0;
  f.setSlot(5);
  const first = await w.tick();
  assert.equal(first.status, "collecting");
  assert.equal(first.waitMs, 20 * 400);
  // The first tick has no batch guess yet; the next one reads everything at once.
  calls.length = 0;
  await w.tick();
  assert.deepEqual(calls, ["getMultipleAccountsInfoAndContext"]);
  f.setSlot(0);
  f.b.writeBigUInt64LE(10_000n, layouts.Batch.fields.commitDeadlineSlot[0]);
  assert.equal((await w.tick()).waitMs, 30_000);
  assert.ok(!calls.includes("simulateTransaction"));
});
test("missing current batch halts permanently without historical fallback", async () => {
  const f = fixture();
  f.accounts.delete(String(f.batch));
  const w = await createKeeperWorker(f.options);
  assert.equal((await w.tick()).status, "halted");
  assert.equal(f.alerts[0].code, "missing_batch");
  assert.equal((await w.tick()).status, "halted");
  assert.equal(f.sent.length, 0);
});
test("failed settlement including missing results backs off without skipping", async () => {
  const f = fixture();
  f.setSlot(26);
  const w = await createKeeperWorker(f.options);
  await w.tick();
  await w.tick();
  f.setFail(true);
  assert.equal((await w.tick()).status, "retry");
  assert.equal((await w.tick()).status, "backoff");
  assert.equal(f.sent.length, 3);
  f.setTime(2000);
  assert.equal((await w.tick()).status, "retry");
  f.setTime(5999);
  assert.equal((await w.tick()).status, "backoff");
  f.setFail(false);
  f.setTime(6000);
  assert.equal((await w.tick()).status, "settled");
  assert.equal(
    f.reg.readBigUInt64LE(layouts.Registry.fields.batchIdCounter[0]),
    2n,
  );
  const g = fixture();
  g.b[layouts.Batch.fields.status[0]] = 4;
  const other = await createKeeperWorker(g.options);
  assert.equal((await other.tick()).status, "retry");
  assert.equal((await other.tick()).status, "backoff");
  assert.equal(g.sent.length, 0);
});
test("fee starvation alerts and resumes same batch after topup; unsafe RPC integers fail closed", async () => {
  const f = fixture();
  f.setSlot(26);
  f.setBalance(1);
  const w = await createKeeperWorker(f.options);
  const starved = await w.tick();
  assert.equal(starved.status, "low_fee_sol");
  assert.equal(starved.waitMs, 30_000);
  assert.equal(f.alerts[0].code, "low_fee_sol");
  assert.equal(f.sent.length, 0);
  f.setBalance(2e9);
  assert.equal((await w.tick()).status, "closed");
  f.setBalance(Number.MAX_SAFE_INTEGER + 1);
  await assert.rejects(w.tick(), /balance/);
  assert.equal(f.sent.length, 1);
});
test("every real keeper CLI rejects legacy overrides without exposing credentials", () => {
  const { spawnSync } = require("node:child_process");
  for (const entry of [
    "keeper-worker-cli.js",
    "ops-keeper.js",
    "keeper-crank.js",
  ]) {
    const result = spawnSync(
      process.execPath,
      [require("node:path").join(__dirname, entry), "--once"],
      {
        env: {
          ...process.env,
          NO_DNA: "1",
          BOOK_ADDRESS: "private-legacy-value",
          RPC_URL: "https://secret:password@example.invalid",
        },
      },
    );
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /startup_validation_failed/);
    assert.doesNotMatch(String(result.stderr), /private-legacy-value|password/);
  }
});
test("two keepers racing observe monotonic progress without halting", async () => {
  const f = fixture();
  f.setSlot(26);
  const [a, b] = await Promise.all([
    createKeeperWorker(f.options),
    createKeeperWorker(f.options),
  ]);
  for (let i = 0; i < 3; i++) {
    const results = await Promise.all([a.tick(), b.tick()]);
    assert.ok(results.every((r) => r.status !== "halted"));
  }
  assert.equal(
    f.reg.readBigUInt64LE(layouts.Registry.fields.batchIdCounter[0]),
    2n,
  );
});
test("settlement serializes all twelve distinct portfolios and exact u64 successor", async () => {
  const id = 9007199254740993n,
    f = fixture(id);
  f.b[layouts.Batch.fields.status[0]] = 4;
  const users = Array.from({ length: 12 }, () => Keypair.generate().publicKey);
  const data = Buffer.alloc(51 + 58 * 12);
  data[0] = 8;
  data[1] = 1;
  data.writeBigUInt64LE(id, 8);
  data.writeUInt16LE(12, 49);
  users.forEach((user, i) => user.toBuffer().copy(data, 51 + 58 * i));
  const results = f.pda([Buffer.from("results"), u64(id)], f.matcher);
  f.accounts.set(String(results), { owner: f.matcher, data });
  const w = await createKeeperWorker(f.options);
  assert.equal((await w.tick()).status, "settled");
  const ix = f.sent[0];
  assert.equal(ix.keys.length, 23);
  assert.equal(ix.data.readUInt16LE(3), 12);
  assert.ok(ix.keys[3].isWritable && ix.keys[5].isWritable);
  assert.deepEqual(
    ix.keys.slice(8, 20).map((k) => String(k.pubkey)),
    users.map((user) =>
      String(f.pda([Buffer.from("portfolio"), user.toBuffer()])),
    ),
  );
  assert.equal(
    String(ix.keys[20].pubkey),
    String(f.pda([Buffer.from("batch"), u64(id + 1n)])),
  );
  assert.ok(ix.keys[21].isSigner);
});
test("bad current batch bytes and preflight rejections never broadcast", async () => {
  for (const change of [
    (f) => (f.b[0] = 99),
    (f) => (f.b[1] = 99),
    (f) => f.b.writeBigUInt64LE(2n, 8),
    (f) => (f.accounts.get(String(f.batch)).owner = f.matcher),
  ]) {
    const f = fixture();
    change(f);
    const w = await createKeeperWorker(f.options);
    await assert.rejects(w.tick());
    assert.equal(f.sent.length, 0);
  }
  const f = fixture();
  f.setSlot(26);
  // A preflight rejection throws before the transaction reaches the cluster.
  f.options.connection.sendRawTransaction = async () => {
    throw Error("Transaction simulation failed: rejected");
  };
  const w = await createKeeperWorker(f.options);
  assert.equal((await w.tick()).status, "retry");
  assert.equal(f.sent.length, 0);
});
test("a registry advance during a missing read is reconciled without latching halt", async () => {
  const f = fixture();
  const read = f.options.connection.getAccountInfo;
  f.options.connection.getAccountInfo = async (key) => {
    if (String(key) === String(f.batch)) {
      f.reg.writeBigUInt64LE(2n, layouts.Registry.fields.batchIdCounter[0]);
      return null;
    }
    return read(key);
  };
  const w = await createKeeperWorker(f.options);
  assert.equal((await w.tick()).status, "advanced");
  assert.equal(f.alerts.length, 0);
  assert.equal(f.sent.length, 0);
});
test("reconciliation accepts only a matching batch moving through valid ordered phases", async () => {
  for (const [status, id, expected] of [
    [2, 0n, "advanced"],
    [99, 0n, "retry"],
    [2, 9n, "retry"],
  ]) {
    const f = fixture();
    f.setSlot(26);
    f.options.connection.sendRawTransaction = async () => {
      f.b[layouts.Batch.fields.status[0]] = status;
      f.b.writeBigUInt64LE(id, 8);
      throw Error("Transaction simulation failed: concurrent or invalid");
    };
    const w = await createKeeperWorker(f.options);
    assert.equal((await w.tick()).status, expected);
    assert.equal(f.sent.length, 0);
  }
});
test('scoped keeper derives its lifecycle and wraps every instruction, namespace mismatch fails closed',async()=>{
 const seed=Keypair.generate().publicKey.toBase58(), f=fixture(0n,seed);
 const worker=await createKeeperWorker(f.options);f.setSlot(26);
 await worker.tick();await worker.tick();await worker.tick();
 assert.deepEqual(f.sent.map(ix=>ix.data[0]),[29,29,29]);
 assert.deepEqual(f.sent.map(ix=>ix.data[33]),[6,7,8]);
 for(const ix of f.sent)assert.deepEqual(ix.data.subarray(1,33),new PublicKey(seed).toBuffer());
 const bad={...f.options.manifest,market_seed:Keypair.generate().publicKey.toBase58()};
 await assert.rejects(createKeeperWorker({...f.options,manifest:bad}),/Noncanonical/);
});
test("an unconfirmed crank is rebroadcast with the same signed bytes until it lands", async () => {
  const f = fixture();
  let polls = 0;
  f.options.connection.getSignatureStatuses = async () => ({
    value: [++polls < 3 ? null : { err: null, confirmationStatus: "confirmed" }],
  });
  f.options.connection.getBlockHeight = async () => 1;
  const w = await createKeeperWorker({ ...f.options, resendIntervalMs: 0 });
  f.setSlot(26);
  assert.equal((await w.tick()).status, "closed");
  assert.equal(f.sent.length, 3);
  assert.ok(f.sent.every((ix) => ix.data.equals(f.sent[0].data)));
});
test("an empty open batch past its deadline waits without closing or alerting", async () => {
  const f = fixture();
  f.b.writeUInt32LE(0, layouts.Batch.fields.totalCommitments[0]);
  f.setSlot(26);
  const w = await createKeeperWorker(f.options);
  assert.equal((await w.tick()).status, "idle");
  assert.equal((await w.tick()).status, "idle");
  assert.equal(f.sent.length, 0);
  assert.equal(f.alerts.length, 0);
});
test("CloseCommitting rejected as BatchEmpty (613) is a wait, not a retry alert", async () => {
  const f = fixture();
  f.setSlot(26);
  const send = f.options.connection.sendRawTransaction;
  f.options.connection.sendRawTransaction = async (raw, opts) => {
    if (opts?.skipPreflight === false) {
      const error = Error(
        "Simulation failed: Transaction simulation failed: Error processing Instruction 1: custom program error: 0x265",
      );
      error.logs = ["Program log: custom program error: 0x265"];
      throw error;
    }
    return send(raw, opts);
  };
  const w = await createKeeperWorker(f.options);
  const result = await w.tick();
  assert.equal(result.status, "idle");
  assert.equal(f.alerts.length, 0);
});
const closedIds = (f) =>
  f.sent.filter((ix) => ix.data[0] === 30).map((ix) => ix.data.readBigUInt64LE(1));
test("each tick closes settled batches up to min(current-3, indexer cursor), capped", async () => {
  const f = fixture(9n);
  f.settle([0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
  const w = await createKeeperWorker({
    ...f.options,
    settledThrough: async () => 8n,
    closeMaxPerTick: 4,
  });
  const first = await w.tick();
  assert.equal(first.status, "collecting");
  assert.deepEqual(first.close.closed, ["0", "1", "2", "3"]);
  await w.tick();
  // Current batch is 9, so 6 is the newest closable id even though the indexer is at 8.
  assert.deepEqual(closedIds(f), [0n, 1n, 2n, 3n, 4n, 5n, 6n]);
  assert.equal((await w.tick()).close, undefined);
  assert.equal(closedIds(f).length, 7);
  assert.ok(f.accounts.has(String(f.pda(["batch", u64(7n)]))));
  assert.equal(f.alerts.length, 0);
});
test("no indexer cursor, a failing cursor, or the disable flag closes nothing", async () => {
  for (const extra of [
    {},
    { settledThrough: async () => null },
    { settledThrough: async () => { throw Error("indexer down"); } },
    { settledThrough: async () => 8n, closeEnabled: false },
  ]) {
    const f = fixture(9n);
    f.settle([0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
    const w = await createKeeperWorker({ ...f.options, ...extra });
    const result = await w.tick();
    assert.equal(result.status, "collecting");
    assert.equal(result.close, undefined);
    assert.equal(f.sent.length, 0);
    assert.equal(f.alerts.length, 0);
  }
});
test("a failing close alerts and backs off without blocking clear and settle", async () => {
  const f = fixture(9n);
  f.settle([0n, 1n, 2n]);
  f.setSlot(26);
  const send = f.options.connection.sendRawTransaction;
  f.options.connection.sendRawTransaction = async (raw, opts) => {
    const tx = Transaction.from(raw);
    if (tx.instructions.some((ix) => ix.data[0] === 30)) throw Error("614");
    return send(raw, opts);
  };
  const w = await createKeeperWorker({ ...f.options, settledThrough: async () => 2n });
  const first = await w.tick();
  assert.equal(first.status, "closed");
  assert.equal(first.close.status, "retry");
  assert.equal(f.alerts.length, 1);
  assert.equal(f.alerts[0].code, "close_retry");
  assert.equal(f.alerts[0].severity, "warn");
  // Close backoff holds, lifecycle carries on.
  assert.equal((await w.tick()).status, "cleared");
  assert.equal((await w.tick()).status, "settled");
  assert.equal(f.alerts.length, 1);
  assert.equal(closedIds(f).length, 0);
});
test("a full close batch in a scoped market fits one signed packet", async () => {
  const seed = Keypair.generate().publicKey.toBase58(), f = fixture(9n, seed);
  f.settle([0n, 1n, 2n, 3n, 4n, 5n, 6n]);
  const w = await createKeeperWorker({
    ...f.options,
    settledThrough: async () => 8n,
    closeMaxPerTick: 6,
  });
  assert.deepEqual((await w.tick()).close.closed, ["0", "1", "2", "3", "4", "5"]);
  assert.ok(f.sent.every((ix) => ix.data[0] === 29 && ix.data[33] === 30));
  await assert.rejects(
    createKeeperWorker({ ...f.options, closeMaxPerTick: 7 }),
    /close cap/,
  );
});
test("close env knobs default sensibly and reject bad values", () => {
  const { closeConfigFromEnv } = require("./keeper-worker-cli");
  assert.deepEqual(closeConfigFromEnv({}, "devnet"), {
    closeEnabled: true,
    closeMaxPerTick: 4,
    indexerUrl: null,
  });
  assert.deepEqual(
    closeConfigFromEnv(
      {
        KEEPER_CLOSE_ENABLED: "false",
        KEEPER_CLOSE_MAX_PER_TICK: "6",
        KEEPER_INDEXER_URL: "https://indexer.example/",
      },
      "devnet",
    ),
    { closeEnabled: false, closeMaxPerTick: 6, indexerUrl: "https://indexer.example" },
  );
  for (const bad of ["0", "7", "2.5", "four"])
    assert.throws(() => closeConfigFromEnv({ KEEPER_CLOSE_MAX_PER_TICK: bad }, "devnet"));
  assert.throws(() => closeConfigFromEnv({ KEEPER_CLOSE_ENABLED: "maybe" }, "devnet"));
  assert.throws(() =>
    closeConfigFromEnv({ KEEPER_INDEXER_URL: "http://indexer.example" }, "devnet"),
  );
  assert.equal(
    closeConfigFromEnv({ KEEPER_INDEXER_URL: "http://127.0.0.1:3001" }, "localnet").indexerUrl,
    "http://127.0.0.1:3001",
  );
});
test("indexer cursor is read from /api/status, cached, and null on any doubt", async () => {
  const { createSettledThrough } = require("./keeper-worker-cli");
  let time = 0, body = { checks: { indexer: { settledThroughBatchId: "41" } } };
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (body instanceof Error) throw body;
    return { ok: true, json: async () => body };
  };
  const read = createSettledThrough("https://ix.example", {
    fetchImpl,
    now: () => time,
    cacheMs: 30_000,
  });
  assert.equal(await read(), 41n);
  body = { checks: { indexer: { settledThroughBatchId: "42" } } };
  assert.equal(await read(), 41n);
  assert.deepEqual(urls, ["https://ix.example/api/status"]);
  time = 30_000;
  assert.equal(await read(), 42n);
  for (const next of [
    { checks: { indexer: { settledThroughBatchId: null } } },
    { checks: { indexer: { settledThroughBatchId: 42 } } },
    { checks: { indexer: { settledThroughBatchId: "-1" } } },
    {},
    Error("down"),
  ]) {
    body = next;
    time += 30_000;
    assert.equal(await read(), null);
  }
});
