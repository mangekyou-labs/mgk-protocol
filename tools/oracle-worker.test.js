"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Keypair, PublicKey } = require("@solana/web3.js");
const { layouts } = require("../mgk-frontend/packages/layout");
const { createOracleWorker, SOL_USD_FEED } = require("./oracle-worker");
const authority = Keypair.generate();
const keys = Array.from({ length: 8 }, () =>
  Keypair.generate().publicKey.toBase58(),
);
const manifest = {
  schema_version: 1,
  name: "oracle-test",
  cluster: "localnet",
  programs: { perps_core: keys[0], perps_matcher: keys[1], oracle: keys[2] },
  accounts: Object.fromEntries(
    ["registry", "instrument", "oracle", "insurance", "maker"].map((k, i) => [
      k,
      { status: "deployed", address: keys[i + 3] },
    ]),
  ),
  start_slot: { status: "set", slot: 0 },
};
const NOW = 1_800_000_000_000;
function fixture(options = {}) {
  const oracle = Buffer.from(layouts.PriceOracle.fixture);
  authority.publicKey.toBuffer().copy(oracle, 16);
  new PublicKey(keys[4]).toBuffer().copy(oracle, 48);
  oracle[10] = 1;
  const instrument = Buffer.from(layouts.Instrument.fixture);
  new PublicKey(keys[5])
    .toBuffer()
    .copy(instrument, layouts.Instrument.fields.oracleAddr[0]);
  const published = [];
  const connection = {
    getAccountInfo: async (key) =>
      key.toBase58() === keys[5]
        ? { owner: new PublicKey(keys[2]), data: oracle }
        : { owner: new PublicKey(keys[0]), data: instrument },
  };
  const quotes = { pyth: "10000000000", coinbase: "100.20", kraken: "100.10" };
  const customFetch = async (url) => ({
    ok: true,
    json: async () =>
      url.includes("hermes")
        ? {
            parsed: [
              {
                id: SOL_USD_FEED,
                price: {
                  price: quotes.pyth,
                  conf: "30000000",
                  expo: -8,
                  publish_time: NOW / 1000,
                },
              },
            ],
          }
        : url.includes("coinbase")
          ? { price: quotes.coinbase, time: new Date(NOW).toISOString() }
          : {
              error: [],
              result: {
                SOLUSD: [[quotes.kraken, "1", NOW / 1000, "b", "m", ""]],
                last: "123",
              },
            },
  });
  return {
    oracle,
    instrument,
    published,
    quotes,
    connection,
    options: {
      manifest,
      authority,
      connection,
      now: () => NOW,
      customFetch,
      publish: async (value) => {
        published.push(value);
        return "confirmed-signature";
      },
      ...options,
    },
  };
}
test("worker publishes SOL/USD from the three actual APIs with honest confidence", async () => {
  const f = fixture();
  const worker = await createOracleWorker(f.options);
  const result = await worker.tick();
  assert.equal(result.status, "published");
  assert.equal(f.published.length, 1);
  assert.equal(f.published[0].price, 100_100_000n);
  assert.equal(f.published[0].confidence, 300_000n);
  assert.deepEqual(result.venues, ["pyth", "kraken", "coinbase"]);
});

test("one live source and non-overlapping quotes publish nothing, then quorum recovers", async () => {
  const f = fixture();
  f.quotes.coinbase = "140";
  f.quotes.kraken = "160";
  const worker = await createOracleWorker(f.options);
  assert.equal((await worker.tick()).status, "no_quorum");
  assert.equal(f.published.length, 0);
  f.quotes.coinbase = "100.20";
  f.quotes.kraken = "160";
  const recovered = await worker.tick();
  assert.equal(recovered.status, "published");
  assert.equal(f.published[0].price, 100_100_000n);
  assert.equal(f.published[0].confidence, 59_900_000n); // outlier is never hidden from confidence
  assert.deepEqual(recovered.venues, ["pyth", "coinbase"]);
  const single = fixture({
    customFetch: async (url) => {
      if (!url.includes("coinbase")) throw Error("offline");
      return {
        ok: true,
        json: async () => ({ price: "100", time: new Date(NOW).toISOString() }),
      };
    },
  });
  assert.equal(
    (await (await createOracleWorker(single.options)).tick()).status,
    "no_quorum",
  );
  assert.equal(single.published.length, 0);
});

test("manifest and frozen on-chain account identity are mandatory before any publication", async () => {
  const pending = structuredClone(manifest);
  pending.accounts.oracle = { status: "pending" };
  await assert.rejects(
    createOracleWorker(fixture({ manifest: pending }).options),
    /pending/,
  );
  const f = fixture();
  const worker = await createOracleWorker(f.options);
  f.oracle[1] = 99;
  await assert.rejects(worker.tick(), /layout version/);
  assert.equal(f.published.length, 0);
  f.oracle[1] = layouts.PriceOracle.version;
  Keypair.generate().publicKey.toBuffer().copy(f.oracle, 16);
  await assert.rejects(worker.tick(), /authority/);
  assert.equal(f.published.length, 0);
});

