'use strict';
// Regression: creation guards once returned their address unconditionally,
// so the sender skipped steps 1-4 on an empty market and TopUp then failed
// with InvalidAccountOwner against a nonexistent vault.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PublicKey } = require('@solana/web3.js');
const { GUARDS } = require('./send-dprime-txs');

const summary = { accounts: {
  oracle: '59MPtNZtkupFj4uMjrsi838JVQbVrKHGT33QL6bBRsU8',
  registry: 'CbwTpmDgb6KKfBpv156754dXBpCoKPyjGt1kmJAb8mtR',
  book: '7bbMK7jCC1V69hDbFvezdVfWvVW1LRR916AQdjLY6s9y',
  batch0: '9cmuzYfCbiiWmysVskoc9EzTboeYidgYuSTyH72ad5pU',
  vault: 'D1qhB6uNqWJWWfwv8SWWTFytdcAjbSH4w1YYoME1ub1k',
  makerPortfolio: '6e1YB5TKEGnBTj2ke8UPfTRE5jQtGBDJNrKHTk1QyGV1',
} };
const connWith = (info) => ({ getAccountInfo: async () => info });
const account = (owner, data) => ({ owner: new PublicKey(owner), lamports: 1, data });

test('guards do not skip when accounts are missing', async () => {
  for (const guard of [GUARDS[0], GUARDS[1], GUARDS[2], GUARDS[3], GUARDS[5]]) {
    assert.equal(await guard(summary, connWith(null)), null);
  }
});

test('a merely funded system account is not provisioned', async () => {
  const funded = account('11111111111111111111111111111111', Buffer.alloc(0));
  assert.equal(await GUARDS[0](summary, connWith(funded)), null);
  assert.equal(await GUARDS[1](summary, connWith(funded)), null);
});

test('guards skip only on correctly owned provisioned accounts', async () => {
  const oracle = account('GLAu9n48oqnVRKHNoqfpek3kZyGUJTJRPQKo7mF3qWmm', Buffer.alloc(128));
  assert.equal(await GUARDS[0](summary, connWith(oracle)), summary.accounts.oracle);
  const registry = account('9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT', Buffer.alloc(94));
  assert.equal(await GUARDS[1](summary, connWith(registry)), summary.accounts.registry);
});
