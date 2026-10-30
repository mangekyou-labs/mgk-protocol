'use client';

import type { ReactNode } from 'react';
import type * as sdk from '@mgk/sdk';
import { useAutoConnect } from '@/components/wallet/useAutoConnect';
import { WalletButton } from '@/components/wallet/WalletButton';
import { AccountActions } from '@/components/orderform/AccountActions';
import { useReadiness } from '@/lib/hooks/useReadiness';

export function ReadinessChecklist({ portfolio, loading, error, children, onTxSuccess, onTxError }: {
  portfolio: sdk.state.PortfolioState | null;
  loading: boolean;
  error?: string | null;
  children: ReactNode;
  onTxSuccess?: (sig: string) => void;
  onTxError?: (error: string) => void;
}) {
  const { connected } = useAutoConnect();
  const funding = useReadiness();
  const hasSol = funding.walletLamports !== null && funding.walletLamports > 0n;
  const hasCollateral = portfolio !== null && portfolio.equity > 0n;
  const ready = connected && hasSol && hasCollateral && !error && !funding.signingBlockedReason;
  if (ready) return <><p className="mb-2 text-xs text-text-muted">Wallet connected, ready</p>{children}</>;
  return (
    <section aria-label="Trading readiness" className="flex flex-col gap-3 p-3 text-sm text-text-muted">
      <h2 className="text-text">{connected ? 'Wallet connected, not ready' : 'Get ready to trade'}</h2>
      <ol className="space-y-2">
        <li>{connected ? '✓' : '1.'} Connect a wallet</li>
        <li>{hasSol ? '✓' : '2.'} Get devnet SOL for transaction fees</li>
        <li>{hasCollateral ? '✓' : '3.'} Create a portfolio and deposit SOL collateral</li>
      </ol>
      {!connected && <WalletButton />}
      {connected && <>
        <p role="status">{error ?? funding.error ?? funding.signingBlockedReason ?? (loading ? 'Reading collateral from RPC…' : !hasSol ? 'Devnet SOL is needed before trading.' : 'Deposit SOL collateral to become ready.')}</p>
        <AccountActions portfolio={error ? null : portfolio} portfolioLoading={loading || !!error} onTxSuccess={onTxSuccess} onTxError={onTxError} />
      </>}
      <p className="text-xs">Earlier devnet balances were not carried over. This demo market starts fresh.</p>
    </section>
  );
}
