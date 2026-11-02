'use client';

import { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import * as sdk from '@mgk/sdk';

import type { OracleReading } from '@/components/trade/MarketHeader';
import { config } from '@/lib/config';
import { lastClearOf, NEW_EXPOSURE_PAUSE_MASK, readOracle } from '@/lib/marketBar';
import { useBatchPolling } from '@/lib/stores/useBatchStore';

export interface MarketBarState {
  oracle: OracleReading;
  /** Most recent cleared batch with a valid mark. */
  lastClear: { price: bigint; batchId: bigint } | null;
  /** Batch collecting orders now; null when unknown or none is open. */
  collectingBatchId: bigint | null;
  /** true/false from the registry pause flags; null when unknown. */
  newExposurePaused: boolean | null;
  /** true when the current batch has cleared but not yet settled. */
  batchUnsettled: boolean | null;
}

const UNAVAILABLE: OracleReading = { state: 'unavailable', price: null, ageSeconds: null };

/**
 * Market-bar data straight from chain: oracle account, registry pause flags
 * and the current/previous batch. Unknown stays null, never 0.
 */
export function useMarketBar(intervalMs = 3000): MarketBarState {
  const { connection } = useConnection();
  const { data: batch, registry, currentBatchId, error: batchError } = useBatchPolling(intervalMs);
  const [oracle, setOracle] = useState<OracleReading>(UNAVAILABLE);
  const [previous, setPrevious] = useState<{ price: bigint; batchId: bigint } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const oracleAddress = config.oracleAddress;
    const tick = async () => {
      const prevId = currentBatchId != null && currentBatchId > 0n ? currentBatchId - 1n : null;
      const keys = [
        ...(oracleAddress ? [oracleAddress] : []),
        ...(prevId != null ? [sdk.deriveBatchPda(prevId, config.coreProgramId)[0]] : []),
      ];
      if (keys.length === 0) return;
      try {
        const accounts = await connection.getMultipleAccountsInfo(keys);
        if (cancelled) return;
        let i = 0;
        if (oracleAddress) {
          const acc = accounts[i++];
          let decoded: sdk.DecodedPriceOracle | null = null;
          try {
            decoded = acc && acc.owner.equals(config.oracleProgramId) ? sdk.decodePriceOracle(new Uint8Array(acc.data)) : null;
          } catch {
            decoded = null;
          }
          setOracle(readOracle(decoded, Math.floor(Date.now() / 1000)));
        }
        if (prevId != null) {
          const acc = accounts[i];
          let decoded: sdk.state.BatchState | null = null;
          try {
            decoded = acc ? sdk.state.decodeBatch(new Uint8Array(acc.data)) : null;
          } catch {
            decoded = null;
          }
          setPrevious(lastClearOf(decoded, prevId));
        }
      } catch {
        if (!cancelled) setOracle(UNAVAILABLE);
      }
    };
    void tick();
    const handle = setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [connection, currentBatchId, intervalMs]);

  const status = batch?.status;
  const currentCleared =
    status === sdk.state.BatchStatus.Cleared || status === sdk.state.BatchStatus.Settled;
  const lastClear =
    (currentCleared && currentBatchId != null ? lastClearOf(batch, currentBatchId) : null) ?? previous;
  const known = !batchError && registry != null;

  return {
    oracle,
    lastClear,
    collectingBatchId:
      status === sdk.state.BatchStatus.Collecting && currentBatchId != null ? currentBatchId : null,
    newExposurePaused: known ? (registry.pauseFlags & NEW_EXPOSURE_PAUSE_MASK) !== 0 : null,
    batchUnsettled: known
      ? status === sdk.state.BatchStatus.Clearing || status === sdk.state.BatchStatus.Cleared
      : null,
  };
}
