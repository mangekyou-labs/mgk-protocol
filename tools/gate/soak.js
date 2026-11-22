#!/usr/bin/env node
'use strict';
// Soak driver for gate row P0-35 (issues #35/#11): poll the demo market for
// the run duration, then run the invariant audit exactly once at the end —
// even when polling already failed. A soak fails on a missing batch (an id
// skipped between polls), a batch stuck in Cleared longer than
// stuckClearedMs, any observe error, or any end-of-run audit violation.
//
// Unit tests inject now/sleep/observe/audit and run in fake time; the CLI
// wires observe/audit to the real chain (see observeDeployment):
//   node tools/gate/soak.js [--rpc URL] [--deployment deployments/devnet.json]
//                           [--duration-ms 7200000] [--poll-ms 5000]
//                           [--stuck-cleared-ms 120000] [--min-batches 700]
//                           [--max-requests 5000] [--allow-keyed-rpc]
// Defaults to the public devnet RPC and refuses a keyed URL (api-key=...)
// unless --allow-keyed-rpc is given. Every request is counted; polling stops
// at --max-requests and the audit has its own cap.
// Prints a JSON verdict; exits 0 pass, 1 fail, 2 on usage or RPC errors.
// The optional drive(pollIndex) hook runs on every poll so a caller can
// supply workload (ticket #40's devnet run drives maker/taker activity
// through it); the CLI itself only observes, so a bare CLI run needs
// externally driven activity to reach --min-batches.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { PublicKey } = require('@solana/web3.js');
const { layouts, decodeAccount } = require('../../mgk-frontend/packages/layout');
const { createMarketContext } = require('../market-context');
const { readOnly, programsFrom, u64, BATCH_STATUS } = require('../runtime/invariants');
const { auditDeployment } = require('../runtime/audit');
const { jsonRpc, createRequestBudget, isBudgetError, assertUnkeyedRpc, redactRpcUrl } = require('../runtime/rpc');

const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 5000;
const DEFAULT_STUCK_CLEARED_MS = 120000;
const DEVNET = 'https://api.devnet.solana.com';
const DEFAULT_DEPLOYMENT = resolve(__dirname, '../../deployments/devnet.json');
// Hard request caps. At the 5 s default poll a 2 h observe-only soak makes
// 2 requests x 1,440 polls; the audit needs two getProgramAccounts plus one
// getMultipleAccounts per 100 batches.
const DEFAULT_MAX_REQUESTS = 5000;
const AUDIT_MAX_REQUESTS = 1000;
const RPC_RETRIES = 3;

const STATUS_NAME = new Map([
  [BATCH_STATUS.settled, 'settled'],
  [BATCH_STATUS.cleared, 'cleared'],
]);

// Batch PDAs read per poll: the current batch and the ones before it. At
// the default 5 s poll this spans far more than one poll's worth of
// batches, so no id can slip between polls unread.
const DEFAULT_WINDOW = 10;

// One light observation of the deployment: two getMultipleAccounts calls,
// one for the registry and one for the last `window` batch PDAs. The full invariant read
// (getProgramAccounts over every portfolio and batch) runs only once, in the
// end-of-run audit; polling it every few seconds is what drained an RPC
// plan on the 2026-11-21 run. A batch PDA that does not exist is simply not
// listed, so runSoak reports it as missing.
async function observeDeployment({ rpc, rpcUrl, programs, deployment = DEFAULT_DEPLOYMENT, window = DEFAULT_WINDOW } = {}) {
  const transport = readOnly(rpc ?? jsonRpc(rpcUrl));
  const resolved = programs ?? programsFrom(JSON.parse(readFileSync(deployment, 'utf8')));
  const core = new PublicKey(resolved.core);
  const context = createMarketContext(core, resolved.marketSeed);
  const registryOnly = await getAccounts(transport, [context.registry.toBase58()]);
  if (!registryOnly[0]) throw new Error('registry account not found');
  const counter = BigInt(decodeAccount('Registry', registryOnly[0]).batchIdCounter);
  if (counter === 0n) return { currentBatchId: null, batches: [] };
  const ids = [];
  for (let id = counter - 1n; id >= 0n && ids.length < window; id--) ids.push(id);
  const accounts = await getAccounts(transport,
    ids.map(id => context.pda([Buffer.from('batch'), u64(id)], core)[0].toBase58()));
  const batches = [];
  accounts.forEach((data, index) => {
    if (!data || data[0] !== layouts.Batch.discriminator) return;
    const state = decodeAccount('Batch', data);
    batches.push({ id: Number(ids[index]), status: STATUS_NAME.get(Number(state.status)) ?? 'other' });
  });
  batches.sort((a, b) => a.id - b.id);
  return { currentBatchId: Number(counter - 1n), batches };
}

