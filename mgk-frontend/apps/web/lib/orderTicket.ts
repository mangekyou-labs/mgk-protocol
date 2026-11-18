import type { MarketExposure, OracleReading } from '@/lib/marketBar';
import {
  abs,
  LAMPORTS_PER_LOT,
  LOTS_PER_SOL,
  MARKET_EXPOSURE_LIMIT_LOTS,
  ORACLE_MAX_AGE_SECONDS,
  PORTFOLIO_EXPOSURE_LIMIT_LOTS,
  RESERVE_LAMPORTS_PER_LOT,
} from '@/lib/protocol';
import { formatSol } from '@/lib/solAmount';

export type TicketSide = 'buy' | 'sell';

const SIZE_PATTERN = /^\d+(?:\.\d*)?$/;

/**
 * SOL size string to integer lots. Never rounds: finer than 0.001 is flagged.
 * Blank or zero input is empty (lots null) but not a lot problem; input that
 * is not a decimal number is never reported as a lot multiple.
 */
export function parseLots(size: string): { lots: bigint | null; lotMultiple: boolean } {
  const s = size.trim();
  if (s === '') return { lots: null, lotMultiple: true };
  if (!SIZE_PATTERN.test(s)) return { lots: null, lotMultiple: false };
  const [whole, fraction = ''] = s.split('.');
  if (fraction.replace(/0+$/, '').length > 3) return { lots: null, lotMultiple: false };
  const lots = BigInt(whole) * LOTS_PER_SOL + BigInt(fraction.slice(0, 3).padEnd(3, '0'));
  return { lots: lots > 0n ? lots : null, lotMultiple: true };
}

