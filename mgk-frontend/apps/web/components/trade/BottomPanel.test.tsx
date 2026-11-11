import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomPanel } from './BottomPanel';

vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({ connected: true, publicKey: {} }),
}));
vi.mock('@/lib/stores/usePortfolioStore', () => ({
  usePortfolioPolling: () => ({
    data: { positionsLen: 0 },
    loading: false,
    error: null,
    lastFetchedAt: Date.now(),
  }),
}));
vi.mock('@/components/portfolio/Balances', () => ({
  Balances: () => <div>Collateral ledger</div>,
}));
vi.mock('@/components/portfolio/Positions', () => ({
  Positions: () => <div>Settled positions</div>,
}));
vi.mock('./OpenOrders', () => ({
  OpenOrders: () => <div>Resting orders</div>,
}));
vi.mock('./history/TradeHistory', () => ({
  TradeHistory: () => <div>Confirmed settled fills</div>,
}));

// The panel sits at the bottom of a 1000px tall region.
function renderInRegion() {
  const result = render(
    <div data-testid="region">
      <BottomPanel />
    </div>,
  );
  vi.spyOn(
    screen.getByTestId('region'),
    'getBoundingClientRect',
  ).mockReturnValue({
    top: 0,
    bottom: 1000,
    height: 1000,
    left: 0,
    right: 1000,
    width: 1000,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return result;
}

const handle = () => screen.getByRole('separator', { name: /resize/i });
const panelHeight = () => screen.getByTestId('bottom-panel').style.height;

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('bottom panel', () => {
  it('starts at 30% of the region with the tab content visible', () => {
    renderInRegion();
    expect(panelHeight()).toBe('30%');
    expect(handle()).toHaveAttribute('aria-valuenow', '30');
    expect(screen.getByText('Settled positions')).toBeInTheDocument();
  });

  it('resizes with the arrow keys and keeps within limits', () => {
    renderInRegion();
    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    expect(panelHeight()).toBe('35%');
    fireEvent.keyDown(handle(), { key: 'ArrowDown' });
    fireEvent.keyDown(handle(), { key: 'ArrowDown' });
    expect(panelHeight()).toBe('25%');
    for (let i = 0; i < 20; i++) fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    expect(panelHeight()).toBe('70%');
    for (let i = 0; i < 20; i++)
      fireEvent.keyDown(handle(), { key: 'ArrowDown' });
    expect(panelHeight()).toBe('15%');
  });

  it('resizes by dragging the handle', () => {
    renderInRegion();
    fireEvent.pointerDown(handle(), { clientY: 700, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientY: 500, pointerId: 1 });
    expect(panelHeight()).toBe('50%');
    fireEvent.pointerUp(handle(), { clientY: 500, pointerId: 1 });
    // Moves after release do nothing.
    fireEvent.pointerMove(handle(), { clientY: 900, pointerId: 1 });
    expect(panelHeight()).toBe('50%');
  });

  it('collapses to its tab strip and opens again from a tab', () => {
    renderInRegion();
    fireEvent.click(screen.getByRole('button', { name: 'Hide panel' }));
    expect(screen.queryByTestId('bottom-tabs-content')).toBeNull();
    expect(screen.getByTestId('bottom-tabs-strip')).toBeInTheDocument();
    expect(screen.queryByRole('separator')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Fills' }));
    expect(screen.getByText('Confirmed settled fills')).toBeInTheDocument();
    expect(panelHeight()).toBe('30%');
  });

  it('remembers its height and collapsed state across reloads', () => {
    const first = renderInRegion();
    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    fireEvent.click(screen.getByRole('button', { name: 'Hide panel' }));
    first.unmount();

    renderInRegion();
    expect(screen.queryByTestId('bottom-tabs-content')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show panel' }));
    expect(panelHeight()).toBe('35%');
  });

  it('ignores a corrupt saved value', () => {
    localStorage.setItem('mgk.trade.bottomPanel', '{not json');
    renderInRegion();
    expect(panelHeight()).toBe('30%');
  });
});
