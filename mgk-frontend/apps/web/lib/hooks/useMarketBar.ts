'use client';

import { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import * as sdk from '@mgk/sdk';

import { config } from '@/lib/config';
import { decodeOrNull } from '@/lib/decode';
import {
  batchGate,
  lastClearOf,
  marketExposure,
  readOracle,
  type BatchGate,
  type ClearPrice,
  type MarketExposure,
  type OracleReading,
} from '@/lib/marketBar';
import { NEW_EXPOSURE_PAUSE_MASK, TRADE_POLL_INTERVAL_MS } from '@/lib/protocol';
import { useBatchPolling } from '@/lib/stores/useBatchStore';

export interface MarketBarState {
  oracle: OracleReading;
  /** Most recent cleared batch with a valid mark. */
  lastClear: ClearPrice | null;
  /** Batch collecting orders now; null when unknown or none is open. */
  collectingBatchId: bigint | null;
  /** The batch currently running and its status; null when unknown. */
  currentBatch: { id: bigint; status: sdk.state.BatchStatus } | null;
  /** true/false from the registry pause flags; null when unknown. */
  newExposurePaused: boolean | null;
  /**
   * Set while the current batch is clearing or cleared but not settled.
   * Undefined state is reported as unknown via `currentBatch === null`.
   */
  batchGate: BatchGate | null;
  /** Vault open interest and insurance fund; null when unknown. */
  market: MarketExposure | null;
}

const UNAVAILABLE: OracleReading = { state: 'unavailable', price: null, ageSeconds: null };

/**
 * Market-bar data straight from chain: oracle account, vault, registry pause
 * flags and the current/previous batch. Unknown stays null, never 0.
 */
export function useMarketBar(intervalMs = TRADE_POLL_INTERVAL_MS): MarketBarState {
  const { connection } = useConnection();
  const { data: batch, registry, currentBatchId, error: batchError } = useBatchPolling(intervalMs);
  const [oracle, setOracle] = useState<OracleReading>(UNAVAILABLE);
  const [previous, setPrevious] = useState<ClearPrice | null>(null);
  const [market, setMarket] = useState<MarketExposure | null>(null);

  useEffect(() => {
    let cancelled = false;
    const oracleAddress = config.oracleAddress;
    const tick = async () => {
      const prevId = currentBatchId != null && currentBatchId > 0n ? currentBatchId - 1n : null;
      try {
        // Derivation can throw (bad program id); that reads as unknown, not a crash.
        const vaultAddress = config.vaultAddress ?? sdk.deriveVaultPda(config.coreProgramId)[0];
        const keys = [
          vaultAddress,
          ...(oracleAddress ? [oracleAddress] : []),
          ...(prevId != null ? [sdk.deriveBatchPda(prevId, config.coreProgramId)[0]] : []),
        ];
        const accounts = await connection.getMultipleAccountsInfo(keys);
        if (cancelled) return;
        let i = 0;
        const vault = decodeOrNull(accounts[i++], (data) => sdk.state.decodeAccount('Vault', data));
        setMarket(marketExposure(vault));
        if (oracleAddress) {
          const acc = accounts[i++];
          const owned = acc && acc.owner.equals(config.oracleProgramId) ? acc : null;
          setOracle(readOracle(decodeOrNull(owned, sdk.decodePriceOracle), Math.floor(Date.now() / 1000)));
        }
        if (prevId != null) {
          setPrevious(lastClearOf(decodeOrNull(accounts[i], sdk.state.decodeBatch), prevId));
        }
      } catch {
        if (!cancelled) {
          setOracle(UNAVAILABLE);
          setMarket(null);
        }
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
  const currentBatch =
    known && batch != null && currentBatchId != null ? { id: currentBatchId, status: batch.status } : null;

  return {
    oracle,
    lastClear,
    collectingBatchId:
      currentBatch?.status === sdk.state.BatchStatus.Collecting ? currentBatch.id : null,
    currentBatch,
    newExposurePaused: known ? (registry.pauseFlags & NEW_EXPOSURE_PAUSE_MASK) !== 0 : null,
    batchGate: currentBatch ? batchGate(currentBatch.status, currentBatch.id) : null,
    market,
  };
}
