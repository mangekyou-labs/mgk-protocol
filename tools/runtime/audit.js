#!/usr/bin/env node
'use strict';
// End-of-run invariant audit. Read-only: every RPC call goes through the
// invariant reader's allowlist of get* methods, and no keypair is ever loaded.
//
//   node tools/runtime/audit.js [--rpc URL] [--deployment deployments/devnet.json | candidate-manifest.json]
//
// Prints a JSON report and exits 1 when any invariant fails, 2 on usage or RPC errors.
//
// Scenario drivers import it instead of spawning the CLI:
//   const { auditScenario } = require('tools/runtime/audit');
//   await auditScenario('liquidation cascade', { rpcUrl, deployment: manifestPath });
// which throws InvariantViolation ('invariant "X" violated after scenario "..."').
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { audit, readOnly, programsFrom, InvariantViolation } = require('./invariants');
const { jsonRpc } = require('./rpc');

const DEVNET = 'https://api.devnet.solana.com';
const DEFAULT_DEPLOYMENT = resolve(__dirname, '../../deployments/devnet.json');

function parseArgs(argv) {
  const options = { rpc: process.env.RPC_URL || DEVNET, deployment: DEFAULT_DEPLOYMENT };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`${flag}: missing value`);
    if (flag === '--rpc') options.rpc = value;
    else if (flag === '--deployment') options.deployment = resolve(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  return options;
}

// Audit one deployment. Give `rpc` (a JSON-RPC function) or `rpcUrl`, and
// `programs` ({ core, matcher }) or `deployment` (a deployment file or candidate manifest path).
async function auditDeployment({ rpc, rpcUrl, programs, deployment = DEFAULT_DEPLOYMENT }) {
  const transport = rpc ?? jsonRpc(rpcUrl);
  const resolved = programs ?? programsFrom(JSON.parse(readFileSync(deployment, 'utf8')));
  return audit(readOnly(transport), resolved);
}

async function auditScenario(scenario, options) {
  const report = await auditDeployment(options);
  if (report.violations.length) throw new InvariantViolation(report.violations, { scenario });
  return report;
}

async function main(argv) {
  const options = parseArgs(argv);
  const report = await auditDeployment({ rpcUrl: options.rpc, deployment: options.deployment });
  return { rpcUrl: options.rpc, deployment: options.deployment, ...report };
}

if (require.main === module) {
  main(process.argv.slice(2)).then(report => {
    process.stdout.write(JSON.stringify(report, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
    process.exitCode = report.violations.length ? 1 : 0;
  }, error => { process.stderr.write(`audit failed: ${error.message}\n`); process.exitCode = 2; });
}

module.exports = { main, parseArgs, auditDeployment, auditScenario };
