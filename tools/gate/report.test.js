'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { GATE_ROWS, buildReport } = require('./report');

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const PIN = {
  commit: 'c'.repeat(40),
  cluster: 'devnet',
  programs: [
    { name: 'mgk_perps_core', programId: 'Core1111111111111111111111111111111111111', sha256: SHA_A },
    { name: 'mgk_perps_matcher', programId: 'Match111111111111111111111111111111111111', sha256: SHA_B },
  ],
};

test('GATE_ROWS holds all 35 P0 and 4 P1 rows with the required tiers from issue #11', () => {
  assert.equal(GATE_ROWS.length, 39);
  assert.equal(GATE_ROWS.filter(r => r.priority === 'P0').length, 35);
  assert.equal(GATE_ROWS.filter(r => r.priority === 'P1').length, 4);
  const byId = new Map(GATE_ROWS.map(r => [r.id, r]));
  assert.equal(byId.get('P0-1').tier, 'D');
  assert.equal(byId.get('P0-2').tier, 'M');
  assert.equal(byId.get('P0-3').tier, 'D (browser)');
  assert.equal(byId.get('P0-8').tier, 'L');
  assert.equal(byId.get('P0-11').tier, 'L');
  assert.equal(byId.get('P0-28').tier, 'D');
  assert.ok(['D′', "D'"].includes(byId.get('P0-31').tier), byId.get('P0-31').tier);
  assert.ok(['D′', "D'"].includes(byId.get('P0-32').tier), byId.get('P0-32').tier);
  assert.equal(byId.get('P0-33').tier, 'D');
  assert.equal(byId.get('P0-34').tier, 'D (browser)');
  assert.equal(byId.get('P0-35').tier, 'D');
  assert.equal(byId.get('P1-1').tier, 'M');
  assert.equal(byId.get('P1-2').tier, 'L');
  assert.equal(byId.get('P1-3').tier, 'L');
  assert.ok(['D′', "D'"].includes(byId.get('P1-4').tier), byId.get('P1-4').tier);
  assert.equal(new Set(GATE_ROWS.map(r => r.id)).size, 39);
  for (const row of GATE_ROWS) assert.ok(row.title && row.title.length > 3, row.id);
});

test('buildReport pins commit, cluster, program IDs and .so hashes; unsupplied rows are not run', () => {
  const md = buildReport({ ...PIN, rows: [] });
  assert.ok(md.includes(PIN.commit));
  assert.ok(md.includes('devnet'));
  for (const p of PIN.programs) {
    assert.ok(md.includes(p.programId), p.programId);
    assert.ok(md.includes(p.sha256), p.sha256);
    assert.ok(md.includes(p.name), p.name);
  }
  for (const row of GATE_ROWS) {
    const line = md.split('\n').find(l => l.includes(row.id));
    assert.ok(line, row.id);
    assert.ok(line.includes('not run'), line);
  }
});

test('a pass at the required tier is recorded; L rows can pass locally while D rows stay not run', () => {
  const md = buildReport({
    ...PIN,
    cluster: 'localnet',
    rows: [{ id: 'P0-8', status: 'pass', tier: 'L' }],
  });
  const l8 = md.split('\n').find(l => l.includes('P0-8'));
  assert.ok(l8.includes('pass'), l8);
  const d1 = md.split('\n').find(l => l.includes('P0-1'));
  assert.ok(d1.includes('not run'), d1);
});

test('a pass at any tier other than the required tier throws (no tier substitution)', () => {
  assert.throws(
    () => buildReport({ ...PIN, rows: [{ id: 'P0-1', status: 'pass', tier: 'L' }] }),
    /P0-1.*tier|tier.*P0-1/,
  );
  assert.throws(
    () => buildReport({ ...PIN, rows: [{ id: 'P0-8', status: 'pass', tier: 'D' }] }),
    /P0-8/,
  );
  assert.throws(
    () => buildReport({ ...PIN, rows: [{ id: 'P0-8', status: 'pass' }] }),
    /P0-8/,
  );
});

test('missing pin fields, unknown and duplicate row ids throw', () => {
  assert.throws(() => buildReport({ cluster: 'devnet', programs: PIN.programs, rows: [] }), /commit/);
  assert.throws(() => buildReport({ commit: PIN.commit, programs: PIN.programs, rows: [] }), /cluster/);
  assert.throws(() => buildReport({ commit: PIN.commit, cluster: 'devnet', rows: [] }), /program/);
  assert.throws(() => buildReport({ commit: PIN.commit, cluster: 'devnet', programs: [], rows: [] }), /program/);
  assert.throws(
    () => buildReport({ ...PIN, programs: [{ name: 'x', programId: 'y' }] }),
    /sha256|SHA/,
  );
  assert.throws(
    () => buildReport({ ...PIN, rows: [{ id: 'P0-99', status: 'pass', tier: 'D' }] }),
    /unknown|P0-99/,
  );
  assert.throws(
    () => buildReport({
      ...PIN,
      rows: [
        { id: 'P0-8', status: 'pass', tier: 'L' },
        { id: 'P0-8', status: 'fail', tier: 'L' },
      ],
    }),
    /duplicate|P0-8/,
  );
});

test('fail rows render as fail and evidence fields are carried into the report', () => {
  const md = buildReport({
    ...PIN,
    rows: [{ id: 'P0-8', status: 'fail', tier: 'L', batchIds: [3], signatures: ['sigABC'], notes: 'boom' }],
  });
  const line = md.split('\n').find(l => l.includes('P0-8'));
  assert.ok(line.includes('fail'), line);
  assert.ok(md.includes('sigABC'));
  assert.ok(md.includes('boom'));
});

test('checked-in TEMPLATE.md contains every GATE_ROWS id, all not run', () => {
  const template = readFileSync(join(__dirname, '../../docs/acceptance/TEMPLATE.md'), 'utf8');
  const ids = [...template.matchAll(/P[01]-\d+/g)].map(m => m[0]);
  assert.deepEqual([...new Set(ids)], GATE_ROWS.map(r => r.id));
  const lines = template.split('\n').filter(l => /P[01]-\d+/.test(l));
  assert.equal(lines.length, GATE_ROWS.length);
  for (const line of lines) assert.ok(line.includes('not run'), line);
});
