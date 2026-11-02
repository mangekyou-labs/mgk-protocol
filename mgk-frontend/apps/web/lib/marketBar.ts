import type { state } from '@mgk/sdk';

import type { OracleReading } from '@/components/trade/MarketHeader';
import type { OrderBookStatus } from '@/components/trade/OrderBook';

/** Oracle readings older than this block new exposure on-chain. */
export const ORACLE_MAX_AGE_SECONDS = 60;

/** Pause bits that block new exposure: PAUSE_TRADING | PAUSE_POST. */
export const NEW_EXPOSURE_PAUSE_MASK = 1 | 16;

export function readOracle(
  oracle: { isActive: boolean; price: bigint; timestamp: bigint } | null,
  nowSeconds: number,
): OracleReading {
  if (!oracle || !oracle.isActive || oracle.price <= 0n) {
    return { state: 'unavailable', price: null, ageSeconds: null };
  }
  const ageSeconds = Math.max(0, nowSeconds - Number(oracle.timestamp));
  return {
    state: ageSeconds > ORACLE_MAX_AGE_SECONDS ? 'stale' : 'valid',
    price: oracle.price,
    ageSeconds,
  };
}

/**
 * Freshness of the on-chain book read. A failed read keeps the last levels
 * but marks them delayed; with nothing to show the book is unavailable,
 * never an empty book.
 */
export function bookStatus({
  hasData,
  error,
  lastFetchedAt,
  nowMs,
  intervalMs,
}: {
  hasData: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  nowMs: number;
  intervalMs: number;
}): { status: OrderBookStatus; ageSeconds: number | null } {
  const ageSeconds =
    lastFetchedAt == null ? null : Math.max(0, Math.floor((nowMs - lastFetchedAt) / 1000));
  if (!hasData) {
    if (!error && lastFetchedAt == null) return { status: 'loading', ageSeconds };
    return { status: 'unavailable', ageSeconds };
  }
  const stale = lastFetchedAt == null || nowMs - lastFetchedAt > intervalMs * 3;
  return { status: error || stale ? 'delayed' : 'ok', ageSeconds };
}

export function lastClearOf(
  batch: state.BatchState | null,
  batchId: bigint,
): { price: bigint; batchId: bigint } | null {
  if (!batch || !batch.markValid || batch.clearingPrice <= 0n) return null;
  return { price: batch.clearingPrice, batchId };
}
