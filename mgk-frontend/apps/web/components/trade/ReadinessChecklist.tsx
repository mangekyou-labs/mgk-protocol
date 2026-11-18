'use client';

import { useId, type ReactNode } from 'react';
import type * as sdk from '@mgk/sdk';
import { useAutoConnect } from '@/components/wallet/useAutoConnect';
import { WalletButton } from '@/components/wallet/WalletButton';
import { AccountActions } from '@/components/orderform/AccountActions';
import { LowFeeBalance } from '@/components/common/LowFeeBalance';
import { useReadiness } from '@/lib/hooks/useReadiness';
import { friendlyRpcError } from '@/lib/polling';

/** Gates the order form: Connect → Deposit → Trade. Every blocked state shows one reason. */
export function ReadinessChecklist({ portfolio, loading, error, children }: {
  portfolio: sdk.state.PortfolioState | null;
  loading: boolean;
  error?: string | null;
  children: ReactNode;
}) {
  const { connected } = useAutoConnect();
  const funding = useReadiness();
  const headingId = useId();
  const hasCollateral = portfolio !== null && portfolio.equity > 0n;
  const ready = connected && funding.walletLamports !== null && !funding.lowFeeBalance && hasCollateral && !error && !funding.signingBlockedReason;
  if (ready) return <>{children}</>;
  if (!connected) return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 p-3 text-sm text-text-muted">
      <h2 id={headingId} className="text-text">Connect a wallet</h2>
      <WalletButton />
    </section>
  );
  const reason: ReactNode =
    friendlyRpcError(error) ?? friendlyRpcError(funding.error) ?? funding.signingBlockedReason
    ?? (funding.lowFeeBalance ? <LowFeeBalance /> : null)
    ?? (loading || funding.walletLamports === null ? 'Reading collateral from RPC…' : 'Deposit SOL collateral to start trading.');
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 p-3 text-sm text-text-muted">
      <h2 id={headingId} className="text-text">Deposit collateral</h2>
      <p role="status" data-testid="readiness-reason">{reason}</p>
      <AccountActions portfolio={error ? null : portfolio} portfolioLoading={loading || !!error} />
    </section>
  );
}
