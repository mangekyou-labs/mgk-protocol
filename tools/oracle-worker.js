"use strict";
const {
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} = require("@solana/web3.js");
const { decodeAccount } = require("../mgk-frontend/packages/layout");
const {
  encodeInstruction,
} = require("../mgk-frontend/packages/layout/instructions");
const { loadManifest } = require("../mgk-frontend/packages/layout/manifest");
const {
  confirmSignature,
} = require("../mgk-frontend/packages/layout/confirmation");
const { publishedConfidence } = require("./oracle-sources");

const SOL_USD_FEED =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const SOURCES = {
  pyth: `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${SOL_USD_FEED}`,
  coinbase: "https://api.exchange.coinbase.com/products/SOL-USD/ticker",
  kraken: "https://api.kraken.com/0/public/Trades?pair=SOLUSD&count=1",
};
const MAX_AGE_MS = 30_000;
const INTERVAL_MS = 10_000;
const I64_MAX = (1n << 63n) - 1n;

// Parse decimal prices exactly; confidence rounds up and price rounds down to micro-USD.
function scaled(raw, exponent = 0, roundUp = false) {
  if (typeof raw !== "string" || !/^\d+(\.\d+)?$/.test(raw))
    throw new Error("Invalid numeric quote");
  const [whole, fraction = ""] = raw.split(".");
  const power = exponent + 6 - fraction.length;
  if (!Number.isSafeInteger(power) || Math.abs(power) > 30)
    throw new Error("Invalid exponent");
  const integer = BigInt(whole + fraction);
  const divisor = power < 0 ? 10n ** BigInt(-power) : 1n;
  const value =
    power < 0
      ? (integer + (roundUp ? divisor - 1n : 0n)) / divisor
      : integer * 10n ** BigInt(power);
  if (value > I64_MAX) throw new Error("Quote exceeds i64");
  return value;
}
async function observation(venue, customFetch, now, hermesUrl, pythApiKey) {
  const url =
    venue === "pyth"
      ? `${hermesUrl}/v2/updates/price/latest?ids[]=${SOL_USD_FEED}`
      : SOURCES[venue];
  const response = await customFetch(url, {
    signal: AbortSignal.timeout(3000),
    cache: "no-store",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
      ...(venue === "pyth" && pythApiKey
        ? { Authorization: `Bearer ${pythApiKey}` }
        : {}),
    },
  });
  if (!response.ok) throw new Error("Source HTTP failure");
  const body = await response.json();
  let price,
    confidence = 0n,
    timestamp;
  if (venue === "pyth") {
    const feed = body.parsed?.find((item) => item.id === SOL_USD_FEED);
    if (
      !feed ||
      !Number.isSafeInteger(feed.price?.expo) ||
      !Number.isSafeInteger(feed.price.publish_time)
    )
      throw new Error("Invalid Pyth feed");
    price = scaled(feed.price.price, feed.price.expo);
    confidence = scaled(feed.price.conf, feed.price.expo, true);
    timestamp = feed.price.publish_time * 1000;
  } else if (venue === "coinbase") {
    price = scaled(body.price);
    timestamp = Date.parse(body.time);
  } else {
    if (
      !Array.isArray(body.error) ||
      body.error.length ||
      !Array.isArray(body.result?.SOLUSD) ||
      body.result.SOLUSD.length !== 1
    )
      throw new Error("Invalid Kraken trades");
    const trade = body.result.SOLUSD[0];
    price = scaled(trade[0]);
    timestamp = typeof trade[2] === "number" ? trade[2] * 1000 : NaN;
  }
  if (
    price <= 0n ||
    !Number.isFinite(timestamp) ||
    timestamp > now() ||
    now() - timestamp > MAX_AGE_MS
  )
    throw new Error("Invalid or stale source");
  return { venue, price, confidence, timestamp };
}
function quorum(samples) {
  const sorted = [...samples].sort((a, b) =>
    a.price < b.price ? -1 : a.price > b.price ? 1 : 0,
  );
  const agrees = (group) =>
    (group.at(-1).price - group[0].price) * 10000n <= group[0].price * 50n;
  if (sorted.length < 2) return null;
  let accepted = sorted;
  if (!agrees(sorted)) {
    const pairs = sorted
      .slice(1)
      .map((_, i) => sorted.slice(i, i + 2))
      .filter(agrees);
    if (pairs.length !== 1) return null; // Ambiguous clusters cannot select an honest price.
    accepted = pairs[0];
  }
  const price =
    accepted.length === 3
      ? accepted[1].price
      : (accepted[0].price + accepted[1].price) / 2n;
  return {
    price,
    confidence: publishedConfidence(
      samples.map((s) => s.price),
      price,
      samples.map((s) => s.confidence),
    ),
    venues: accepted.map((s) => s.venue),
    samples,
  };
}
async function createOracleWorker({
  manifest: rawManifest,
  authority,
  connection,
  customFetch = fetch,
  now = Date.now,
  publish,
  hermesUrl = "https://hermes.pyth.network",
  pythApiKey,
}) {
  const endpoint = new URL(hermesUrl);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("Hermes URL must be HTTPS without credentials or query");
  hermesUrl = hermesUrl.replace(/\/$/, "");
  const manifest = loadManifest(rawManifest);
  if (!manifest.ready)
    throw new Error("Deployment manifest has pending accounts or start slot");
  if (!authority?.publicKey)
    throw new Error("Explicit oracle authority required");
  if (!["devnet", "localnet"].includes(manifest.cluster))
    throw new Error("Oracle worker supports devnet/localnet only");
  if (
    manifest.cluster === "devnet" &&
    (await connection.getGenesisHash()) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
  )
    throw new Error("RPC cluster differs from manifest");
  const oracleKey = new PublicKey(manifest.accounts.oracle);
  const instrumentKey = new PublicKey(manifest.accounts.instrument);
  async function validateAccounts() {
    const [oracleAccount, instrumentAccount] = await Promise.all([
      connection.getAccountInfo(oracleKey, "confirmed"),
      connection.getAccountInfo(instrumentKey, "confirmed"),
    ]);
    if (
      !oracleAccount ||
      !oracleAccount.owner.equals(new PublicKey(manifest.programs.oracle))
    )
      throw new Error("Invalid oracle owner or missing oracle");
    if (
      !instrumentAccount ||
      !instrumentAccount.owner.equals(
        new PublicKey(manifest.programs.perps_core),
      )
    )
      throw new Error("Invalid instrument owner or missing instrument");
    const oracle = decodeAccount("PriceOracle", oracleAccount.data);
    const instrument = decodeAccount("Instrument", instrumentAccount.data);
    if (!new PublicKey(oracle.authority).equals(authority.publicKey))
      throw new Error("Oracle authority mismatch");
    if (
      !new PublicKey(oracle.instrument).equals(instrumentKey) ||
      !new PublicKey(instrument.oracleAddr).equals(oracleKey)
    )
      throw new Error("Oracle/instrument binding mismatch");
    if (!oracle.isActive || !instrument.isActive)
      throw new Error("Inactive oracle or instrument");
  }
  await validateAccounts();
  const send =
    publish ??
    (async (result) => {
      const latest = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({
        feePayer: authority.publicKey,
        ...latest,
      }).add(
        new TransactionInstruction({
          programId: new PublicKey(manifest.programs.oracle),
          keys: [
            { pubkey: oracleKey, isSigner: false, isWritable: true },
            { pubkey: authority.publicKey, isSigner: true, isWritable: false },
          ],
          data: Buffer.from(
            encodeInstruction("oracle", "UpdatePrice", {
              price: result.price,
              confidence: result.confidence,
            }),
          ),
        }),
      );
      tx.sign(authority);
      const simulation = await connection.simulateTransaction(
        VersionedTransaction.deserialize(tx.serialize()),
        { commitment: "confirmed", sigVerify: true },
      );
      if (simulation.value.err)
        throw new Error("Oracle update simulation failed");
      // A delayed blockhash/simulation must never turn an old observation into a fresh on-chain quote.
      await validateAccounts();
      if (
        result.samples.some(
          (s) => now() - s.timestamp > MAX_AGE_MS || s.timestamp > now(),
        )
      )
        throw new Error("Source expired before publication");
      const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 0,
      });
      await confirmSignature(connection, signature, {
        lastValidBlockHeight: latest.lastValidBlockHeight,
      });
      return signature;
    });
  const tick = async () => {
    await validateAccounts();
    const results = await Promise.allSettled(
      Object.keys(SOURCES).map((venue) =>
        observation(venue, customFetch, now, hermesUrl, pythApiKey),
      ),
    );
    const samples = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((s) => s.timestamp <= now() && now() - s.timestamp <= MAX_AGE_MS);
    const unavailableVenues = Object.keys(SOURCES).filter(
      (venue) => !samples.some((sample) => sample.venue === venue),
    );
    const result = quorum(samples);
    if (!result)
      return {
        status: "no_quorum",
        venues: samples.map((s) => s.venue),
        unavailableVenues,
      };
    const signature = await send(result);
    return { status: "published", signature, ...result, unavailableVenues };
  };
  return { tick };
}
module.exports = { createOracleWorker, SOL_USD_FEED, INTERVAL_MS };
