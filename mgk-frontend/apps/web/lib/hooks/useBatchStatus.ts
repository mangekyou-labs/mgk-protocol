'use client';

import { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import * as sdk from '@mgk/sdk';

import { config } from '@/lib/config';
import { decodeOrNull } from '@/lib/decode';
import { FAILURE_THRESHOLD } from '@/lib/polling';
import { TRADE_POLL_INTERVAL_MS } from '@/lib/protocol';

/**
 * Polls one batch account and returns its own status. null while unknown:
 * no batch id, account missing, undecodable, or reads keep failing.
 */
export function useBatchStatus(
  batchId: bigint | null,
  intervalMs = TRADE_POLL_INTERVAL_MS,
): sdk.state.BatchStatus | null {
  const { connection } = useConnection();
  const [reading, setReading] = useState<{ batchId: bigint; status: sdk.state.BatchStatus | null } | null>(null);

  useEffect(() => {
    if (batchId == null) return;
    let cancelled = false;
    let failures = 0;
    const address = sdk.deriveBatchPda(batchId, config.coreProgramId, config.marketContext)[0];
    const tick = async () => {
      try {
        const acc = await connection.getAccountInfo(address);
        if (cancelled) return;
        failures = 0;
        setReading({ batchId, status: decodeOrNull(acc, sdk.state.decodeBatch)?.status ?? null });
      } catch {
        // Keep the last status through transient misses; drop it once they persist.
        if (!cancelled && ++failures >= FAILURE_THRESHOLD) setReading({ batchId, status: null });
      }
    };
    void tick();
    const handle = setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [connection, batchId, intervalMs]);

  return reading && reading.batchId === batchId ? reading.status : null;
}
