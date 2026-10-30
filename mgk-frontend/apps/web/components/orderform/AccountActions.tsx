'use client';

import { useRef, useState } from 'react';
import type * as sdk from '@mgk/sdk';
import { useAccountActions } from '@/lib/hooks/useAccountActions';
import { useReadiness } from '@/lib/hooks/useReadiness';
import { useAutoConnect } from '@/components/wallet/useAutoConnect';
import { useBatchStore } from '@/lib/stores/useBatchStore';
import { withdrawalEligibility } from '@/lib/withdrawalEligibility';
import { formatSol, parseSol } from '@/lib/solAmount';

type PortfolioState = sdk.state.PortfolioState;
export interface AccountActionsProps {
  portfolio: PortfolioState | null;
  portfolioLoading: boolean;
  className?: string;
  onTxSuccess?: (sig: string) => void;
  onTxError?: (error: string) => void;
}

export function AccountActions({ portfolio, portfolioLoading, className, onTxSuccess, onTxError }: AccountActionsProps) {
  const { connected } = useAutoConnect();
  const { deposit, withdraw } = useAccountActions();
  const funding = useReadiness();
  const batch = useBatchStore(s => s.data);
  const registry = useBatchStore(s => s.registry);
  const batchError = useBatchStore(s => s.error);
  const [amountInput, setAmountInput] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const amount = parseSol(amountInput);
  const invalidAmount = amountInput !== '' && amount === null ? 'Enter a positive SOL amount with at most 9 decimals, within the u64 lamport limit.' : null;
  const eligibility = withdrawalEligibility({ portfolio, registry, batch, amount, batchError });
  const withdrawalReason = funding.signingBlockedReason ?? (portfolioLoading ? 'Refreshing collateral…' : null) ?? eligibility.reason;
  async function run(action: () => Promise<{ sig: string }>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setMessage(null);
    try {
      const { sig } = await action();
      setMessage('Confirmed on devnet. Balances refreshed from RPC.');
      await funding.refresh();
      onTxSuccess?.(sig);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage(text); onTxError?.(text);
    } finally { pending.current = false; setBusy(false); }
  }
  if (!connected) return null;
  const buttonClass = 'rounded border border-border bg-surface-2 px-2 py-2 text-xs text-text disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';
  return (
    <section data-testid="order-form-account-actions" className={`flex flex-col gap-2 border-t border-border pt-3 text-xs text-text-muted ${className ?? ''}`} aria-label="Collateral controls">
      <p className="font-mono tabular-nums">Wallet: {formatSol(funding.walletLamports)}{funding.walletLamports === null ? '' : ' SOL'}</p>
      <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(funding.getDevnetSol)}>Get devnet SOL</button>
      <a href="https://faucet.solana.com/" target="_blank" rel="noreferrer" className="underline">Faucet unavailable? Open the Solana devnet faucet</a>
      {funding.error && <p role="status">{funding.error}</p>}
      {portfolio && <p className="font-mono tabular-nums">{eligibility.withdrawable === null
        ? 'Withdrawable collateral: unavailable at the current conversion price. Simulation checks initial margin and order reservations before you sign.'
        : `Withdrawable collateral: ${formatSol(eligibility.withdrawable)} SOL (net of initial margin and order reservations)`}</p>}
      <label htmlFor="collateral-amount">Collateral amount in SOL</label>
      <input id="collateral-amount" type="text" inputMode="decimal" value={amountInput} onChange={e => setAmountInput(e.target.value)} placeholder="0.1" disabled={busy} className="rounded border border-border bg-surface-2 px-2 py-2 font-mono tabular-nums text-text" data-testid="account-actions-amount" aria-describedby="collateral-reason" />
      <div className="flex gap-2">
        <button type="button" data-testid="account-actions-deposit" className={buttonClass} disabled={busy || portfolioLoading || amount === null || !!funding.signingBlockedReason} onClick={() => amount !== null && void run(() => deposit(amount))}>{portfolio ? 'Deposit' : 'Create portfolio and deposit'}</button>
        {portfolio && <button type="button" data-testid="account-actions-withdraw" className={buttonClass} disabled={busy || amount === null || !!withdrawalReason} onClick={() => amount !== null && void run(() => withdraw(amount))}>Withdraw</button>}
      </div>
      <p id="collateral-reason" role="status">{message ?? invalidAmount ?? funding.signingBlockedReason ?? (portfolio ? withdrawalReason : null)}</p>
      <p>Earlier devnet balances were not carried over. This demo market starts fresh.</p>
    </section>
  );
}
