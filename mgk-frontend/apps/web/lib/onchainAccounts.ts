'use client';

import { Connection, PublicKey } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';

import { config } from '@/lib/config';

export function resolveRegistryAddress(
  programId: PublicKey,
  registryAddress: PublicKey | null = config.registryAddress,
): PublicKey {
  return registryAddress ?? sdk.deriveRegistryPda(programId)[0];
}

/**
 * Find the open (Collecting/Committing) batch PDA.
 *
 * Registry `batch_id_counter` is usually `openId + 1`, but can lag after
 * partial settles — scan a small window around the counter.
 */
export async function resolveOpenBatch(params: {
  connection: Connection;
  programId: PublicKey;
  batchIdCounter: bigint;
  /** Include the current batch after collection for read-only status displays. */
  includeCompletedPhases?: boolean;
}): Promise<{ batchPda: PublicKey; batchId: bigint; batch: sdk.state.BatchState }> {
  const includeCompletedPhases = params.includeCompletedPhases ?? false;

  const isUsable = (batch: sdk.state.BatchState): boolean => {
    if (batch.status === sdk.state.BatchStatus.Collecting) return true;
    return includeCompletedPhases && (
      batch.status === sdk.state.BatchStatus.Revealing ||
      batch.status === sdk.state.BatchStatus.Clearing ||
      batch.status === sdk.state.BatchStatus.Cleared
    );
  };

  const c = params.batchIdCounter;
  const candidates: bigint[] = [];
  if (c > 0n) candidates.push(c - 1n);
  candidates.push(c);
  if (c > 1n) candidates.push(c - 2n);
  candidates.push(c + 1n);

  let best: { batchPda: PublicKey; batchId: bigint; batch: sdk.state.BatchState } | null =
    null;
  for (const id of candidates) {
    const [pda] = sdk.deriveBatchPda(id, params.programId);
    const acc = await params.connection.getAccountInfo(pda);
    if (!acc || acc.data.length < sdk.state.BATCH_SIZE) continue;
    const batch = sdk.state.decodeBatch(new Uint8Array(acc.data));
    if (!isUsable(batch)) continue;
    if (!best || batch.batchId > best.batchId) {
      best = { batchPda: pda, batchId: batch.batchId, batch };
    }
  }
  if (!best) {
    throw new Error(
      'No open collecting batch found. Wait for the keeper to open the next window.',
    );
  }
  return best;
}


export async function resolveBatchAddress(params: {
  batchId: bigint;
  programId: PublicKey;
}): Promise<PublicKey> {
  return sdk.deriveBatchPda(params.batchId, params.programId)[0];
}
