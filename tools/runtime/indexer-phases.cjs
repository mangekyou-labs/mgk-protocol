'use strict';
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

// A clock file controls only the monitoring process. Validator history and all
// protocol accounts still come from the signed candidate lifecycle.
async function verifyIndexerPhase(runtime, { programs, accounts, startSlot, phase, anchorTime }) {
  const directory = mkdtempSync(join(tmpdir(), 'mgk-indexer-phase-'));
  const clock = join(directory, 'clock');
  const preload = join(directory, 'clock.cjs');
  const manifest = join(directory, 'manifest.json');
  const monitoring = join(directory, 'monitoring.json');
  writeFileSync(preload, "const fs = require('node:fs'); Date.now = () => Number(fs.readFileSync(process.env.MGK_TEST_CLOCK, 'utf8'));\n");
  writeFileSync(clock, String(anchorTime * 1000));
  writeFileSync(manifest, JSON.stringify({ schema_version: 1, name: 'candidate-phase-monitor', cluster: 'localnet', programs,
    accounts: Object.fromEntries(Object.entries(accounts).map(([name, address]) => [name, { status: 'deployed', address: String(address) }])),
    start_slot: { status: 'set', slot: startSlot } }));
  writeFileSync(monitoring, JSON.stringify({ feePayers: { keeper: String(accounts.maker), oracle: String(accounts.maker), maker: String(accounts.maker) },
    feeFloorLamports: '10000000', insuranceFloorLamports: '1000000000' }));
  const port = Number(process.env.MGK_INDEXER_PHASE_PORT ?? 19431);
  let child, output = '';
  try {
    child = await runtime.launchWorker(process.execPath, ['--require', preload, resolve(__dirname, '../../mgk-frontend/apps/indexer/dist/main.js')], {
      env: { DEPLOYMENT_MANIFEST: manifest, MONITORING_CONFIG: monitoring, MGK_TEST_CLOCK: clock,
        DB_PATH: join(directory, 'history.db'), HOST: '127.0.0.1', PORT: String(port), LOG_LEVEL: 'error' } });
    child.stdout.on('data', data => { output = (output + data).slice(-8000); });
    child.stderr.on('data', data => { output = (output + data).slice(-8000); });
    const threshold = phase === 0 ? 30 : 120;
    for (const age of [threshold, threshold + 1]) {
      writeFileSync(clock, String((anchorTime + age) * 1000));
      const deadline = Date.now() + 15000;
      let status;
      while (true) {
        assert.equal(child.exitCode, null, output);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(5000) });
          assert.equal(response.status, 200);
          status = await response.json();
          break;
        } catch (error) { if (Date.now() > deadline) throw new Error(output, {cause:error}); await sleep(100); }
      }
      assert.equal(status.checks.batch.phase, phase, JSON.stringify(status.checks.batch));
      assert.equal(status.checks.batch.ageSeconds, age);
      assert.equal(status.checks.batch.severity, age === threshold ? 'ok' : phase === 0 ? 'warn' : 'critical');
    }
    runtime.report.indexerPhaseThresholds ??= [];
    runtime.report.indexerPhaseThresholds.push({phase, thresholdSeconds: threshold, boundary: 'pass'});
    runtime.flushReport();
  } finally {
    if (child && child.exitCode === null && !child.signalCode) {
      const exited = once(child, 'close');
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timeout);
    }
    rmSync(directory, {recursive:true, force:true});
  }
}
module.exports = {verifyIndexerPhase};
