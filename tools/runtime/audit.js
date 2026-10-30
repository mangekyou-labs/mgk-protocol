#!/usr/bin/env node
'use strict';
// End-of-run invariant audit. Read-only: every RPC call goes through the
// invariant reader's allowlist of get* methods, and no keypair is ever loaded.
//
//   node tools/runtime/audit.js [--rpc URL] [--deployment deployments/devnet.json]
//
// Prints a JSON report and exits 1 when any invariant fails, 2 on usage or RPC errors.
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { audit, readOnly } = require('./invariants');

const DEVNET = 'https://api.devnet.solana.com';

function parseArgs(argv) {
  const options = { rpc: process.env.RPC_URL || DEVNET, deployment: resolve(__dirname, '../../deployments/devnet.json') };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`${flag}: missing value`);
    if (flag === '--rpc') options.rpc = value;
    else if (flag === '--deployment') options.deployment = resolve(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  return options;
}

function httpRpc(url) {
  return async (method, params = []) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`${method}: RPC HTTP ${response.status}`);
    const result = await response.json();
    if (result.error) throw new Error(`${method}: ${JSON.stringify(result.error)}`);
    return result.result;
  };
}

async function main(argv) {
  const options = parseArgs(argv);
  const { programs } = JSON.parse(readFileSync(options.deployment, 'utf8'));
  const report = await audit(readOnly(httpRpc(options.rpc)), { core: programs.perps_core, matcher: programs.perps_matcher });
  return { rpcUrl: options.rpc, deployment: options.deployment, ...report };
}

if (require.main === module) {
  main(process.argv.slice(2)).then(report => {
    process.stdout.write(JSON.stringify(report, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
    process.exitCode = report.violations.length ? 1 : 0;
  }, error => { process.stderr.write(`audit failed: ${error.message}\n`); process.exitCode = 2; });
}

module.exports = { main, parseArgs };
