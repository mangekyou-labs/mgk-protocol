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
