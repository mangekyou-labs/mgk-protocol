'use client';

import { useId, useRef, useState } from 'react';
import type * as sdk from '@mgk/sdk';
import { useAccountActions } from '@/lib/hooks/useAccountActions';
import { useReadiness } from '@/lib/hooks/useReadiness';
import { useAutoConnect } from '@/components/wallet/useAutoConnect';
import { useBatchStore } from '@/lib/stores/useBatchStore';
import { withdrawalEligibility } from '@/lib/withdrawalEligibility';
import { formatSol, formatSolCompact, parseSol } from '@/lib/solAmount';
import { LOW_FEE_BALANCE } from '@/components/common/LowFeeBalance';
import { notifyTxConfirmed, notifyTxFailed } from '@/components/common/TxToast';
import { describeTxError } from '@/lib/txErrors';

type PortfolioState = sdk.state.PortfolioState;
export interface AccountActionsProps {
  portfolio: PortfolioState | null;
  portfolioLoading: boolean;
  className?: string;
}

export function AccountActions({ portfolio, portfolioLoading, className }: AccountActionsProps) {
  const { connected } = useAutoConnect();
  const { deposit, withdraw } = useAccountActions();
  const funding = useReadiness();
  const batch = useBatchStore(s => s.data);
  const registry = useBatchStore(s => s.registry);
  const batchError = useBatchStore(s => s.error);
  const [amountInput, setAmountInput] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const detailsId = useId();
  const [message, setMessage] = useState<string | null>(null);
  // Depositing is step one, so the controls start open until collateral exists; a click overrides that.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? (portfolio === null || portfolio.equity <= 0n);
  const amount = parseSol(amountInput);
  const invalidAmount = amountInput !== '' && amount === null ? 'Enter a positive SOL amount with at most 9 decimals, within the u64 lamport limit.' : null;
  const eligibility = withdrawalEligibility({ portfolio, registry, batch, amount, batchError });
  const withdrawalReason = funding.signingBlockedReason ?? (funding.lowFeeBalance ? LOW_FEE_BALANCE : null) ?? (portfolioLoading ? 'Refreshing collateral…' : null) ?? eligibility.reason;
  async function run(label: { done: string; failed: string }, action: () => Promise<{ sig: string }>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setMessage(null);
    try {
      const { sig } = await action();
      await funding.refresh();
      notifyTxConfirmed(label.done, sig);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage(describeTxError(text)); notifyTxFailed(label.failed, text);
    } finally { pending.current = false; setBusy(false); }
  }
  if (!connected) return null;
  // Signing blocks and low fee balances disable the buttons here, but their reason is shown once by ReadinessChecklist, which replaces the order form whenever either applies.
  const buttonClass = 'rounded border border-border bg-surface-2 px-2 py-2 text-xs text-text disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';
  return (
    <section data-testid="order-form-account-actions" className={`flex flex-col gap-2 border-t border-border pt-2 text-xs text-text-muted ${className ?? ''}`} aria-label="Collateral controls">
      <button type="button" data-testid="account-actions-summary" aria-expanded={open} aria-controls={detailsId} onClick={() => setUserOpen(!open)} className="flex items-center gap-1 rounded py-1 text-left font-mono tabular-nums hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent">
        <span className="min-w-0 flex-1 truncate">Wallet {formatSolCompact(funding.walletLamports)}{funding.walletLamports === null ? '' : ' SOL'} · Collateral {formatSolCompact(portfolio?.equity ?? 0n)} SOL · <span className="text-text">Deposit</span></span>
        <span aria-hidden className={`disclosure-chevron shrink-0 ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>
      {open && <div id={detailsId} className="reveal flex flex-col gap-2">
        {portfolio && <p className="font-mono tabular-nums">{eligibility.withdrawable === null
          ? 'Withdrawable collateral: unavailable at the current conversion price. Simulation checks initial margin and order reservations before you sign.'
          : `Withdrawable collateral: ${formatSol(eligibility.withdrawable)} SOL (net of initial margin and order reservations)`}</p>}
        <label htmlFor="collateral-amount">Collateral amount in SOL</label>
        <input id="collateral-amount" type="text" inputMode="decimal" value={amountInput} onChange={e => setAmountInput(e.target.value)} placeholder="0.1" disabled={busy} className="rounded border border-border bg-surface-2 px-2 py-2 font-mono tabular-nums text-text" data-testid="account-actions-amount" aria-describedby="collateral-reason" />
        <div className="flex gap-2">
          <button type="button" data-testid="account-actions-deposit" className={buttonClass} disabled={busy || portfolioLoading || amount === null || !!funding.signingBlockedReason || funding.lowFeeBalance} onClick={() => amount !== null && void run(portfolio ? { done: 'Deposit confirmed', failed: 'Deposit failed' } : { done: 'Portfolio created and funded', failed: 'Could not create portfolio' }, () => deposit(amount))}>{portfolio ? 'Deposit' : 'Create portfolio and deposit'}</button>
          {portfolio && <button type="button" data-testid="account-actions-withdraw" className={buttonClass} disabled={busy || amount === null || !!withdrawalReason} onClick={() => amount !== null && void run({ done: 'Withdrawal confirmed', failed: 'Withdrawal failed' }, () => withdraw(amount))}>Withdraw</button>}
        </div>
      </div>}
      {/* Outside the fold so a transaction result stays visible after collapsing; it only reserves space while open. */}
      <p id="collateral-reason" role="status" className={open ? 'min-h-8 leading-4' : 'leading-4 empty:hidden'}>{open ? message ?? invalidAmount ?? (portfolio && !funding.signingBlockedReason && !funding.lowFeeBalance ? withdrawalReason : null) : message}</p>
    </section>
  );
}
