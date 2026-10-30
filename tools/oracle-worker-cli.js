#!/usr/bin/env node
"use strict";
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const { Connection, Keypair } = require("@solana/web3.js");
const { loadManifest } = require("../mgk-frontend/packages/layout/manifest");
const { createOracleWorker, INTERVAL_MS } = require("./oracle-worker");

async function main() {
  const keyPath =
    process.env.ORACLE_AUTHORITY_KEYPAIR ||
    process.env.ORACLE_AUTHORITY_KEYPAIR_FILE;
  if (!keyPath)
    throw new Error(
      "ORACLE_AUTHORITY_KEYPAIR must explicitly name the oracle authority file",
    );
  if (!process.env.RPC_URL) throw new Error("RPC_URL is required");
  for (const key of [
    "PRICE_ORACLE_ADDRESS",
    "INSTRUMENT_ADDRESS",
    "ORACLE_PROGRAM_ID",
    "QUORUM_VENUES",
    "MAX_DEVIATION_BPS",
    "MAX_FRESHNESS_SEC",
    "ORACLE_LOOP_INTERVAL",
  ]) {
    if (process.env[key])
      throw new Error(
        "Legacy oracle overrides must be removed; use deployment manifest and fixed quorum policy",
      );
  }
  const manifest = JSON.parse(
    readFileSync(
      process.env.DEPLOYMENT_MANIFEST ||
        resolve(__dirname, "../deployments/devnet.json"),
      "utf8",
    ),
  );
  const validated = loadManifest(manifest);
  if (!validated.ready)
    throw new Error("Deployment manifest has pending accounts or start slot");
  const rpc = new URL(process.env.RPC_URL);
  if (
    validated.cluster === "localnet" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(rpc.hostname)
  )
    throw new Error("Localnet requires loopback RPC");
  if (validated.cluster === "devnet" && rpc.protocol !== "https:")
    throw new Error("Devnet requires HTTPS RPC");
  const authority = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))),
  );
  const connection = new Connection(process.env.RPC_URL, "confirmed");
  const worker = await createOracleWorker({
    manifest,
    authority,
    connection,
    hermesUrl: process.env.PYTH_HERMES_URL,
    pythApiKey: process.env.PYTH_API_KEY,
  });
  const abort = new AbortController();
  process.once("SIGTERM", () => abort.abort());
  process.once("SIGINT", () => abort.abort());
  do {
    const started = Date.now();
    try {
      const result = await worker.tick();
      console.log(
        JSON.stringify({
          service: "oracle",
          status: result.status,
          signature: result.signature,
          venues: result.venues,
          unavailableVenues: result.unavailableVenues,
          price: result.price?.toString(),
          confidence: result.confidence?.toString(),
        }),
      );
    } catch {
      // RPC/fetch exceptions can contain credentials and URLs; never log the raw exception.
      console.error(
        JSON.stringify({ service: "oracle", status: "publication_failed" }),
      );
      if (process.argv.includes("--once")) process.exitCode = 1;
    }
    if (process.argv.includes("--once") || abort.signal.aborted) break;
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - started)), undefined, {
      signal: abort.signal,
    }).catch(() => {});
  } while (!abort.signal.aborted);
}
function fatal(error) {
  const safe =
    /^(ORACLE_AUTHORITY_KEYPAIR|RPC_URL is required|Deployment manifest|Legacy oracle overrides|Localnet requires|Devnet requires|Oracle authority mismatch|Oracle\/instrument binding mismatch|Inactive oracle|RPC cluster differs)/;
  console.error(
    safe.test(error.message)
      ? error.message
      : "Oracle startup validation failed",
  );
  process.exitCode = 1;
}
module.exports = { main, fatal };
if (require.main === module) main().catch(fatal);
