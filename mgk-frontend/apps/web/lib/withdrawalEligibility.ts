import { state } from '@mgk/sdk';

/** Use decoded, owner-validated snapshots. Risk is refreshed on-chain by Withdraw. */
export function withdrawalEligibility({ portfolio, registry, batch, amount, batchError = null }: {
  portfolio: state.PortfolioState | null;
  registry: state.RegistryState | null;
  batch: state.BatchState | null;
  amount: bigint | null;
  batchError?: string | null;
}): { withdrawable: bigint | null; reason: string | null } {
  // The flat/no-reservation entrypoint clears risk PnL and initial margin before
  // recalculating. Otherwise persisted freeCollateral can be stale at a new price.
  const withdrawable = portfolio && portfolio.positions.length === 0 && portfolio.reservedCollateral === 0n
    ? (portfolio.equity > 0n ? portfolio.equity : 0n) : null;
  let reason: string | null = null;
  if (!portfolio) reason = 'No portfolio to withdraw from.';
  else if (batchError || !registry || (registry.batchIdCounter > 0n && !batch)) reason = 'Current batch status unavailable. Retry when RPC has recovered.';
  else if ((registry.pauseFlags & 2) !== 0) reason = 'Withdrawals are paused. Wait for the operator to restore withdrawals.';
  else if (registry.batchIdCounter > 0n && batch?.status === state.BatchStatus.Cleared) reason = 'Withdrawals blocked: batch Cleared, awaiting settlement.';
  else if (amount !== null && withdrawable !== null && amount > withdrawable) reason = 'Amount exceeds withdrawable collateral, net of initial margin and order reservations.';
  return { withdrawable, reason };
}
