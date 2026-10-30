const {encodeInstruction} = require('../mgk-frontend/packages/layout/instructions.js');
const {decodeAccount} = require('../mgk-frontend/packages/layout/index.js');
'use strict';

const LIQUIDATE_DISC = 9;
function floorDiv(n, d) {return n / d - (n < 0n && n % d !== 0n ? 1n : 0n);}

/** Reprice maintenance health from the v3 ledger at a validated oracle price.
 * Oracle provenance/freshness validation belongs to the caller and on-chain gate.
 */
function decodePortfolioHealth(data, conversionPrice) {
 const p=decodeAccount('Portfolio',data);const price=BigInt(conversionPrice);
 if(price<=0n)throw new Error('conversion price must be positive');
 if(p.positionsLen>p.positions.length)throw new Error('invalid positions length');
 let health=p.equity;
 for(const pos of p.positions.slice(0,p.positionsLen)) {
  if(pos.instrumentId!==0)throw new Error('only SOL-PERP is supported');
  const {qty,entryVwap:entry,entryRemainder:rem}=pos; const den=pos.entryDenominator||1n;
  health+=floorDiv(qty*1_000_000n*((price-entry)*den-rem),price*den);
  health-=(qty<0n?-qty:qty)*100_000n;
 }
 return {health,positionsLen:p.positionsLen};
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
module.exports = {LIQUIDATE_DISC, decodePortfolioHealth, encodeLiquidateUser, decideLiquidation};
