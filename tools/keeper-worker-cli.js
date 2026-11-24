#!/usr/bin/env node
"use strict";
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const { Connection, Keypair } = require("@solana/web3.js");
const { loadManifest } = require("../mgk-frontend/packages/layout/manifest");
const {
  createKeeperWorker,
  INTERVAL_MS,
  CLOSE_DEFAULT_PER_TICK,
  CLOSE_MAX_PER_TICK,
} = require("./keeper-worker");
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
// Rent reclamation knobs. Without KEEPER_INDEXER_URL the keeper closes nothing.
function closeConfigFromEnv(env, cluster) {
  const flag = env.KEEPER_CLOSE_ENABLED ?? "";
  const closeEnabled = { "": true, true: true, 1: true, false: false, 0: false }[flag];
  if (closeEnabled === undefined) throw Error("Invalid KEEPER_CLOSE_ENABLED");
  const cap = env.KEEPER_CLOSE_MAX_PER_TICK ?? "";
  const closeMaxPerTick = cap === "" ? CLOSE_DEFAULT_PER_TICK : Number(cap);
  if (
    !/^\d*$/.test(cap) ||
    !Number.isInteger(closeMaxPerTick) ||
    closeMaxPerTick < 1 ||
    closeMaxPerTick > CLOSE_MAX_PER_TICK
  )
    throw Error("Invalid KEEPER_CLOSE_MAX_PER_TICK");
  let indexerUrl = null;
  if (env.KEEPER_INDEXER_URL) {
    const url = new URL(env.KEEPER_INDEXER_URL);
    if (cluster === "devnet" && url.protocol !== "https:")
      throw Error("Devnet indexer requires HTTPS");
    if (cluster === "localnet" && !LOOPBACK.includes(url.hostname))
      throw Error("Localnet indexer requires loopback");
    indexerUrl = url.toString().replace(/\/+$/, "");
  }
  return { closeEnabled, closeMaxPerTick, indexerUrl };
}
// The indexer's settled-through cursor. /api/status does chain reads, so it is
// cached; anything other than a decimal string becomes null (close nothing).
function createSettledThrough(
  indexerUrl,
  { fetchImpl = fetch, now = Date.now, cacheMs = 30_000, timeoutMs = 5_000 } = {},
) {
  let value = null,
    fetchedAt = -Infinity;
  return async () => {
    if (now() - fetchedAt < cacheMs) return value;
    fetchedAt = now();
    value = null;
    try {
      const response = await fetchImpl(`${indexerUrl}/api/status`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      const cursor = response.ok
        ? (await response.json())?.checks?.indexer?.settledThroughBatchId
        : null;
      if (typeof cursor === "string" && /^\d{1,20}$/.test(cursor)) value = BigInt(cursor);
    } catch {}
    return value;
  };
}
const { createHealthState, markCycle, markError, startHealthServer } = require("./health-server");
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
    "INTERVAL",
    "MAX_CONSECUTIVE_ERRORS",
    "DEPLOYER_KEYPAIR",
  ])
    if (process.env[key]) throw Error("Remove legacy keeper overrides");
  const keyPath = process.env.KEEPER_KEYPAIR || process.env.KEEPER_KEYPAIR_FILE;
  if (!keyPath || !process.env.RPC_URL)
    throw Error("Explicit keeper keypair and RPC required");
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
    !LOOPBACK.includes(rpc.hostname)
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
    monitoring.feePayers?.keeper &&
    monitoring.feePayers.keeper !== payer.publicKey.toBase58()
  )
    throw Error("Monitoring payer mismatch");
  const close = closeConfigFromEnv(process.env, validated.cluster);
  const worker = await createKeeperWorker({
    closeEnabled: close.closeEnabled,
    closeMaxPerTick: close.closeMaxPerTick,
    settledThrough: close.indexerUrl ? createSettledThrough(close.indexerUrl) : null,
    manifest,
    payer,
    connection: new Connection(process.env.RPC_URL, "confirmed"),
    feeFloorLamports: BigInt(monitoring.feeFloorLamports),
  });
  const health = createHealthState("keeper");
  const healthServer = process.argv.includes("--loop") && process.env.PORT
    ? startHealthServer(health)
    : null;
  const abort = new AbortController();
  process.once("SIGTERM", () => abort.abort());
  process.once("SIGINT", () => abort.abort());
  try {
    do {
      const started = Date.now();
      let waitMs = INTERVAL_MS;
      try {
        const result = await worker.tick();
        markCycle(health, result.status);
        // A collecting batch tells the loop how long until its deadline.
        if (Number.isSafeInteger(result.waitMs) && result.waitMs > INTERVAL_MS)
          waitMs = result.waitMs;
        console.log(
          JSON.stringify({
            ...result,
            service: "keeper",
            batchId: result.batchId?.toString(),
          }),
        );
        if (result.status === "halted") {
          process.exitCode = 1;
          break;
        }
        if (
          process.argv.includes("--once") &&
          ["retry", "backoff", "low_fee_sol"].includes(result.status)
        )
          process.exitCode = 1;
      } catch {
        markError(health);
        console.error(
          JSON.stringify({
            service: "keeper",
            severity: "critical",
            code: "cycle_failed",
            status: "cycle_failed",
            action: "Check RPC availability and manifest account bindings",
          }),
        );
        if (process.argv.includes("--once")) process.exitCode = 1;
      }
      if (process.argv.includes("--once") || abort.signal.aborted) break;
      await sleep(Math.max(0, waitMs - (Date.now() - started)), undefined, {
        signal: abort.signal,
      }).catch(() => {});
    } while (!abort.signal.aborted);
  } finally {
    healthServer?.close();
  }
}
function fatal() {
  console.error(
    JSON.stringify({
      service: "keeper",
      severity: "critical",
      code: "startup_validation_failed",
      status: "startup_validation_failed",
      action:
        "Verify manifest, monitoring config, RPC and explicit keeper keypair; remove legacy overrides",
    }),
  );
  process.exitCode = 1;
}
module.exports = { main, fatal, closeConfigFromEnv, createSettledThrough };
if (require.main === module) main().catch(fatal);
