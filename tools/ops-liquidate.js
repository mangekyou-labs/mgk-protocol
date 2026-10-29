'use strict';

const LIQUIDATE_DISC = 9;
function readI128LE(buf, offset) {
  return (buf.readBigInt64LE(offset + 8) << 64n) + buf.readBigUInt64LE(offset);
}
function floorDiv(n, d) {return n / d - (n < 0n && n % d !== 0n ? 1n : 0n);}

/** Reprice maintenance health from the v3 ledger at a validated oracle price.
 * Oracle provenance/freshness validation belongs to the caller and on-chain gate.
 */
function decodePortfolioHealth(data, conversionPrice) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const price = BigInt(conversionPrice);
  if (buf.length < 2848 || buf[0] !== 4 || buf[1] !== 3) throw new Error('expected version 3 portfolio');
  if (price <= 0n) throw new Error('conversion price must be positive');
  const positionsLen = buf.readUInt16LE(208);
  if (positionsLen > 32) throw new Error('invalid positions length');
  let health = readI128LE(buf, 48);
  for (let i = 0; i < positionsLen; i++) {
    const off = 216 + i * 40;
    if (buf.readUInt16LE(off) !== 0) throw new Error('only SOL-PERP is supported');
    const qty = buf.readBigInt64LE(off + 8);
    const entry = buf.readBigInt64LE(off + 16);
    const rem = buf.readBigUInt64LE(off + 24);
    const den = buf.readBigUInt64LE(off + 32) || 1n;
    health += floorDiv(qty * 1_000_000n * ((price - entry) * den - rem), price * den);
    health -= (qty < 0n ? -qty : qty) * 100_000n;
  }
  return {health, positionsLen};
}
function encodeLiquidateUser(numInstruments = 1) {
  if (numInstruments !== 1) throw new Error('only one SOL-PERP instrument is supported');
  return Buffer.from([LIQUIDATE_DISC, 1, 0]);
}
/** health must have been refreshed at the same validated conversion oracle. */
function decideLiquidation(p) {
  if (!p.positionsLen) return {action:'skip', reason:'no_positions'};
  if (BigInt(p.health) >= 0n) return {action:'skip', reason:'healthy'};
  if (!p.oracleValid) return {action:'skip', reason:'oracle_invalid'};
  if (p.hasUnsettledBatch) return {action:'skip', reason:'unsettled_fills'};
  if (p.liquidationsPaused) return {action:'skip', reason:'liquidations_paused'};
  return {action:'liquidate', reason:'underwater'};
}
module.exports = {LIQUIDATE_DISC, decodePortfolioHealth, encodeLiquidateUser, decideLiquidation, readI128LE};
