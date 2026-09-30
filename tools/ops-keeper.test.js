'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  decodeRegistry,
  decodeBatch,
  capSettlementPortfolios,
  MAX_SETTLE_PORTFOLIOS,
  liquidationPassDue,
} = require('./ops-keeper');
const { decideLiquidation } = require('./ops-liquidate');

function packedRegistry({ nMin = 4, batchIdCounter = 7n }) {
  const buf = Buffer.alloc(86, 0);
  buf.writeUInt16LE(1, 32); // instrument_count
  buf.writeUInt16LE(100, 34); // volatility
  buf.writeBigUInt64LE(batchIdCounter, 36);
  buf.writeBigUInt64LE(1_000_000n, 44); // base_deposit
  buf.writeUInt32LE(nMin, 52);
  buf.writeBigUInt64LE(32n, 56); // t_min
  return buf;
}

function packedBatch({
  batchId = 6n,
  status = 0,
  totalCommitments = 3,
  commitDeadlineSlot = 99n,
  markValid = 1,
  liqPaused = 0,
}) {
  const buf = Buffer.alloc(160, 0);
  buf.writeBigUInt64LE(batchId, 0);
  buf.writeUInt8(status, 8);
  buf.writeBigUInt64LE(commitDeadlineSlot, 16);
  buf.writeUInt32LE(totalCommitments, 56);
  buf.writeUInt8(markValid, 152);
  buf.writeUInt8(liqPaused, 153);
  return buf;
}

test('decodeRegistry reads batch_id_counter @36 as bigint and n_min @52', () => {
  const r = decodeRegistry(packedRegistry({ nMin: 8, batchIdCounter: 42n }));
  assert.equal(r.batchIdCounter, 42n);
  assert.equal(typeof r.batchIdCounter, 'bigint');
  assert.equal(r.nMin, 8);
  assert.equal(r.batchIdCounter === 0n, false);
  const current = r.batchIdCounter - 1n;
  assert.equal(current, 41n);
});

test('decodeRegistry treats counter 0 as no batches (bigint compare)', () => {
  const r = decodeRegistry(packedRegistry({ batchIdCounter: 0n }));
  assert.equal(r.batchIdCounter === 0n, true);
});

test('decodeBatch reads totalCommitments as u32 @56 not padded u16 @9', () => {
  const b = decodeBatch(packedBatch({ totalCommitments: 0x00010002, status: 2 }));
  assert.equal(b.batchId, 6n);
  assert.equal(b.status, 2);
  assert.equal(b.totalCommitments, 0x00010002);
  assert.equal(b.commitDeadlineSlot, 99n);
  assert.equal(b.markValid, 1);
});

test('capSettlementPortfolios fails closed when fills exist but none resolved', () => {
  assert.throws(
    () => capSettlementPortfolios([], { fillCount: 2 }),
    /unresolved/,
  );
});

test('capSettlementPortfolios rejects over-cap remaining accounts', () => {
  const tooMany = Array.from({ length: MAX_SETTLE_PORTFOLIOS + 1 }, () => 'x');
  assert.throws(
    () => capSettlementPortfolios(tooMany, { fillCount: 1 }),
    /too many/,
  );
});

test('capSettlementPortfolios returns the list when within cap', () => {
  const list = ['a', 'b'];
  assert.deepEqual(capSettlementPortfolios(list, { fillCount: 1 }), list);
});

test('liquidation pass is due only on Settled + mark_valid + not liq_paused', () => {
  assert.equal(liquidationPassDue({ status: 3, markValid: 1, liqPaused: 0 }), true);
  assert.equal(liquidationPassDue({ status: 0, markValid: 1, liqPaused: 0 }), false);
  assert.equal(liquidationPassDue({ status: 3, markValid: 0, liqPaused: 0 }), false);
  assert.equal(liquidationPassDue({ status: 3, markValid: 1, liqPaused: 1 }), false);
});

test('underwater settled portfolios remain liquidatable via ops-liquidate', () => {
  const d = decideLiquidation({
    health: -1n,
    positionsLen: 1,
    markValid: 1,
    liqPaused: 0,
    liquidationsPaused: false,
    batchStatus: 3,
  });
  assert.equal(d.action, 'liquidate');
});
