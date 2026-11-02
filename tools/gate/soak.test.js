'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runSoak, observeDeployment, parseArgs, DEFAULT_DURATION_MS, DEFAULT_STUCK_CLEARED_MS } = require('./soak');

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async ms => { t += ms; },
    advance: ms => { t += ms; },
    get t() { return t; },
  };
}

function observeFrom(snapshots) {
  let i = 0;
  return async () => snapshots[Math.min(i++, snapshots.length - 1)];
}

const CLEAN = { currentBatchId: 0, batches: [{ id: 0, status: 'settled' }] };

test('defaults are the 2 h gate soak with a 2 min stuck-Cleared budget', () => {
  assert.equal(DEFAULT_DURATION_MS, 2 * 60 * 60 * 1000);
  assert.equal(DEFAULT_STUCK_CLEARED_MS, 120000);
});

test('a clean soak passes, audits exactly once, and reports polls and batches seen', async () => {
  const clock = fakeClock();
  let audits = 0;
  const verdict = await runSoak({
    durationMs: 1000, pollMs: 250, now: clock.now, sleep: clock.sleep,
    observe: observeFrom([
      { currentBatchId: 0, batches: [{ id: 0, status: 'cleared' }] },
      { currentBatchId: 0, batches: [{ id: 0, status: 'settled' }] },
      { currentBatchId: 1, batches: [{ id: 0, status: 'settled' }, { id: 1, status: 'cleared' }] },
      { currentBatchId: 1, batches: [{ id: 0, status: 'settled' }, { id: 1, status: 'settled' }] },
      CLEAN,
    ]),
    audit: async () => { audits++; return { violations: [] }; },
  });
  assert.equal(verdict.pass, true, JSON.stringify(verdict));
  assert.deepEqual(verdict.failures, []);
  assert.deepEqual(verdict.auditViolations, []);
  assert.equal(verdict.batchesSeen, 2);
  assert.ok(verdict.polls >= 4);
  assert.equal(audits, 1);
});

test('a batch id skipped between polls fails as a missing batch, audit still runs once', async () => {
  const clock = fakeClock();
  let audits = 0;
  const verdict = await runSoak({
    durationMs: 500, pollMs: 250, now: clock.now, sleep: clock.sleep,
    observe: observeFrom([
      { currentBatchId: 0, batches: [{ id: 0, status: 'settled' }] },
      { currentBatchId: 2, batches: [{ id: 0, status: 'settled' }, { id: 2, status: 'settled' }] },
      { currentBatchId: 2, batches: [{ id: 0, status: 'settled' }, { id: 2, status: 'settled' }] },
    ]),
    audit: async () => { audits++; return { violations: [] }; },
  });
  assert.equal(verdict.pass, false);
  assert.ok(verdict.failures.some(f => /missing batch 1/.test(f)), JSON.stringify(verdict.failures));
  assert.equal(audits, 1);
});

test('a batch stuck in Cleared beyond stuckClearedMs fails; clearing in time passes', async () => {
  const clock = fakeClock();
  const stuck = await runSoak({
    durationMs: 1000, pollMs: 100, stuckClearedMs: 250, now: clock.now, sleep: clock.sleep,
    observe: async () => ({ currentBatchId: 0, batches: [{ id: 0, status: 'cleared' }] }),
    audit: async () => ({ violations: [] }),
  });
  assert.equal(stuck.pass, false);
  assert.ok(stuck.failures.some(f => /stuck Cleared batch 0/.test(f)), JSON.stringify(stuck.failures));

  const clock2 = fakeClock();
  const timely = await runSoak({
    durationMs: 1000, pollMs: 100, stuckClearedMs: 250, now: clock2.now, sleep: clock2.sleep,
    observe: observeFrom([
      { currentBatchId: 0, batches: [{ id: 0, status: 'cleared' }] },
      { currentBatchId: 0, batches: [{ id: 0, status: 'cleared' }] },
      { currentBatchId: 0, batches: [{ id: 0, status: 'settled' }] },
      { currentBatchId: 0, batches: [{ id: 0, status: 'settled' }] },
    ]),
    audit: async () => ({ violations: [] }),
  });
  assert.equal(timely.pass, true, JSON.stringify(timely));
});

