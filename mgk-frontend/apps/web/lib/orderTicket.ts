import type { OracleReading } from '@/components/trade/MarketHeader';
import { formatSol } from '@/lib/solAmount';

/** 1 lot = 0.001 SOL. */
export const LOTS_PER_SOL = 1_000n;
/** Per-portfolio position cap: 10 SOL. */
export const MAX_POSITION_LOTS = 10_000n;

export type TicketSide = 'buy' | 'sell';

/** SOL size string to integer lots. Never rounds: finer than 0.001 is flagged. */
export function parseLots(size: string): { lots: bigint | null; lotMultiple: boolean } {
  const s = size.trim();
  if (!/^\d+(?:\.\d*)?$/.test(s)) return { lots: null, lotMultiple: true };
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
 * Collateral the program reserves for a resting order (mirrors
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
  /** Batch that cleared and is awaiting settlement, if any. */
  unsettledBatchId: bigint | null;
  /** Lamports; null = unknown. */
  freeCollateral: bigint | null;
  /** Signed lots; null = unknown. */
  positionLots: bigint | null;
}

const sol = (lots: bigint) => formatSol(lots * 1_000_000n);

/** Why the order cannot be posted, or null when it can. */
export function orderBlockReason(t: TicketInput): string | null {
  const { lots, lotMultiple } = parseLots(t.size);
  const position = t.positionLots;

  if (t.reduceOnly) {
    if (position == null || position === 0n) return 'Reduce-only needs an open position.';
    if (position > 0n && t.side !== 'sell') return 'Reduce-only must be Sell against your long.';
    if (position < 0n && t.side !== 'buy') return 'Reduce-only must be Buy against your short.';
  } else {
    if (t.newExposurePaused == null) return 'Pause status unknown.';
    if (t.newExposurePaused) {
      return 'New exposure paused (insurance exhausted). Cancel and reduce-only still work.';
    }
    if (t.oracle.state === 'stale') {
      return `Oracle stale (${t.oracle.ageSeconds} s > 60 s). New exposure blocked.`;
    }
    if (t.oracle.state === 'unavailable') return 'Oracle unavailable. New exposure blocked.';
  }
  if (t.unsettledBatchId != null) {
    return `Batch ${t.unsettledBatchId.toString()} cleared, awaiting settlement.`;
  }

  const price = parsePriceMicro(t.price);
  if (price == null) return 'Enter a price.';
  if (!lotMultiple) return 'Size must be a multiple of 0.001 SOL.';
  if (lots == null) return 'Enter a size.';

  if (t.reduceOnly) {
    const open = position! < 0n ? -position! : position!;
    if (lots > open) return `Reduce-only can close at most ${sol(open)} SOL.`;
    return null;
  }

  const current = position ?? 0n;
  const after = t.side === 'buy' ? current + lots : current - lots;
  if ((after < 0n ? -after : after) > MAX_POSITION_LOTS) return 'Max 10 SOL per portfolio.';

  if (t.freeCollateral == null) return 'Available margin unknown.';
  const oraclePrice = t.oracle.price!;
  const r = reservation({ lots, price, oraclePrice, reduceOnly: false });
  const needed = r.initialMargin + r.fee;
  if (needed > t.freeCollateral) {
    return `Needs ${formatSol(needed)} SOL margin, ${formatSol(t.freeCollateral)} available.`;
  }
  return null;
}
