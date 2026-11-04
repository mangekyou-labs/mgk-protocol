"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");

// Exercise the real CLI loop with inert boundaries: no signer files or RPC calls.
async function runCli(service, { port, mode = "--loop", status = "idle", signal = true } = {}) {
  const process = new EventEmitter();
  process.argv = ["node", `${service}-worker-cli.js`, mode];
  process.env = {
    RPC_URL: "http://127.0.0.1:8899",
    [`${service === "oracle" ? "ORACLE_AUTHORITY" : service.toUpperCase()}_KEYPAIR`]: "inert-key",
    ...(port === undefined ? {} : { PORT: port }),
  };
  const calls = { started: 0, closed: 0, ticks: 0 };
  const worker = { tick: async () => {
    calls.ticks++;
    if (signal) process.emit("SIGTERM");
    return { status };
  } };
  const health = require("./health-server");
  const module = { exports: {} };
  const dependencies = {
    "node:fs": { readFileSync: (path) => path === "inert-key" ? "[]" : '{"feeFloorLamports":"0"}' },
    "node:path": require("node:path"),
    "node:timers/promises": { setTimeout: async () => {} },
    "@solana/web3.js": { Connection: class {}, Keypair: { fromSecretKey: () => ({}) } },
    "../mgk-frontend/packages/layout/manifest": { loadManifest: () => ({ ready: true, cluster: "localnet" }) },
    [`./${service}-worker`]: { [`create${service[0].toUpperCase()}${service.slice(1)}Worker`]: async () => worker, INTERVAL_MS: 1 },
    "./health-server": { ...health, startHealthServer: () => {
      calls.started++;
      return { close: () => { calls.closed++; } };
    } },
  };
  vm.runInNewContext(readFileSync(`${__dirname}/${service}-worker-cli.js`, "utf8"), {
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency ${name}`);
      return dependencies[name];
    },
    module, __dirname, process, URL, AbortController, console: { log() {}, error() {} },
  });
  await module.exports.main();
  assert.equal(calls.ticks, 1);
  return calls;
}

for (const service of ["oracle", "keeper", "maker"]) {
  test(`${service}: local loop without PORT leaves HTTP hosting disabled`, async () => {
    assert.equal((await runCli(service)).started, 0);
  });
  test(`${service}: hosted loop closes its health server when signaled`, async () => {
    assert.deepEqual(await runCli(service, { port: "0" }), { started: 1, closed: 1, ticks: 1 });
  });
  test(`${service}: one-shot does not host health even with PORT`, async () => {
    assert.equal((await runCli(service, { port: "0", mode: "--once" })).started, 0);
  });
}

for (const service of ["keeper", "maker"]) {
  test(`${service}: halted worker closes hosted health without a shutdown signal`, async () => {
    assert.deepEqual(await runCli(service, { port: "0", status: "halted", signal: false }), { started: 1, closed: 1, ticks: 1 });
  });
}
