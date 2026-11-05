import { state } from '@mgk/sdk';

import { ORACLE_MAX_AGE_SECONDS } from '@/lib/protocol';

export type OracleReading =
  | { state: 'valid'; price: bigint; ageSeconds: number }
  | { state: 'stale'; price: bigint; ageSeconds: number }
  | { state: 'unavailable'; price: null; ageSeconds: null };

export type OrderBookStatus = 'loading' | 'ok' | 'delayed' | 'unavailable';

/** Clearing price of a batch, labelled with that batch. */
export interface ClearPrice {
  price: bigint;
  batchId: bigint;
}

/** Vault figures that gate new exposure. Open interest in lots, fund in lamports. */
export interface MarketExposure {
  openInterestLong: bigint;
  openInterestShort: bigint;
  insuranceFund: bigint;
}

export function readOracle(
  oracle: { isActive: boolean; price: bigint; timestamp: bigint; confidence: bigint } | null,
  nowSeconds: number,
): OracleReading {
  if (
    !oracle || !oracle.isActive || oracle.price <= 0n || oracle.confidence < 0n ||
    oracle.confidence * 100n > oracle.price || oracle.timestamp > BigInt(nowSeconds)
  ) {
    return { state: 'unavailable', price: null, ageSeconds: null };
  }
  const ageSeconds = nowSeconds - Number(oracle.timestamp);
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

export function lastClearOf(batch: state.BatchState | null, batchId: bigint): ClearPrice | null {
  if (!batch || !batch.markValid || batch.clearingPrice <= 0n) return null;
  return { price: batch.clearingPrice, batchId };
}

export function marketExposure(vault: MarketExposure | null): MarketExposure | null {
  if (!vault) return null;
  return {
    openInterestLong: vault.openInterestLong,
    openInterestShort: vault.openInterestShort,
    insuranceFund: vault.insuranceFund,
  };
}
