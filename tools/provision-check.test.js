'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hostOf, isPubkey, parseManifest, lamportsToSol } = require('./provision-check.js');

test('hostOf never leaks api keys or paths', () => {
  const secret = 'https://devnet.helius-rpc.com/?api-key=123456789abcdef';
  assert.equal(hostOf(secret), 'devnet.helius-rpc.com');
  assert.equal(/api-key|123456/.test(hostOf(secret)), false);
  assert.equal(hostOf('not a url'), 'invalid-rpc');
});

test('isPubkey accepts manifest program IDs and rejects junk', () => {
  assert.equal(isPubkey('9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT'), true);
  assert.equal(isPubkey('0OIl-not-base58'), false);
  assert.equal(isPubkey(''), false);
  assert.equal(isPubkey(undefined), false);
});

test('parseManifest requires three devnet program IDs', () => {
  const good = JSON.stringify({
    name: 'm', cluster: 'devnet',
    programs: {
      perps_core: '9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT',
      perps_matcher: '68MQqdugxZQA2F8GahhWZEusPnHbrfAXjqq2V9VCz8tK',
      oracle: 'GLAu9n48oqnVRKHNoqfpek3kZyGUJTJRPQKo7mF3qWmm',
    },
    accounts: {}, start_slot: { status: 'pending' },
  });
  assert.equal(parseManifest(good).cluster, 'devnet');
  assert.throws(() => parseManifest('{"cluster":"devnet","programs":{}}'), /perps_core/);
  assert.throws(
    () => parseManifest(good.replace('"devnet"', '"mainnet-beta"')),
    /cluster/,
  );
});

test('lamportsToSol formats balances', () => {
  assert.equal(lamportsToSol(0), '0.0000');
  assert.equal(lamportsToSol(1_500_000_000), '1.5000');
});
