'use strict';
const { once } = require('node:events');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

// Shared process plumbing; each scenario owns its clock, assertions and cleanup.
function createIndexerService(runtime, { programs, accounts, startSlot, name, prefix, port, logLevel = 'warn' }) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const manifestPath = join(directory, 'deployment.json');
  const monitoringPath = join(directory, 'monitoring.json');
  const dbPath = join(directory, 'history.db');
  writeFileSync(manifestPath, JSON.stringify({ schema_version: 1, name, cluster: 'localnet', programs,
    accounts: Object.fromEntries(Object.entries(accounts).map(([name, address]) => [name, { status: 'deployed', address: String(address) }])),
    start_slot: { status: 'set', slot: startSlot } }));
  writeFileSync(monitoringPath, JSON.stringify({
    feePayers: { keeper: String(accounts.maker), oracle: String(accounts.maker), maker: String(accounts.maker) },
    feeFloorLamports: '10000000', insuranceFloorLamports: '1000000000',
  }));
  let child, output = '';
  return {
    directory, dbPath,
    get child() { return child; },
    get output() { return output; },
    async launch({args = [], env = {}} = {}) {
      output = '';
      child = await runtime.launchWorker(process.execPath,
        [...args, resolve(__dirname, '../../mgk-frontend/apps/indexer/dist/main.js')], {
          env: { DEPLOYMENT_MANIFEST: manifestPath, MONITORING_CONFIG: monitoringPath,
            DB_PATH: dbPath, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: logLevel, ...env },
        });
      const capture = chunk => { output = (output + chunk).slice(-8000); };
      child.stdout.on('data', capture); child.stderr.on('data', capture);
    },
    async stop() {
      if (!child || child.exitCode !== null || child.signalCode) return;
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await closed; } finally { clearTimeout(timer); }
    },
  };
}
module.exports = { createIndexerService };
