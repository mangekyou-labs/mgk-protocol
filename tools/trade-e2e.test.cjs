'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveTraderKeypairPath } = require('./trade-e2e.js');

test('trader keypair paths honor persona-specific overrides', () => {
  assert.equal(
    resolveTraderKeypairPath('maker', { MGK_MAKER_KEYPAIR: '/tmp/maker.json' }, '/tmp/home'),
    '/tmp/maker.json',
  );
  assert.equal(
    resolveTraderKeypairPath('taker', { MGK_TAKER_KEYPAIR: '/tmp/taker.json' }, '/tmp/home'),
    '/tmp/taker.json',
  );
});