/** USD price string to micro-USD; null when blank, zero or finer than 1e-6. */
export function parsePriceMicro(price: string): bigint | null {
  const s = price.trim();
  if (!/^\d+(?:\.\d{0,6})?$/.test(s)) return null;
  const [whole, fraction = ''] = s.split('.');
  const micro = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  return micro > 0n ? micro : null;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * Collateral the program reserves for an order on the book (mirrors
 * perps-core risk::reservation). Notional is valued at max(limit, oracle)
 * and expressed in lamports. IM is 20 %, the worst-case fee 5 bps, each
 * rounded up. Reduce-only orders reserve only the fee.
 */
export function reservation({
  lots,
  price,
  oraclePrice,
  reduceOnly,
}: {
  lots: bigint;
  price: bigint;
  oraclePrice: bigint;
  reduceOnly: boolean;
}): { orderValue: bigint; initialMargin: bigint; fee: bigint } {
  const valued = price > oraclePrice ? price : oraclePrice;
  const numerator = lots * valued * 1_000_000n;
  const fee = ceilDiv(numerator, oraclePrice * 2_000n);
  const initialMargin = reduceOnly ? 0n : ceilDiv(numerator, oraclePrice * 5n);
  return { orderValue: (lots * price) / LOTS_PER_SOL, initialMargin, fee };
}

export interface TicketInput {
  side: TicketSide;
  price: string;
  size: string;
  reduceOnly: boolean;
  oracle: OracleReading;
  /** null = pause flags unknown. */
  newExposurePaused: boolean | null;
  /** Lamports; null = unknown. */
  withdrawableCollateral: bigint | null;
  /** Signed lots; null = unknown. */
  positionLots: bigint | null;
  /** Vault open interest and insurance fund; null = unknown. */
  market: MarketExposure | null;
}

const sol = (lots: bigint) => formatSol(lots * LAMPORTS_PER_LOT);

function reduceOnlySideReason(side: TicketSide, position: bigint | null): string | null {
  if (position == null) return 'Position unknown. Reduce-only needs your position.';
  if (position === 0n) return 'Reduce-only needs an open position.';
  if (position > 0n && side !== 'sell') return 'Reduce-only must be Sell against your long.';
  if (position < 0n && side !== 'buy') return 'Reduce-only must be Buy against your short.';
  return null;
}

function newExposureReason(t: TicketInput): string | null {
  if (t.newExposurePaused == null) return 'Pause status unknown.';
  if (t.newExposurePaused) {
    return 'New exposure paused (insurance exhausted). Cancel and reduce-only still work.';
  }
  if (t.market == null) return 'Market exposure unknown.';
  return null;
}

function oracleReason(oracle: OracleReading, reduceOnly: boolean): string | null {
  const consequence = reduceOnly ? 'Reduce-only fee cannot be priced.' : 'New exposure blocked.';
  if (oracle.state === 'stale') {
    return `Oracle stale (${oracle.ageSeconds} s > ${ORACLE_MAX_AGE_SECONDS} s). ${consequence}`;
  }
  if (oracle.state === 'unavailable') return `Oracle unavailable. ${consequence}`;
  return null;
}

/**
 * Exposure checks in the order perps-core applies them: portfolio exposure
 * limit, market exposure limit on the order side, then risk-off admission.
 */
function exposureLimitReason(
  side: TicketSide,
  lots: bigint,
  position: bigint,
  market: MarketExposure,
): string | null {
  const after = side === 'buy' ? position + lots : position - lots;
  if (abs(after) > PORTFOLIO_EXPOSURE_LIMIT_LOTS) {
    return `Portfolio exposure limit is ${sol(PORTFOLIO_EXPOSURE_LIMIT_LOTS)} SOL.`;
  }
  const sideOi = side === 'buy' ? market.openInterestLong : market.openInterestShort;
  if (sideOi + lots > MARKET_EXPOSURE_LIMIT_LOTS) {
    const label = side === 'buy' ? 'long' : 'short';
    return `Market exposure limit: ${label} open interest ${sol(sideOi)} of ${sol(MARKET_EXPOSURE_LIMIT_LOTS)} SOL.`;
  }
  const larger =
    market.openInterestLong > market.openInterestShort ? market.openInterestLong : market.openInterestShort;
  if (market.insuranceFund < (larger + lots) * RESERVE_LAMPORTS_PER_LOT) {
    return 'Risk-off: insurance fund below reserve. Only reduce-only orders are accepted.';
  }
  return null;
}

/** Why the order cannot be posted, or null when it can. */
export function orderBlockReason(t: TicketInput): string | null {
  const position = t.positionLots;
  const precondition =
    (t.reduceOnly ? reduceOnlySideReason(t.side, position) : newExposureReason(t)) ??
    oracleReason(t.oracle, t.reduceOnly);
  if (precondition) return precondition;
  // Narrowing for the checks below; the precondition already reported these.
  if (t.oracle.state !== 'valid') return null;
  const oraclePrice = t.oracle.price;

  const price = parsePriceMicro(t.price);
  if (price == null) return 'Enter a price.';
  const size = t.size.trim();
  if (size !== '' && !SIZE_PATTERN.test(size)) return 'Enter a valid size.';
  const { lots, lotMultiple } = parseLots(size);
  if (!lotMultiple) return 'Size must be a multiple of 0.001 SOL.';
  if (lots == null) return 'Enter a size.';

  const withdrawable = t.withdrawableCollateral;
  if (t.reduceOnly) {
    if (position == null) return null;
    const open = abs(position);
    if (lots > open) return `Reduce-only can close at most ${sol(open)} SOL.`;
    if (withdrawable == null) return 'Withdrawable collateral unknown.';
    const { fee } = reservation({ lots, price, oraclePrice, reduceOnly: true });
    if (fee > withdrawable) {
      return `Needs ${formatSol(fee)} SOL fee, ${formatSol(withdrawable)} SOL withdrawable.`;
    }
    return null;
  }

  if (t.market == null) return null;
  const limit = exposureLimitReason(t.side, lots, position ?? 0n, t.market);
  if (limit) return limit;

  if (withdrawable == null) return 'Withdrawable collateral unknown.';
  const r = reservation({ lots, price, oraclePrice, reduceOnly: false });
  const needed = r.initialMargin + r.fee;
  if (needed > withdrawable) {
    return `Needs ${formatSol(needed)} SOL margin, ${formatSol(withdrawable)} SOL withdrawable.`;
  }
  return null;
}