test("worker sends only UpdatePrice signed by explicit oracle authority and requires confirmation", async () => {
  const { Transaction } = require("@solana/web3.js");
  const f = fixture();
  delete f.options.publish;
  let sent;
  Object.assign(f.connection, {
    getLatestBlockhash: async () => ({
      blockhash: keys[7],
      lastValidBlockHeight: 100,
    }),
    simulateTransaction: async () => ({ value: { err: null } }),
    getBlockHeight: async () => 1,
    sendRawTransaction: async (bytes) => {
      sent = Transaction.from(bytes);
      return "signature";
    },
    getSignatureStatuses: async () => ({
      value: [{ err: null, confirmationStatus: "confirmed" }],
    }),
  });
  assert.equal(
    (await (await createOracleWorker(f.options)).tick()).status,
    "published",
  );
  assert.equal(sent.instructions.length, 1);
  assert.equal(sent.instructions[0].programId.toBase58(), keys[2]);
  assert.equal(sent.instructions[0].data[0], 1);
  assert.equal(sent.instructions[0].data.readBigInt64LE(1), 100_100_000n);
  assert.equal(sent.instructions[0].data.readBigInt64LE(9), 300_000n);
  assert.equal(sent.signatures.length, 1);
  assert.ok(sent.signatures[0].publicKey.equals(authority.publicKey));
  f.connection.getSignatureStatuses = async () => ({
    value: [
      {
        err: { InstructionError: [0, "InvalidArgument"] },
        confirmationStatus: "confirmed",
      },
    ],
  });
  await assert.rejects((await createOracleWorker(f.options)).tick(), /failed/);
});

test("Hermes exponent and confidence retain exact micro-USD precision with optional authenticated endpoint", async () => {
  const f = fixture({
    hermesUrl: "https://pyth.dourolabs.app/hermes",
    pythApiKey: "test-token",
  });
  const original = f.options.customFetch;
  let authorized = false;
  f.options.customFetch = async (url, options) => {
    if (!url.includes("hermes")) return original(url, options);
    assert.ok(
      url.startsWith(
        "https://pyth.dourolabs.app/hermes/v2/updates/price/latest?",
      ),
    );
    authorized = options.headers.Authorization === "Bearer test-token";
    return {
      ok: true,
      json: async () => ({
        parsed: [
          {
            id: SOL_USD_FEED,
            price: {
              price: "100000000",
              conf: "300001",
              expo: -6,
              publish_time: NOW / 1000,
            },
          },
        ],
      }),
    };
  };
  const result = await (await createOracleWorker(f.options)).tick();
  assert.equal(authorized, true);
  assert.equal(result.confidence, 300_001n);
  assert.equal(result.price, 100_100_000n);
});

test("worker process refuses startup without an explicit oracle authority path", () => {
  const { spawnSync } = require("node:child_process");
  const result = spawnSync(
    process.execPath,
    [require("node:path").join(__dirname, "oracle-worker-cli.js")],
    {
      env: { PATH: process.env.PATH, NO_DNA: "1" },
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ORACLE_AUTHORITY_KEYPAIR/);
  assert.doesNotMatch(result.stderr, /ephemeral|fallback/);
});

test("50 bps is pairwise, inclusive at the boundary, and ambiguous pairs fail closed", async () => {
  for (const [prices, status, price] of [
    [["10000000000", "100.50", "150"], "published", 100_250_000n],
    [["10000000000", "100.500001", "150"], "no_quorum"],
    [["10000000000", "100.40", "100.80"], "no_quorum"],
  ]) {
    const f = fixture();
    [f.quotes.pyth, f.quotes.coinbase, f.quotes.kraken] = prices;
    const result = await (await createOracleWorker(f.options)).tick();
    assert.equal(result.status, status);
    if (price) assert.equal(result.price, price);
    else assert.equal(f.published.length, 0);
  }
});

test("stale, future, non-finite, wrong-feed and failed HTTP observations cannot form quorum", async () => {
  for (const corrupt of [
    (body) => {
      body.price.publish_time -= 31;
    },
    (body) => {
      body.price.publish_time += 1;
    },
    (body) => {
      body.price.price = "NaN";
    },
    (body) => {
      body.id = "wrong-feed";
    },
  ]) {
    const f = fixture();
    const original = f.options.customFetch;
    f.options.customFetch = async (url, options) => {
      if (url.includes("kraken")) return { ok: false, status: 503 };
      const response = await original(url, options);
      if (url.includes("hermes")) {
        const body = await response.json();
        corrupt(body.parsed[0]);
        return { ok: true, json: async () => body };
      }
      return response;
    };
    assert.equal(
      (await (await createOracleWorker(f.options)).tick()).status,
      "no_quorum",
    );
    assert.equal(f.published.length, 0);
  }
});

test("revalidates source age after a delayed simulation and never sends expired quotes", async () => {
  let now = NOW;
  const f = fixture({ now: () => now });
  delete f.options.publish;
  let sends = 0;
  Object.assign(f.connection, {
    getLatestBlockhash: async () => ({
      blockhash: keys[7],
      lastValidBlockHeight: 100,
    }),
    simulateTransaction: async () => {
      now += 31_000;
      return { value: { err: null } };
    },
    sendRawTransaction: async () => {
      sends++;
      return "bad";
    },
  });
  await assert.rejects((await createOracleWorker(f.options)).tick(), /expired/);
  assert.equal(sends, 0);
});

test("wrong owner, binding and inactive accounts block the worker before fetching prices", async () => {
  for (const change of [
    (f) => {
      f.oracle[10] = 0;
    },
    (f) => {
      Keypair.generate().publicKey.toBuffer().copy(f.oracle, 48);
    },
    (f) => {
      f.connection.getAccountInfo = async () => ({
        owner: authority.publicKey,
        data: f.oracle,
      });
    },
    (f) => {
      f.instrument[1] = 99;
    },
  ]) {
    const f = fixture();
    change(f);
    let fetches = 0;
    f.options.customFetch = async () => {
      fetches++;
      throw Error("must not fetch");
    };
    await assert.rejects(createOracleWorker(f.options));
    assert.equal(fetches, 0);
    assert.equal(f.published.length, 0);
  }
});
