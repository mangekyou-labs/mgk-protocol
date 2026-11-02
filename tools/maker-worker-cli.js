#!/usr/bin/env node
"use strict";
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const { Connection, Keypair } = require("@solana/web3.js");
const { loadManifest } = require("../mgk-frontend/packages/layout/manifest");
const { createMakerWorker, INTERVAL_MS } = require("./maker-worker");
async function main() {
  if (process.argv.slice(2).some((arg) => !["--once", "--loop"].includes(arg)))
    throw Error("Unsupported argument");
  for (const key of [
    "BATCH_ADDRESS",
    "CURRENT_BATCH_PDA",
    "BOOK_ADDRESS",
    "BOOK_KEYPAIR",
    "NEXT_PUBLIC_BOOK_ADDRESS",
    "PORTFOLIO_ADDRESSES",
    "ADMIN_KEYPAIR",
    "ORACLE_KEYPAIR",
    "KEEPER_KEYPAIR",
    "ORDER_ROLE",
    "IS_MAKER",
    "INTERVAL",
    "MAX_CONSECUTIVE_ERRORS",
    "DEPLOYER_KEYPAIR",
  ])
    if (process.env[key]) throw Error("Remove legacy maker overrides");
  const keyPath = process.env.MAKER_KEYPAIR || process.env.MAKER_KEYPAIR_FILE;
  if (!keyPath || !process.env.RPC_URL)
    throw Error("Explicit maker keypair and RPC required");
  const manifest = JSON.parse(
    readFileSync(
      process.env.DEPLOYMENT_MANIFEST ||
        resolve(__dirname, "../deployments/devnet.json"),
      "utf8",
    ),
  );
  const validated = loadManifest(manifest),
    rpc = new URL(process.env.RPC_URL);
  if (!validated.ready) throw Error("Manifest pending");
  if (
    validated.cluster === "localnet" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(rpc.hostname)
  )
    throw Error("Localnet requires loopback");
  if (validated.cluster === "devnet" && rpc.protocol !== "https:")
    throw Error("Devnet requires HTTPS");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))),
  );
  const monitoring = JSON.parse(
    readFileSync(
      process.env.MONITORING_CONFIG ||
        resolve(__dirname, "../deployments/monitoring.json"),
      "utf8",
    ),
  );
  if (
    typeof monitoring.feeFloorLamports !== "string" ||
    !/^\d+$/.test(monitoring.feeFloorLamports)
  )
    throw Error("Invalid fee floor");
  if (
    monitoring.feePayers?.maker &&
    monitoring.feePayers.maker !== payer.publicKey.toBase58()
  )
    throw Error("Monitoring payer mismatch");
  const worker = await createMakerWorker({
    manifest,
    payer,
    connection: new Connection(process.env.RPC_URL, "confirmed"),
    feeFloorLamports: BigInt(monitoring.feeFloorLamports),
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
          ...result,
          service: "maker",
          batchId: result.batchId?.toString(),
        }),
      );
      if (result.status === "halted") {
        process.exitCode = 1;
        break;
      }
      if (
        process.argv.includes("--once") &&
        ["retry", "backoff", "low_fee_sol", "invalid_price", "blocked"].includes(result.status)
      )
        process.exitCode = 1;
    } catch {
      console.error(
        JSON.stringify({
          service: "maker",
          severity: "critical",
          code: "cycle_failed",
          status: "cycle_failed",
          action: "Check RPC availability and manifest account bindings",
        }),
      );
      if (process.argv.includes("--once")) process.exitCode = 1;
    }
    if (process.argv.includes("--once") || abort.signal.aborted) break;
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - started)), undefined, {
      signal: abort.signal,
    }).catch(() => {});
  } while (!abort.signal.aborted);
}
function fatal() {
  console.error(
    JSON.stringify({
      service: "maker",
      severity: "critical",
      code: "startup_validation_failed",
      status: "startup_validation_failed",
      action:
        "Verify manifest, monitoring config, RPC and explicit maker keypair; remove legacy overrides",
    }),
  );
  process.exitCode = 1;
}
module.exports = { main, fatal };
if (require.main === module) main().catch(fatal);
