"use strict";
// Test-only preload: intercept external venue HTTP, leaving validator RPC untouched.
const { readFileSync } = require("node:fs");
const { SOL_USD_FEED } = require("../oracle-worker");
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  if (!/hermes|coinbase|kraken/.test(String(url)))
    return originalFetch(url, options);
  const mode = JSON.parse(
    readFileSync(process.env.MGK_ORACLE_FIXTURE, "utf8"),
  ).mode;
  if (mode === "no_quorum") return { ok: false, status: 503 };
  const timestamp = Date.now();
  const body = String(url).includes("hermes")
    ? {
        parsed: [
          {
            id: SOL_USD_FEED,
            price: {
              price: "1000000",
              conf: "12",
              expo: -6,
              publish_time: Math.floor(timestamp / 1000),
            },
          },
        ],
      }
    : String(url).includes("coinbase")
      ? { price: "1.000000", time: new Date(timestamp).toISOString() }
      : {
          error: [],
          result: {
            SOLUSD: [["1.000000", "1", timestamp / 1000, "b", "m", ""]],
            last: "0",
          },
        };
  return { ok: true, json: async () => body };
};