async function getAccounts(rpc, addresses) {
  const result = await rpc('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }]);
  return result.value.map(value => value ? Buffer.from(value.data[0], 'base64') : null);
}

function normalizeViolations(result, error) {
  if (error) {
    if (Array.isArray(error.violations)) return error.violations;
    return [{ invariant: 'audit', message: error.message }];
  }
  if (Array.isArray(result)) return result;
  return result?.violations ?? [];
}

async function runSoak({
  durationMs = DEFAULT_DURATION_MS,
  pollMs = DEFAULT_POLL_MS,
  stuckClearedMs = DEFAULT_STUCK_CLEARED_MS,
  minBatches = 0,
  now = Date.now,
  sleep = ms => new Promise(done => setTimeout(done, ms)),
  observe,
  audit,
  drive,
} = {}) {
  assert.ok(Number.isFinite(durationMs) && durationMs > 0, 'durationMs must be positive (duration)');
  assert.ok(Number.isFinite(pollMs) && pollMs > 0, 'pollMs must be positive');
  assert.ok(Number.isFinite(stuckClearedMs) && stuckClearedMs >= 0, 'stuckClearedMs must be nonnegative');
  assert.ok(Number.isFinite(minBatches) && minBatches >= 0, 'minBatches must be nonnegative');
  assert.equal(typeof observe, 'function', 'observe function required');
  assert.equal(typeof audit, 'function', 'audit function required');
  assert.equal(typeof now, 'function', 'now clock function required');
  assert.equal(typeof sleep, 'function', 'sleep function required');
  if (drive !== undefined) assert.equal(typeof drive, 'function', 'drive must be a function');

  const failures = [];
  const seen = new Set();
  const clearedSince = new Map();
  const stuckReported = new Set();
  let polls = 0;
  let previousMax = null;
  const start = now();

  // Poll until the duration elapses. The first poll always runs so a
  // zero-length fake-time window still observes the market once.
  for (;;) {
    if (polls > 0 && now() - start >= durationMs) break;
    polls++;
    if (drive) {
      try {
        await drive(polls);
      } catch (error) {
        failures.push(`drive failed: ${error.message}`);
        if (isBudgetError(error)) break;
      }
    }
    try {
      const snapshot = await observe();
      const at = now();
      assert.ok(snapshot && Array.isArray(snapshot.batches), 'observe must return {currentBatchId, batches}');
      const ids = snapshot.batches.map(batch => Number(batch.id));
      for (const id of ids) seen.add(id);
      if (snapshot.currentBatchId !== null && snapshot.currentBatchId !== undefined) {
        seen.add(Number(snapshot.currentBatchId));
      }
      const currentMax = ids.length
        ? Math.max(...ids, ...(snapshot.currentBatchId != null ? [Number(snapshot.currentBatchId)] : []))
        : (snapshot.currentBatchId != null ? Number(snapshot.currentBatchId) : null);
      // Missing batch: an id between the previous and current high-water
      // marks that no poll has ever listed.
      if (previousMax !== null && currentMax !== null && currentMax > previousMax) {
        for (let id = previousMax + 1; id < currentMax; id++) {
          if (!seen.has(id) && !failures.some(f => f === `missing batch ${id}`)) {
            failures.push(`missing batch ${id}`);
          }
        }
      }
      if (currentMax !== null) previousMax = previousMax === null ? currentMax : Math.max(previousMax, currentMax);
      // Stuck Cleared: continuously cleared for longer than the budget.
      const clearedNow = new Set();
      for (const batch of snapshot.batches) {
        const id = Number(batch.id);
        if (batch.status === 'cleared') {
          clearedNow.add(id);
          if (!clearedSince.has(id)) clearedSince.set(id, at);
          const heldMs = at - clearedSince.get(id);
          if (heldMs > stuckClearedMs && !stuckReported.has(id)) {
            stuckReported.add(id);
            failures.push(`stuck Cleared batch ${id}: cleared for ${heldMs} ms (limit ${stuckClearedMs} ms)`);
          }
        }
      }
      for (const id of [...clearedSince.keys()]) {
        if (!clearedNow.has(id)) clearedSince.delete(id);
      }
    } catch (error) {
      failures.push(`observe failed: ${error.message}`);
      // A spent request budget ends polling; the audit still runs.
      if (isBudgetError(error)) break;
    }
    if (now() - start >= durationMs) break;
    await sleep(pollMs);
  }

  // The end-of-run audit runs exactly once, even on failure.
  let auditViolations = [];
  try {
    auditViolations = normalizeViolations(await audit());
  } catch (error) {
    auditViolations = normalizeViolations(null, error);
  }
  if (auditViolations.length) {
    failures.push(`audit violations: ${auditViolations.map(v => v.message ?? JSON.stringify(v)).join('; ')}`);
  }

  const batchesSeen = seen.size;
  if (batchesSeen < minBatches) {
    failures.push(`batchesSeen ${batchesSeen} below minBatches ${minBatches}`);
  }
  return {
    pass: failures.length === 0,
    failures,
    batchesSeen,
    batchIds: [...seen].sort((a, b) => a - b),
    polls,
    auditViolations,
  };
}

function parseArgs(argv) {
  const options = {
    rpc: process.env.RPC_URL || DEVNET,
    deployment: DEFAULT_DEPLOYMENT,
    durationMs: DEFAULT_DURATION_MS,
    pollMs: DEFAULT_POLL_MS,
    stuckClearedMs: DEFAULT_STUCK_CLEARED_MS,
    minBatches: null,
    maxRequests: DEFAULT_MAX_REQUESTS,
    allowKeyedRpc: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--allow-keyed-rpc') {
      options.allowKeyedRpc = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag}: missing value`);
    if (flag === '--rpc') options.rpc = value;
    else if (flag === '--deployment') options.deployment = resolve(value);
    else if (flag === '--duration-ms') options.durationMs = Number(value);
    else if (flag === '--poll-ms') options.pollMs = Number(value);
    else if (flag === '--stuck-cleared-ms') options.stuckClearedMs = Number(value);
    else if (flag === '--min-batches') options.minBatches = Number(value);
    else if (flag === '--max-requests') options.maxRequests = Number(value);
    else throw new Error(`unknown argument ${flag}`);
    i++;
  }
  // About 700 batches at the 2 h default: one batch per 10 s of run.
  if (options.minBatches === null) options.minBatches = Math.floor(options.durationMs / 10000);
  if (!Number.isInteger(options.maxRequests) || options.maxRequests <= 0) throw new Error('--max-requests must be a positive integer');
  assertUnkeyedRpc(options.rpc, { allowKeyed: options.allowKeyedRpc });
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  // Polling and the end-of-run audit have separate caps, so a spent poll
  // budget still leaves the audit its requests.
  const pollBudget = createRequestBudget({ max: options.maxRequests });
  const auditBudget = createRequestBudget({ max: AUDIT_MAX_REQUESTS });
  const pollRpc = jsonRpc(options.rpc, { budget: pollBudget, retries: RPC_RETRIES });
  const auditRpc = jsonRpc(options.rpc, { budget: auditBudget, retries: RPC_RETRIES });
  // Startup probe: an unreachable RPC is a usage/RPC error (exit 2, like
  // audit.js), not a soak failure. Mid-run observe errors stay failures.
  await observeDeployment({ rpc: pollRpc, deployment: options.deployment });
  // No drive hook here: ticket #40's devnet run supplies maker/taker
  // activity programmatically through runSoak's drive option.
  const verdict = await runSoak({
    durationMs: options.durationMs,
    pollMs: options.pollMs,
    stuckClearedMs: options.stuckClearedMs,
    minBatches: options.minBatches,
    observe: () => observeDeployment({ rpc: pollRpc, deployment: options.deployment }),
    audit: () => auditDeployment({ rpc: auditRpc, deployment: options.deployment }),
  });
  return { rpcUrl: redactRpcUrl(options.rpc), deployment: options.deployment, ...verdict,
    requests: { poll: pollBudget.used, pollMax: pollBudget.max, audit: auditBudget.used, auditMax: auditBudget.max } };
}

if (require.main === module) {
  main(process.argv.slice(2)).then(verdict => {
    process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
    process.exitCode = verdict.pass ? 0 : 1;
  }, error => {
    process.stderr.write(`soak failed: ${error.message}\n`);
    process.exitCode = 2;
  });
}

module.exports = {
  runSoak,
  observeDeployment,
  parseArgs,
  main,
  BATCH_STATUS,
  DEFAULT_DURATION_MS,
  DEFAULT_POLL_MS,
  DEFAULT_STUCK_CLEARED_MS,
  DEFAULT_MAX_REQUESTS,
  AUDIT_MAX_REQUESTS,
  RPC_RETRIES,
};
