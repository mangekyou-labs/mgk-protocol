import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { state } from '@mgk/sdk';
import { Positions } from './Positions';
const data = {
  positionsLen: 1,
  equity: 500_000_000n,
  positions: [
    {
      instrumentId: 0,
      qty: 1000n,
      entryVwap: 100_000_000n,
      entryRemainder: 0n,
      entryDenominator: 0n,
    },
  ],
} as state.PortfolioState;
const oracle = { state: 'valid' as const, price: 125_000_000n, ageSeconds: 0 };
describe('Positions', () => {
  it('labels unpaid USD at its DFBA batch and SOL as estimated, with oracle priced risk', () => {
    render(
      <Positions
        data={data}
        mark={{ price: 120_000_000n, batchId: 8n }}
        oracle={oracle}
      />,
    );
    expect(screen.getByText(/DFBA mark.*batch 8/i)).toBeInTheDocument();
    expect(screen.getByTestId('position-pnl')).toHaveTextContent('20.00 USD');
    expect(screen.getByTestId('position-sol-pnl')).toHaveTextContent(
      '0.160000000 SOL estimate',
    );
    expect(screen.getByText(/health.*oracle/i)).toBeInTheDocument();
    expect(screen.getByText(/liquidation.*oracle/i)).toBeInTheDocument();
    expect(screen.getByTestId('position-liq')).toHaveTextContent('71.428571');
  });
  it('makes missing marks and stale oracle estimates unavailable, never zero', () => {
    render(<Positions data={data} oracle={{ ...oracle, state: 'stale' }} />);
    for (const id of [
      'position-pnl',
      'position-sol-pnl',
      'position-health',
      'position-liq',
    ]) {
      expect(screen.getByTestId(id)).toHaveTextContent('Unavailable');
    }
  });
  it('separates loading, unavailable portfolio and known empty positions', () => {
    const { rerender } = render(<Positions data={null} loading />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    rerender(<Positions data={null} />);
    expect(screen.getByText(/portfolio unavailable/i)).toBeInTheDocument();
    rerender(<Positions data={{ ...data, positionsLen: 0 }} />);
    expect(screen.getByText(/no open positions/i)).toBeInTheDocument();
  });
  it('shows a known zero PnL and preserves a nonzero fractional USD loss', () => {
    const { rerender } = render(
      <Positions
        data={data}
        mark={{ price: 100_000_000n, batchId: 8n }}
        oracle={oracle}
      />,
    );
    expect(screen.getByTestId('position-pnl')).toHaveTextContent('0.00 USD');
    rerender(
      <Positions
        data={{
          ...data,
          positions: [
            {
              ...data.positions[0],
              qty: 1n,
              entryRemainder: 500_000_000_000n,
              entryDenominator: 1_000_000_000_000n,
            },
          ],
        }}
        mark={{ price: 100_000_000n, batchId: 8n }}
        oracle={oracle}
      />,
    );
    expect(
      within(screen.getByTestId('position-pnl')).getByText(/-0.000001/),
    ).toBeInTheDocument();
  });
});
