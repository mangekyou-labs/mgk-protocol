'use client';

import * as sdk from '@mgk/sdk';

import { NumberDisplay } from '@/components/common/NumberDisplay';
import type { ClearPrice, OrderBookStatus } from '@/lib/marketBar';

type BookLevel = sdk.state.BookLevel;

/** Levels shown per side. The batch auction only needs the top of book. */
export const BOOK_LEVELS_PER_SIDE = 5;

export interface OrderBookProps {
  status: OrderBookStatus;
  bids: BookLevel[];
  asks: BookLevel[];
  /** Seconds since the last successful book read. null = unknown. */
  ageSeconds?: number | null;
  /** Most recent cleared batch. null/undefined = no clear known yet. */
  lastClear?: ClearPrice | null;
  /** Prices of the connected wallet's own orders on the book, per side. */
  ownPrices?: { bids: bigint[]; asks: bigint[] };
  onSelectPrice?: (price: bigint) => void;
  className?: string;
}

const BOOK_NOTE = 'Batch clears at one price. Levels are not fills.';

export function OrderBook({
  status,
  bids,
  asks,
  ageSeconds = null,
  lastClear = null,
  ownPrices,
  onSelectPrice,
  className,
}: OrderBookProps) {
  if (status === 'loading') {
    return (
      <div
        data-testid="orderbook-loading"
        className={`px-4 py-8 text-center font-mono text-xs text-text-faint ${className ?? ''}`}
      >
        Loading book…
      </div>
    );
  }

  if (status === 'unavailable') {
    return (
      <div
        data-testid="orderbook-unavailable"
        className={`px-4 py-8 text-center font-mono text-xs text-text-muted ${className ?? ''}`}
      >
        Order book unavailable: data source not responding.
        <br />
        <span className="text-text-faint">
          Your orders still submit; prices here are unknown, not empty.
        </span>
      </div>
    );
  }

  const topBids = bids.slice(0, BOOK_LEVELS_PER_SIDE);
  // Asks arrive best (lowest) first; show the best ask at the bottom,
  // next to the last clear line.
  const topAsks = asks.slice(0, BOOK_LEVELS_PER_SIDE).reverse();
  const ownBids = new Set((ownPrices?.bids ?? []).map(String));
  const ownAsks = new Set((ownPrices?.asks ?? []).map(String));
  const delayed = status === 'delayed';

  return (
    <div
      data-testid="orderbook"
      data-delayed={delayed ? 'true' : 'false'}
      className={`flex flex-col font-mono text-xs ${className ?? ''}`}
    >
      <div className="flex flex-col gap-0.5 border-b border-border px-2 py-1.5">
        <div className="flex items-center gap-1 text-[11px] text-text-muted">
          <span>Order book</span>
          <span
            data-testid="orderbook-note"
            role="note"
            tabIndex={0}
            title={BOOK_NOTE}
            aria-label={BOOK_NOTE}
            className="cursor-help text-text-faint focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            ⓘ
          </span>
        </div>
        {delayed ? (
          <p data-testid="orderbook-freshness" className="text-[11px] text-warn">
            {ageSeconds == null ? 'Delayed · age unknown' : `Delayed · last update ${ageSeconds}s ago`}
          </p>
        ) : null}
      </div>
      <div className="grid grid-cols-2 px-2 py-1 text-[10px] uppercase tracking-wider text-text-faint">
        <span>Price</span>
        <span className="text-right">Size (SOL)</span>
      </div>
      {topBids.length === 0 && topAsks.length === 0 ? (
        <div
          data-testid="orderbook-empty"
          className="px-4 py-8 text-center text-text-faint"
        >
          No orders on the book.
        </div>
      ) : (
        <div className={delayed ? 'opacity-60' : undefined}>
          <div data-testid="orderbook-asks" className="flex flex-col">
            {topAsks.map((l) => (
              <LevelButton
                key={`ask-${l.price}`}
                level={l}
                side="ask"
                own={ownAsks.has(String(l.price))}
                onSelectPrice={onSelectPrice}
              />
            ))}
          </div>
          <LastClear lastClear={lastClear} />
          <div data-testid="orderbook-bids" className="flex flex-col">
            {topBids.map((l) => (
              <LevelButton
                key={`bid-${l.price}`}
                level={l}
                side="bid"
                own={ownBids.has(String(l.price))}
                onSelectPrice={onSelectPrice}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LevelButton({
  level,
  side,
  own,
  onSelectPrice,
}: {
  level: BookLevel;
  side: 'bid' | 'ask';
  own: boolean;
  onSelectPrice?: (price: bigint) => void;
}) {
  return (
    <button
      type="button"
      data-price={level.price.toString()}
      data-side={side}
      onClick={() => onSelectPrice?.(level.price)}
      className="grid min-h-6 grid-cols-2 px-2 py-0.5 text-left hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span className={side === 'bid' ? 'text-bull' : 'text-bear'}>
        <NumberDisplay value={level.price} kind="scaled-usd" className="text-inherit" />
        {own ? <span className="ml-1.5 text-[10px] text-text">● you</span> : null}
      </span>
      <span className="text-right">
        <NumberDisplay value={level.totalQty} kind="lots" />
      </span>
    </button>
  );
}

function LastClear({ lastClear }: { lastClear: OrderBookProps['lastClear'] }) {
  return (
    <div
      data-testid="orderbook-last-clear"
      className="border-y border-border bg-surface-1 px-2 py-1 text-text-muted"
    >
      {lastClear ? (
        <>
          Last clear ${formatUsd(lastClear.price)} · b{lastClear.batchId.toString()}
        </>
      ) : (
        'Last clear --'
      )}
    </div>
  );
}

function formatUsd(micro: bigint): string {
  return (Number(micro) / 1_000_000).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
