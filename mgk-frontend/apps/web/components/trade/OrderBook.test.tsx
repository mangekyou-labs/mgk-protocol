import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as sdk from '@mgk/sdk';

import { OrderBook } from './OrderBook';

type BookLevel = sdk.state.BookLevel;

// Prices are micro-USD (1e6 = $1); qty is integer lots of 0.001 SOL.
function level(price: bigint, totalQty: bigint, orderCount = 1): BookLevel {
  return { price, totalQty, orderCount, firstOrderOffset: 0 };
}

const usd = (dollars: number) => BigInt(Math.round(dollars * 1_000_000));

describe('OrderBook', () => {
  it('shows at most 5 levels per side', () => {
    const bids = [100, 99, 98, 97, 96, 95, 94].map((p) => level(usd(p), 1_000_000n));
    const asks = [101, 102, 103, 104, 105, 106].map((p) => level(usd(p), 1_000_000n));
    render(<OrderBook status="ok" bids={bids} asks={asks} />);
    expect(within(screen.getByTestId('orderbook-bids')).getAllByRole('button')).toHaveLength(5);
    expect(within(screen.getByTestId('orderbook-asks')).getAllByRole('button')).toHaveLength(5);
    // The sixth-best bid ($95) is not shown.
    expect(screen.queryByText('95.00')).toBeNull();
  });

  it('puts the best ask at the bottom of the ask stack and the best bid at the top', () => {
    const bids = [level(usd(99), 1n), level(usd(98), 1n)];
    const asks = [level(usd(101), 1n), level(usd(102), 1n)];
    render(<OrderBook status="ok" bids={bids} asks={asks} />);
    const askPrices = within(screen.getByTestId('orderbook-asks'))
      .getAllByRole('button')
      .map((b) => b.getAttribute('data-price'));
    const bidPrices = within(screen.getByTestId('orderbook-bids'))
      .getAllByRole('button')
      .map((b) => b.getAttribute('data-price'));
    expect(askPrices).toEqual(['102000000', '101000000']);
    expect(bidPrices).toEqual(['99000000', '98000000']);
  });

  it('shows level size in SOL from 0.001-SOL lots', () => {
    render(<OrderBook status="ok" bids={[level(usd(99), 2_500n)]} asks={[level(usd(101), 7n)]} />);
    expect(within(screen.getByTestId('orderbook-bids')).getByRole('button')).toHaveTextContent('2.500');
    expect(within(screen.getByTestId('orderbook-asks')).getByRole('button')).toHaveTextContent('0.007');
  });

  it('states that levels are not fills', () => {
    render(<OrderBook status="ok" bids={[level(usd(99), 1n)]} asks={[]} />);
    expect(screen.getByTestId('orderbook-note')).toHaveTextContent(
      'Batch clears at one price. Levels are not fills.',
    );
  });

  it('shows the last clear price labelled with its batch', () => {
    render(
      <OrderBook
        status="ok"
        bids={[level(usd(99), 1n)]}
        asks={[level(usd(101), 1n)]}
        lastClear={{ price: usd(100.25), batchId: 41n }}
      />,
    );
    expect(screen.getByTestId('orderbook-last-clear')).toHaveTextContent('Last clear $100.25 · b41');
  });

  it('says the last clear is unknown rather than $0 when no batch has cleared', () => {
    render(<OrderBook status="ok" bids={[level(usd(99), 1n)]} asks={[]} lastClear={null} />);
    const last = screen.getByTestId('orderbook-last-clear');
    expect(last).toHaveTextContent('Last clear --');
    expect(last).not.toHaveTextContent('0.00');
  });

  it('marks levels holding one of your orders with "● you"', () => {
    render(
      <OrderBook
        status="ok"
        bids={[level(usd(99), 2_000_000n), level(usd(98), 1_000_000n)]}
        asks={[level(usd(101), 1_000_000n)]}
        ownPrices={{ bids: [usd(98)], asks: [] }}
      />,
    );
    const bidButtons = within(screen.getByTestId('orderbook-bids')).getAllByRole('button');
    expect(bidButtons[0]).not.toHaveTextContent('● you');
    expect(bidButtons[1]).toHaveTextContent('● you');
    expect(within(screen.getByTestId('orderbook-asks')).getByRole('button')).not.toHaveTextContent('● you');
  });

  it('passes the clicked level price to onSelectPrice', () => {
    const onSelectPrice = vi.fn();
    render(
      <OrderBook
        status="ok"
        bids={[level(usd(99.5), 1n)]}
        asks={[level(usd(101), 1n)]}
        onSelectPrice={onSelectPrice}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /99\.50/ }));
    expect(onSelectPrice).toHaveBeenCalledWith(usd(99.5));
  });

  it('shows the empty state when no orders are on the book', () => {
    render(<OrderBook status="ok" bids={[]} asks={[]} />);
    expect(screen.getByTestId('orderbook-empty')).toHaveTextContent('No orders on the book.');
  });

  it('shows the book as unavailable, not empty, when the source is down', () => {
    render(<OrderBook status="unavailable" bids={[]} asks={[]} />);
    expect(screen.getByTestId('orderbook-unavailable')).toHaveTextContent(/Order book unavailable/);
    expect(screen.queryByTestId('orderbook-empty')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('flags delayed levels with how far behind they are', () => {
    render(
      <OrderBook
        status="delayed"
        ageSeconds={12}
        bids={[level(usd(99), 1n)]}
        asks={[]}
      />,
    );
    expect(screen.getByTestId('orderbook')).toHaveAttribute('data-delayed', 'true');
    expect(screen.getByTestId('orderbook-freshness')).toHaveTextContent('Delayed · last update 12s ago');
  });

  it('says the age is unknown when no update time is known', () => {
    render(<OrderBook status="delayed" ageSeconds={null} bids={[level(usd(99), 1n)]} asks={[]} />);
    expect(screen.getByTestId('orderbook-freshness')).toHaveTextContent('Delayed · age unknown');
  });

  it('shows a loading state, not an empty book, before the first read', () => {
    render(<OrderBook status="loading" bids={[]} asks={[]} />);
    expect(screen.getByTestId('orderbook-loading')).toHaveTextContent('Loading book');
    expect(screen.queryByTestId('orderbook-empty')).toBeNull();
  });

  it('has no depth extras: no spread row, cumulative totals or imbalance bar', () => {
    render(
      <OrderBook status="ok" bids={[level(usd(99), 5n)]} asks={[level(usd(101), 3n)]} />,
    );
    expect(screen.queryByTestId('orderbook-spread')).toBeNull();
    expect(screen.queryByTestId('orderbook-imbalance')).toBeNull();
    expect(screen.queryByText(/total/i)).toBeNull();
  });
});
