'use client';

import { formatTradeTime } from '@/components/trade/RecentTrades';
import { Pill } from '@/components/common/Pill';
import { NumberDisplay } from '@/components/common/NumberDisplay';
import { useMyFills } from '@/lib/stores/useMyFillsStore';
import { useWallet } from '@solana/wallet-adapter-react';

export interface TradeHistoryProps {
  instrumentId?: number;
  className?: string;
  indexerState?: 'live' | 'syncing' | 'down' | 'unavailable';
}

function sideTone(side: number): {
  label: 'Long' | 'Short';
  tone: 'bull' | 'bear';
} {
  return side === 0
    ? { label: 'Long', tone: 'bull' }
    : { label: 'Short', tone: 'bear' };
}

function explorerLink(signature: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
}

export function TradeHistory({
  instrumentId = 0,
  className,
  indexerState,
}: TradeHistoryProps) {
  const { publicKey, connected } = useWallet();
  const { fills, loading, error } = useMyFills(instrumentId);

  if (!connected || !publicKey) {
    return (
      <div
        data-testid="trade-history-disconnected"
        className={`text-text-faint px-4 py-8 text-center font-mono text-xs ${className ?? ''}`}
      >
        Connect a wallet to view your trade history.
      </div>
    );
  }

  if (indexerState && indexerState !== 'live') {
    return (
      <p data-testid="trade-history-unavailable" className="p-3 text-warn">
        {indexerState === 'syncing'
          ? 'Indexer syncing — confirmed fill history may be incomplete.'
          : 'Indexer unavailable — confirmed fill history is unavailable.'}
      </p>
    );
  }

  if (error) {
    return (
      <div
        data-testid="trade-history-error"
        className={`text-warn px-3 py-2 text-xs font-mono ${className ?? ''}`}
      >
        Could not load trade history: {error}
      </div>
    );
  }

  if (loading && fills.length === 0) {
    return (
      <div
        data-testid="trade-history-loading"
        className={`text-text-faint px-4 py-8 text-center font-mono text-xs ${className ?? ''}`}
      >
        Loading trade history…
      </div>
    );
  }

  if (fills.length === 0) {
    return (
      <div
        data-testid="trade-history-empty"
        className={`text-text-faint px-4 py-8 text-center font-mono text-xs ${className ?? ''}`}
      >
        You have no trades yet.
      </div>
    );
  }

  return (
    <div
      data-testid="trade-history"
      data-count={fills.length}
      className={`flex flex-col font-mono text-xs ${className ?? ''}`}
    >
      <div
        data-testid="trade-history-header"
        className="text-text-faint grid grid-cols-[100px_70px_70px_1fr_1fr_80px] gap-2 border-b border-border px-2 py-1 text-[10px] uppercase tracking-wider"
      >
        <div>Time</div>
        <div>Role</div>
        <div>Side</div>
        <div className="text-right">Price</div>
        <div className="text-right">Size</div>
        <div className="text-right">Tx</div>
      </div>
      <div data-testid="trade-history-rows" className="flex flex-col">
        {fills.map((f, index) => {
          const { label, tone } = sideTone(
            f.role === 'maker' ? 1 - f.taker_side : f.taker_side,
          );
          return (
            <div
              key={`${f.slot}-${f.tx_signature}-${index}`}
              data-testid="trade-history-row"
              data-slot={f.slot}
              data-role={f.role}
              className="fade-in hover:bg-surface-2 grid grid-cols-[100px_70px_70px_1fr_1fr_80px] items-center gap-2 border-b border-border px-2 py-0.5"
              style={{ minHeight: '22px' }}
            >
              <div
                data-testid="trade-history-time"
                data-timestamp={f.ts_estimate}
                className="text-text-muted"
              >
                {formatTradeTime(f.ts_estimate)}
              </div>
              <div
                data-testid="trade-history-role"
                className={`text-[10px] uppercase tracking-wider ${f.role === 'taker' ? 'text-text' : 'text-text-muted'}`}
              >
                {f.role}
              </div>
              <Pill tone={tone}>{label}</Pill>
              <div
                data-testid="trade-history-price"
                className={`${tone === 'bull' ? 'text-bull' : 'text-bear'} text-right`}
              >
                <NumberDisplay value={f.price} kind="scaled-usd" />
              </div>
              <div
                data-testid="trade-history-qty"
                className="text-text text-right"
              >
                <NumberDisplay value={f.qty} kind="lots" />
              </div>
              <a
                data-testid="trade-history-tx-link"
                href={explorerLink(f.tx_signature)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent text-right text-[10px] uppercase tracking-wider hover:underline"
              >
                {f.slot.toString().slice(-6)}↗
              </a>
            </div>
          );
        })}
      </div>
    </div>
  );
}
