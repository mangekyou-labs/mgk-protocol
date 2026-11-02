import * as sdk from '@mgk/sdk';

const { BatchStatus } = sdk.state;

/**
 * Lifecycle tag for the user's last accepted order. Only states the chain or
 * indexer has confirmed: a fill is claimed only when one is reported for the
 * order's batch, and settlement only once that batch has settled.
 */
export function orderLifecycle({
  acceptedBatchId,
  currentBatchId,
  currentStatus,
  filled,
}: {
  acceptedBatchId: bigint;
  currentBatchId: bigint | null;
  currentStatus: sdk.state.BatchStatus | null;
  /** A fill for this user was reported in the accepted batch. */
  filled: boolean;
}): string {
  const n = acceptedBatchId.toString();
  const past = currentBatchId != null && currentBatchId > acceptedBatchId;
  const same = currentBatchId === acceptedBatchId;
  const settled = past || (same && currentStatus === BatchStatus.Settled);

  if (settled) return filled ? `Settled · batch ${n}` : `Resting · not filled in batch ${n}`;
  if (filled) return 'Filled · awaiting settlement';
  if (same && (currentStatus === BatchStatus.Clearing || currentStatus === BatchStatus.Cleared)) {
    return `Accepted · batch ${n} clearing`;
  }
  return `Accepted · resting in batch ${n}`;
}
