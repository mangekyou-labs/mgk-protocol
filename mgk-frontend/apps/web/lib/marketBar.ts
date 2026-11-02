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

/**
 * Why order entry is closed by the batch cycle. `clearing`: the auction is
 * still running. `cleared`: results are fixed and await settlement.
 */
export interface BatchGate {
  phase: 'clearing' | 'cleared';
  batchId: bigint;
}

/** Vault figures that gate new exposure. Open interest in lots, fund in lamports. */
export interface MarketExposure {
  openInterestLong: bigint;
  openInterestShort: bigint;
  insuranceFund: bigint;
}

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

export function lastClearOf(batch: state.BatchState | null, batchId: bigint): ClearPrice | null {
  if (!batch || !batch.markValid || batch.clearingPrice <= 0n) return null;
  return { price: batch.clearingPrice, batchId };
}

/** Posting is blocked from the moment a batch stops collecting until it settles. */
export function batchGate(status: state.BatchStatus, batchId: bigint): BatchGate | null {
  if (status === state.BatchStatus.Clearing) return { phase: 'clearing', batchId };
  if (status === state.BatchStatus.Cleared) return { phase: 'cleared', batchId };
  return null;
}

export function marketExposure(vault: MarketExposure | null): MarketExposure | null {
  if (!vault) return null;
  return {
    openInterestLong: vault.openInterestLong,
    openInterestShort: vault.openInterestShort,
    insuranceFund: vault.insuranceFund,
  };
}