test('audit violations fail the verdict; audit runs exactly once even when polling fails', async () => {
  const clock = fakeClock();
  let audits = 0;
  const verdict = await runSoak({
    durationMs: 500, pollMs: 250, now: clock.now, sleep: clock.sleep,
    observe: observeFrom([
      { currentBatchId: 0, batches: [{ id: 0, status: 'settled' }] },
      { currentBatchId: 2, batches: [{ id: 2, status: 'settled' }] },
      CLEAN,
    ]),
    audit: async () => {
      audits++;
      return { violations: [{ invariant: 'vault balance', message: 'under-backed' }] };
    },
  });
  assert.equal(verdict.pass, false);
  assert.equal(verdict.auditViolations.length, 1);
  assert.ok(verdict.failures.some(f => /missing batch/.test(f)));
  assert.equal(audits, 1);

  const clock2 = fakeClock();
  let audits2 = 0;
  const thrown = await runSoak({
    durationMs: 250, pollMs: 250, now: clock2.now, sleep: clock2.sleep,
    observe: async () => ({ currentBatchId: 0, batches: [{ id: 0, status: 'settled' }] }),
    audit: async () => {
      audits2++;
      const error = new Error('invariant "vault balance" violated after scenario "x"');
      error.violations = [{ invariant: 'vault balance', message: 'under-backed' }];
      throw error;
    },
  });
  assert.equal(thrown.pass, false);
  assert.equal(thrown.auditViolations.length, 1);
  assert.equal(audits2, 1);
});

test('an observe error is a failure and the end-of-run audit still runs once', async () => {
  const clock = fakeClock();
  let audits = 0;
  let calls = 0;
  const verdict = await runSoak({
    durationMs: 500, pollMs: 250, now: clock.now, sleep: clock.sleep,
    observe: async () => {
      calls++;
      if (calls === 1) throw new Error('RPC down');
      return CLEAN;
    },
    audit: async () => { audits++; return { violations: [] }; },
  });
  assert.equal(verdict.pass, false);
  assert.ok(verdict.failures.some(f => /RPC down/.test(f)), JSON.stringify(verdict.failures));
  assert.equal(audits, 1);
});

test('drive hook runs on every poll; a drive error fails the verdict', async () => {
  const clock = fakeClock();
  const driven = [];
  const verdict = await runSoak({
    durationMs: 1000, pollMs: 250, now: clock.now, sleep: clock.sleep,
    observe: async () => CLEAN,
    audit: async () => ({ violations: [] }),
    drive: async pollIndex => { driven.push(pollIndex); },
  });
  assert.equal(verdict.pass, true, JSON.stringify(verdict));
  assert.equal(driven.length, verdict.polls);
  assert.deepEqual(driven, verdict.polls ? Array.from({ length: verdict.polls }, (_, i) => i + 1) : []);

  const clock2 = fakeClock();
  const failed = await runSoak({
    durationMs: 500, pollMs: 250, now: clock2.now, sleep: clock2.sleep,
    observe: async () => CLEAN,
    audit: async () => ({ violations: [] }),
    drive: async () => { throw new Error('taker script died'); },
  });
  assert.equal(failed.pass, false);
  assert.ok(failed.failures.some(f => /taker script died/.test(f)), JSON.stringify(failed.failures));
});

test('verdict fails when fewer than minBatches batches are seen', async () => {
  const clock = fakeClock();
  const short = await runSoak({
    durationMs: 500, pollMs: 250, now: clock.now, sleep: clock.sleep, minBatches: 5,
    observe: async () => CLEAN,
    audit: async () => ({ violations: [] }),
  });
  assert.equal(short.pass, false);
  assert.ok(short.failures.some(f => /minBatches|batches/.test(f)), JSON.stringify(short.failures));

  const clock2 = fakeClock();
  const enough = await runSoak({
    durationMs: 500, pollMs: 250, now: clock2.now, sleep: clock2.sleep, minBatches: 1,
    observe: async () => CLEAN,
    audit: async () => ({ violations: [] }),
  });
  assert.equal(enough.pass, true, JSON.stringify(enough));
});

test('CLI min-batches defaults to about one batch per 10 s of duration', () => {
  assert.equal(parseArgs([]).minBatches, Math.floor(DEFAULT_DURATION_MS / 10000));
  assert.equal(parseArgs([]).minBatches, 720);
  assert.equal(parseArgs(['--min-batches', '12']).minBatches, 12);
  assert.equal(parseArgs(['--duration-ms', '100000']).minBatches, 10);
});

test('runSoak requires observe and audit and a positive duration', async () => {
  await assert.rejects(runSoak({ durationMs: 1 }), /observe/);
  await assert.rejects(runSoak({ durationMs: 1, observe: async () => CLEAN }), /audit/);
  await assert.rejects(runSoak({ durationMs: 0, observe: async () => CLEAN, audit: async () => ({ violations: [] }) }), /duration/);
});

test('observeDeployment maps on-chain batch statuses (settled=3, cleared=4) for the soak', async () => {
  const { market } = require('../runtime/invariant-fixtures');
  const m = market();
  const seen = await observeDeployment({
    rpc: (method, params) => m.chain.rpc(method, params),
    programs: m.programs,
  });
  assert.deepEqual(seen.batches, [
    { id: 0, status: 'settled' },
    { id: 1, status: 'cleared' },
    { id: 2, status: 'other' },
  ]);
  assert.equal(seen.currentBatchId, 2);
});
