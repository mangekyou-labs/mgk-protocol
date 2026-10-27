'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { publishedConfidence } = require('./oracle-sources');

test('published confidence is actual dispersion, including source uncertainty', () => {
  assert.equal(publishedConfidence([100_000_000n, 100_200_000n, 99_900_000n], 100_000_000n), 200_000n);
  assert.equal(publishedConfidence([100_000_000n, 100_000_000n], 100_000_000n), 0n);
  assert.equal(publishedConfidence([100_000_000n, 100_200_000n], 100_000_000n, [350_000n]), 350_000n);
});
