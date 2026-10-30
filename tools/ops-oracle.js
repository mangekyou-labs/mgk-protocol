#!/usr/bin/env node
"use strict";
const { PublicKey } = require("@solana/web3.js");
const { decodeAccount, layouts } = require("../mgk-frontend/packages/layout");
const PRICE_ORACLE_SIZE = layouts.PriceOracle.size;
const PRICE_ORACLE_DISCRIMINATOR = layouts.PriceOracle.discriminator;
const PRICE_ORACLE_LAYOUT_VERSION = layouts.PriceOracle.version;
const SECRET_KEYS = [
  "rpcUrl",
  "RPC_URL",
  "NEXT_PUBLIC_RPC_URL",
  "keypairPath",
  "keeperKeypair",
  "secretKey",
  "privateKey",
  "apiKey",
];

function decodePriceOracleAccount(buf) {
  const v = decodeAccount("PriceOracle", buf);
  return {
    ...v,
    discriminator: layouts.PriceOracle.discriminator,
    layoutVersion: layouts.PriceOracle.version,
    authority: new PublicKey(v.authority),
    instrument: new PublicKey(v.instrument),
  };
}

/** Warn at 3 consecutive post failures or 60s on-chain age; critical (and stop) at 10 / 600s. */
function evaluateOracleHealth(snapshot) {
  const s = snapshot || {};
  const consecutiveFailures = s.consecutiveFailures || 0;
  const onChainAgeSecs = s.onChainAgeSecs || 0;
  const alerts = [];

  if (consecutiveFailures >= 10) {
    alerts.push({
      metric: "oracle_post_failures",
      level: "critical",
      message: consecutiveFailures + " consecutive oracle post failures",
    });
  } else if (consecutiveFailures >= 3) {
    alerts.push({
      metric: "oracle_post_failures",
      level: "warning",
      message: consecutiveFailures + " consecutive oracle post failures",
    });
  }

  if (onChainAgeSecs >= 600) {
    alerts.push({
      metric: "oracle_staleness",
      level: "critical",
      message: "on-chain price age " + onChainAgeSecs + "s",
    });
  } else if (onChainAgeSecs >= 60) {
    alerts.push({
      metric: "oracle_staleness",
      level: "warning",
      message: "on-chain price age " + onChainAgeSecs + "s",
    });
  }

  let severity = "ok";
  for (const a of alerts) {
    if (a.level === "critical") severity = "critical";
    else if (a.level === "warning" && severity !== "critical")
      severity = "warning";
  }

  return {
    ok: severity !== "critical",
    severity,
    alerts,
    stopLoop: consecutiveFailures >= 10 || onChainAgeSecs >= 600,
  };
}

function sanitizeHealthPayload(payload) {
  const out = {};
  if (!payload || typeof payload !== "object") return out;
  for (const [k, v] of Object.entries(payload)) {
    if (SECRET_KEYS.includes(k)) continue;
    if (/rpcurl|api-key|apikey|keypair|secret/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

module.exports = {
  PRICE_ORACLE_SIZE,
  PRICE_ORACLE_DISCRIMINATOR,
  PRICE_ORACLE_LAYOUT_VERSION,
  decodePriceOracleAccount,
  evaluateOracleHealth,
  sanitizeHealthPayload,
};

if (require.main === module) {
  const { main, fatal } = require("./oracle-worker-cli");
  main().catch(fatal);
}
