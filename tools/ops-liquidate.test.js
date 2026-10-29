'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {decideLiquidation, encodeLiquidateUser, decodePortfolioHealth} = require('./ops-liquidate');
const underwater = {health:-1n, positionsLen:1, oracleValid:true};
test('health zero and healthy portfolios cannot be liquidated', () => {
  for (const health of [0n,1n]) assert.equal(decideLiquidation({...underwater,health}).reason,'healthy');
});
test('valid conversion permits takeover independently of auction mark', () => {
  assert.equal(decideLiquidation({...underwater,markValid:false,liqPaused:true,batchStatus:0}).action,'liquidate');
});
test('invalid conversion, liquidation pause, and unapplied fills block takeover', () => {
  assert.equal(decideLiquidation({...underwater,oracleValid:false}).reason,'oracle_invalid');
  assert.equal(decideLiquidation({...underwater,liquidationsPaused:true}).reason,'liquidations_paused');
  assert.equal(decideLiquidation({...underwater,hasUnsettledBatch:true}).reason,'unsettled_fills');
});
test('single-market wire contract rejects unsupported instrument counts', () => {
  assert.deepEqual([...encodeLiquidateUser(1)],[9,1,0]);
  for (const count of [0,2,-1,65536]) assert.throws(()=>encodeLiquidateUser(count));
});
test('version 3 portfolio health is recalculated at the conversion price', () => {
  const data=Buffer.alloc(2848);data[0]=4;data[1]=3;
  data.writeBigInt64LE(100_000_000n,48);data.writeUInt16LE(1,208);
  data.writeBigInt64LE(1000n,224);data.writeBigInt64LE(101_000_000n,232);
  // Cached health is intentionally stale and must not influence the decision.
  data.writeBigInt64LE(999_000_000n,192);
  assert.equal(decodePortfolioHealth(data,100_000_000n).health,-10_000_000n);
  assert.throws(()=>decodePortfolioHealth(data,0n));
  data[1]=2;assert.throws(()=>decodePortfolioHealth(data,100_000_000n));
});
