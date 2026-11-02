import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BottomTabs } from './BottomTabs';
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({ connected: true, publicKey: {} }),
}));
vi.mock('@/lib/stores/usePortfolioStore', () => ({
  usePortfolioPolling: () => ({
    data: { positionsLen: 0 },
    loading: false,
    error: null,
    lastFetchedAt: 1,
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
describe('restricted demo tabs', () => {
  it('offers exactly Positions, Open orders, Fills and Collateral and shows each selected panel', () => {
    render(<BottomTabs />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Positions',
      'Open orders',
      'Fills',
      'Collateral',
    ]);
    for (const [tab, panel] of [
      ['Positions', 'Settled positions'],
      ['Open orders', 'Resting orders'],
      ['Fills', 'Confirmed settled fills'],
      ['Collateral', 'Collateral ledger'],
    ]) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      expect(screen.getByRole('tab', { name: tab })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByText(panel)).toBeInTheDocument();
    }
    expect(screen.queryByText('Funding History')).not.toBeInTheDocument();
  });
});
