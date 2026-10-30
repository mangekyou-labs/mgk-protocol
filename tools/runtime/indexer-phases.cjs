'use strict';
const assert = require('node:assert/strict');
const { writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { createIndexerService } = require('./indexer-service.cjs');

// A clock file controls only the monitoring process. Validator history and all
// protocol accounts still come from the signed candidate lifecycle.
async function verifyIndexerPhase(runtime, { programs, accounts, startSlot, phase, anchorTime }) {
  const port = Number(process.env.MGK_INDEXER_PHASE_PORT ?? 19431);
  const service = createIndexerService(runtime, {programs, accounts, startSlot,
    name: 'candidate-phase-monitor', prefix: 'mgk-indexer-phase-', port, logLevel: 'error'});
  const {directory} = service;
  const clock = join(directory, 'clock');
  const preload = join(directory, 'clock.cjs');
  writeFileSync(preload, "const fs = require('node:fs'); Date.now = () => Number(fs.readFileSync(process.env.MGK_TEST_CLOCK, 'utf8'));\n");
  writeFileSync(clock, String(anchorTime * 1000));
  try {
    await service.launch({args: ['--require', preload], env: {MGK_TEST_CLOCK: clock}});
    const threshold = phase === 0 ? 30 : 120;
    for (const age of [threshold, threshold + 1]) {
      writeFileSync(clock, String((anchorTime + age) * 1000));
      const deadline = Date.now() + 15000;
      let status;
      while (true) {
        assert.equal(service.child.exitCode, null, service.output);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(5000) });
          assert.equal(response.status, 200);
          status = await response.json();
          break;
        } catch (error) { if (Date.now() > deadline) throw new Error(service.output, {cause:error}); await sleep(100); }
      }
      assert.equal(status.checks.batch.phase, phase, JSON.stringify(status.checks.batch));
      assert.equal(status.checks.batch.ageSeconds, age);
      assert.equal(status.checks.batch.severity, age === threshold ? 'ok' : phase === 0 ? 'warn' : 'critical');
    }
    runtime.report.indexerPhaseThresholds ??= [];
    runtime.report.indexerPhaseThresholds.push({phase, thresholdSeconds: threshold, boundary: 'pass'});
    runtime.flushReport();
  } finally {
    await service.stop();
    rmSync(directory, {recursive:true, force:true});
  }
}
module.exports = {verifyIndexerPhase};
