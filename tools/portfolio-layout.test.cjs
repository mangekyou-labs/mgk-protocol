'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readPortfolioPrincipalLow64 } = require('./trade-e2e.js');

test('funding checks read principal rather than equity', () => {
  const data = Buffer.alloc(64);
  data.writeBigInt64LE(-417_867_200_200n, 32);
  data.writeBigInt64LE(400_000_000n, 48);

  assert.equal(readPortfolioPrincipalLow64(data), 400_000_000n);
});
