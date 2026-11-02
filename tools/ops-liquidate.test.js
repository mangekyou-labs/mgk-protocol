'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {decideLiquidation, encodeLiquidateUser, decodePortfolioHealth} = require('./ops-liquidate');
const {layouts} = require('../mgk-frontend/packages/layout');
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
test('portfolio repricing exposes unrealized PnL separately while preserving health and position count', () => {
  for (const [qty, entry, remainder, denominator, pnl] of [
    [0n, 0n, 0n, 1n, 0n],
    [1000n, 99_000_000n, 0n, 1n, 10_000_000n],
    [1000n, 101_000_000n, 0n, 1n, -10_000_000n],
    [-1000n, 101_000_000n, 0n, 1n, 10_000_000n],
    [-1000n, 99_000_000n, 0n, 1n, -10_000_000n],
    [1n, 100_000_000n, 1n, 3n, -1n],
  ]) {
    const data=Buffer.alloc(layouts.Portfolio.size);data[0]=4;data[1]=3;
    data.writeBigInt64LE(100_000_000n,layouts.Portfolio.fields.equity[0]);
    data.writeUInt16LE(qty===0n?0:1,layouts.Portfolio.fields.positionsLen[0]);
    const offset=layouts.Portfolio.fields.positions[0];
    data.writeBigInt64LE(qty,offset+layouts.Position.fields.qty[0]);
    data.writeBigInt64LE(entry,offset+layouts.Position.fields.entryVwap[0]);
    data.writeBigUInt64LE(remainder,offset+layouts.Position.fields.entryRemainder[0]);
    data.writeBigUInt64LE(denominator,offset+layouts.Position.fields.entryDenominator[0]);
    const result=decodePortfolioHealth(data,100_000_000n);
    assert.deepEqual(result,{
      health:100_000_000n+pnl-(qty<0n?-qty:qty)*100_000n,
      positionsLen:qty===0n?0:1,
      unrealizedPnl:pnl,
    });
  }
});
