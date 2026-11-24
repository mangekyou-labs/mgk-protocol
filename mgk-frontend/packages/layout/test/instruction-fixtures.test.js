const {test} = require('node:test');
const assert = require('node:assert/strict');
const {encodeInstruction, instructions} = require('../instructions');
const fixtures = require('../instruction-fixtures.json');

test('shared encoders reproduce every program-linked Rust instruction vector', () => {
  const covered = new Set();
  for (const fixture of fixtures) {
    const params = {...fixture.params};
    if (params.orderIds) params.orderIds = params.orderIds.map(BigInt);
    const encoded = encodeInstruction(fixture.program, fixture.name, params);
    assert.deepEqual([...encoded], fixture.bytes, `${fixture.program}::${fixture.name}`);
    assert.equal(instructions[fixture.program][fixture.name].enabled, fixture.enabled);
    covered.add(`${fixture.program}::${fixture.name}`);
  }
  const expected = Object.entries(instructions).flatMap(([program, rows]) =>
    Object.keys(rows).map(name => `${program}::${name}`));
  assert.deepEqual([...covered].sort(), expected.sort(), 'all frozen dispatches need Rust vectors');
});

test('issue 74: core CloseSettledBatch (30) and matcher CloseResults (11) carry the batch id as u64 LE', () => {
  assert.deepEqual([...encodeInstruction('core', 'CloseSettledBatch', {batchId: 0x0102030405060708n})],
    [30, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.deepEqual([...encodeInstruction('matcher', 'CloseResults', {batchId: 7n})],
    [11, 7, 0, 0, 0, 0, 0, 0, 0]);
  assert.throws(() => encodeInstruction('core', 'CloseSettledBatch', {}), /Missing instruction field batchId/);
});
