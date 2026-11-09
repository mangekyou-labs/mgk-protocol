'use client';

import { useEffect, useState, type KeyboardEvent } from 'react';
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
import { moveTabFocus } from './tabKeys';
import { TradeHistory } from './history/TradeHistory';

// Allow multiple 3-second refresh attempts before treating the portfolio as unavailable.
const PORTFOLIO_MAX_AGE_MS = 10_000;

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
  /** Show only the tab strip. Tab content unmounts, so Open orders and Fills stop polling. */
  collapsed?: boolean;
  /** Adds a hide/show button to the strip; a tab click while collapsed also calls it. */
  onToggleCollapsed?: () => void;
}

export function BottomTabs({
  instrumentId = 0,
  mark,
  oracle,
  status,
  className,
  collapsed = false,
  onToggleCollapsed,
}: BottomTabsProps) {
  const [activeTab, setActiveTab] = useState<TabId>('positions');
  const { connected } = useWallet();
  const portfolio = usePortfolioPolling(TRADE_POLL_INTERVAL_MS);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const stale =
    portfolio.lastFetchedAt != null &&
    now - portfolio.lastFetchedAt >= PORTFOLIO_MAX_AGE_MS;
  function select(tab: TabId) {
    setActiveTab(tab);
    if (collapsed) onToggleCollapsed?.();
  }
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = moveTabFocus(event, index, TABS.length);
    if (next !== null) select(TABS[next].id);
  }
  const portfolioMessage = !connected
    ? 'Connect a wallet to view your portfolio.'
    : stale
      ? 'Portfolio unavailable. The last chain refresh is stale; waiting for a fresh RPC read.'
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
      <div className="flex shrink-0 border-b border-border bg-surface-1">
        <div
          role="tablist"
          aria-label="Portfolio"
          data-testid="bottom-tabs-strip"
          className="flex min-w-0 flex-1 overflow-x-auto"
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
              onClick={() => select(tab.id)}
              data-testid="bottom-tab"
              data-tab-id={tab.id}
              data-active={activeTab === tab.id ? 'true' : 'false'}
              className={`whitespace-nowrap border-b-2 px-3 py-2 text-xs transition-colors ${activeTab === tab.id ? 'border-accent text-text' : 'border-transparent text-text-muted hover:text-text'}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls={`panel-${activeTab}`}
            data-testid="bottom-tabs-toggle"
            className="shrink-0 px-3 text-xs text-text-muted hover:text-text"
          >
            <span className="sr-only">
              {collapsed ? 'Show panel' : 'Hide panel'}
            </span>
            <span
              aria-hidden
              className={`disclosure-chevron ${collapsed ? 'rotate-180' : ''}`}
            >
              ▾
            </span>
          </button>
        )}
      </div>
      {!collapsed && (
        <div
          id={`panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`tab-${activeTab}`}
          data-testid="bottom-tabs-content"
          data-active-tab={activeTab}
          className="min-h-0 flex-1 overflow-y-auto p-2 text-xs text-text-muted"
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
      )}
    </div>
  );
}
