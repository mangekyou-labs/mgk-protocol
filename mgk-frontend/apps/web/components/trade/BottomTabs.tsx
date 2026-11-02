'use client';

import { useState, type KeyboardEvent } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Balances } from '@/components/portfolio/Balances';
import { Positions } from '@/components/portfolio/Positions';
import {
  indexerState,
  type ProtocolStatusReading,
} from '@/lib/hooks/useProtocolStatus';
import type { ClearPrice, OracleReading } from '@/lib/marketBar';
import { TRADE_POLL_INTERVAL_MS } from '@/lib/protocol';
import { usePortfolioPolling } from '@/lib/stores/usePortfolioStore';
import { OpenOrders } from './OpenOrders';
import { TradeHistory } from './history/TradeHistory';

const TABS = [
  { id: 'positions', label: 'Positions' },
  { id: 'open-orders', label: 'Open orders' },
  { id: 'fills', label: 'Fills' },
  { id: 'collateral', label: 'Collateral' },
] as const;
export type TabId = (typeof TABS)[number]['id'];
export interface BottomTabsProps {
  instrumentId?: number;
  mark?: ClearPrice | null;
  oracle?: OracleReading;
  status?: ProtocolStatusReading;
  className?: string;
}

export function BottomTabs({
  instrumentId = 0,
  mark,
  oracle,
  status,
  className,
}: BottomTabsProps) {
  const [activeTab, setActiveTab] = useState<TabId>('positions');
  const { connected } = useWallet();
  const portfolio = usePortfolioPolling(TRADE_POLL_INTERVAL_MS);
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft')
      next = (index + TABS.length - 1) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    setActiveTab(TABS[next].id);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role=tab]')
      [next]?.focus();
  }
  const portfolioMessage = !connected
    ? 'Connect a wallet to view your portfolio.'
    : portfolio.error
      ? 'Portfolio unavailable. Retry when RPC connectivity recovers.'
      : portfolio.loading && !portfolio.data
        ? 'Loading portfolio…'
        : !portfolio.data
          ? portfolio.lastFetchedAt == null
            ? 'Portfolio unavailable.'
            : 'No portfolio yet — deposit SOL to start trading.'
          : null;
  return (
    <div
      data-testid="bottom-tabs"
      className={`flex flex-col ${className ?? ''}`}
    >
      <div
        role="tablist"
        aria-label="Portfolio"
        data-testid="bottom-tabs-strip"
        className="flex overflow-x-auto border-b border-border bg-surface-1"
      >
        {TABS.map((tab, index) => (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            role="tab"
            aria-controls={`panel-${tab.id}`}
            aria-selected={activeTab === tab.id}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onKeyDown={(e) => navigate(e, index)}
            onClick={() => setActiveTab(tab.id)}
            data-testid="bottom-tab"
            data-tab-id={tab.id}
            data-active={activeTab === tab.id ? 'true' : 'false'}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-xs transition-colors ${activeTab === tab.id ? 'border-accent text-text' : 'border-transparent text-text-muted hover:text-text'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id={`panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`tab-${activeTab}`}
        data-testid="bottom-tabs-content"
        data-active-tab={activeTab}
        className="p-2 text-xs text-text-muted"
      >
        {activeTab === 'positions' || activeTab === 'collateral' ? (
          portfolioMessage ? (
            <p className="p-3">{portfolioMessage}</p>
          ) : activeTab === 'positions' ? (
            <Positions
              data={portfolio.data}
              loading={portfolio.loading}
              mark={mark}
              oracle={oracle}
            />
          ) : (
            <Balances data={portfolio.data} loading={portfolio.loading} />
          )
        ) : activeTab === 'open-orders' ? (
          <OpenOrders instrumentId={instrumentId} />
        ) : (
          <TradeHistory
            instrumentId={instrumentId}
            indexerState={status ? indexerState(status) : 'unavailable'}
          />
        )}
      </div>
    </div>
  );
}
