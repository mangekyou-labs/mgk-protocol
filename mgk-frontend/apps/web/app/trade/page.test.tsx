import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { Connection } from '@solana/web3.js';

import TradePage from './page';


vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: vi.fn(),
  useConnection: vi.fn(() => ({
    connection: new Connection('http://localhost:8899'),
  })),
}));

vi.mock('@solana/wallet-adapter-react-ui', () => ({
  useWalletModal: vi.fn(() => ({ visible: false, setVisible: vi.fn() })),
}));

function mockWallet(overrides: Record<string, unknown> = {}) {
  return {
    autoConnect: false,
    wallets: [],
    wallet: null,
    publicKey: null,
    connecting: false,
    connected: false,
    disconnecting: false,
    select: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    sendTransaction: vi.fn(),
    ...overrides,
  };
}

async function mockUseWallet(overrides: Record<string, unknown> = {}) {
  const { useWallet } = await import('@solana/wallet-adapter-react');
  vi.mocked(useWallet).mockReturnValue(mockWallet(overrides) as never);
}

/** Answers `(max-width: Npx)` media queries as a viewport of the given width. */
function setViewportWidth(width: number) {
  window.matchMedia = vi.fn((query: string) => {
    const max = /max-width:\s*([\d.]+)px/.exec(query);
    return {
      matches: max ? width <= Number(max[1]) : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  }) as unknown as typeof window.matchMedia;
}

const originalMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe('trade page by layout', () => {
  it('server render mounts no layout, so a phone never loads the desktop chart first', async () => {
    setViewportWidth(390);
    await mockUseWallet();
    const html = renderToString(<TradePage />);
    expect(html).toContain('data-testid="page-frame"');
    expect(html).not.toContain('data-testid="chart-section"');
    expect(html).not.toContain('data-testid="bottom-panel"');
  });

  it('desktop shows chart, book and form side by side over a resizable bottom panel', async () => {
    setViewportWidth(1440);
    await mockUseWallet();
    render(<TradePage />);
    expect(screen.getByTestId('chart-section')).toBeVisible();
    expect(screen.getByTestId('orderbook-section')).toBeVisible();
    expect(screen.getByTestId('orderform-section')).toBeVisible();
    expect(screen.getByRole('separator', { name: /resize/i })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Chart or book' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Buy' })).toBeNull();
  });

  it('tablet shares one slot between chart and book with a toggle', async () => {
    setViewportWidth(1024);
    await mockUseWallet();
    render(<TradePage />);
    const toggle = screen.getByRole('group', { name: 'Chart or book' });
    expect(within(toggle).getByRole('button', { name: 'Chart' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('chart-section')).toBeVisible();
    expect(screen.getByTestId('orderbook-section')).not.toBeVisible();
    expect(screen.getByTestId('orderform-section')).toBeVisible();

    fireEvent.click(within(toggle).getByRole('button', { name: 'Book' }));
    expect(screen.getByTestId('orderbook-section')).toBeVisible();
    // The chart stays mounted so TradingView does not reload.
    expect(screen.getByTestId('chart-section')).toBeInTheDocument();
    expect(screen.getByTestId('chart-section')).not.toBeVisible();
  });

  it('phone stacks the chart over Book, Trades and Positions tabs', async () => {
    setViewportWidth(390);
    await mockUseWallet();
    render(<TradePage />);
    expect(screen.getByTestId('chart-section')).toBeVisible();
    const tabs = screen.getByRole('tablist', { name: 'Market panels' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Book',
      'Trades',
      'Positions',
    ]);
    expect(screen.getByTestId('orderbook-section')).toBeVisible();
    expect(screen.queryByTestId('bottom-tabs')).toBeNull();

    fireEvent.click(within(tabs).getByRole('tab', { name: 'Positions' }));
    expect(screen.getByTestId('bottom-tabs')).toBeVisible();
    expect(screen.queryByTestId('orderbook-section')).toBeNull();

    fireEvent.click(within(tabs).getByRole('tab', { name: 'Trades' }));
    expect(screen.getByTestId('phone-trades')).toBeVisible();
  });

  it('phone keeps the order form in a closed drawer behind Buy and Sell', async () => {
    setViewportWidth(390);
    await mockUseWallet();
    render(<TradePage />);
    expect(screen.getByRole('button', { name: 'Buy' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sell' })).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('app/trade page', () => {
  it('renders the page frame', async () => {
    await mockUseWallet();
    render(<TradePage />);
    expect(screen.getByTestId('page-frame')).toBeInTheDocument();
  });

  it('renders the market header', async () => {
    await mockUseWallet();
    render(<TradePage />);
    expect(screen.getByTestId('market-header')).toBeInTheDocument();
  });

  it('renders the 3-column trade body', async () => {
    await mockUseWallet();
    render(<TradePage />);
    expect(screen.getByTestId('trade-body')).toBeInTheDocument();
    expect(screen.getByTestId('chart-section')).toBeInTheDocument();
    expect(screen.getByTestId('orderbook-section')).toBeInTheDocument();
    expect(screen.getByTestId('orderform-section')).toBeInTheDocument();
  });

  it('renders the bottom tabs', async () => {
    await mockUseWallet();
    render(<TradePage />);
    expect(screen.getByTestId('bottom-tabs')).toBeInTheDocument();
  });

  it('labels the chart as the Binance reference price and drops the removed extras', async () => {
    await mockUseWallet();
    render(<TradePage />);
    expect(screen.getByTestId('price-chart-label')).toHaveTextContent(
      'Reference price · Binance',
    );
    expect(screen.queryByTestId('ticker-bar')).toBeNull();
    expect(screen.queryByTestId('chart-toolbar')).toBeNull();
    expect(screen.queryByTestId('orderbook-imbalance')).toBeNull();
    expect(screen.queryByRole('tab', { name: /market/i })).toBeNull();
    expect(screen.queryByText(/commit/i)).toBeNull();
  });
});
