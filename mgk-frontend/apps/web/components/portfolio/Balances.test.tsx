import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { state } from '@mgk/sdk';
import { Balances } from './Balances';
describe('Collateral ledger', () => {
  it('shows exact cumulative USD and SOL realized PnL and fees from the portfolio', () => {
    render(
      <Balances
        data={
          {
            equity: 1_000_000_000n,
            freeCollateral: 900_000_000n,
            reservedCollateral: 50_000_000n,
            realizedUsd: -1n,
            realizedLamports: -1n,
            feesPaid: 1n,
          } as state.PortfolioState
        }
      />,
    );
    expect(screen.getByText('Collateral')).toBeInTheDocument();
    expect(screen.getByTestId('balances-realized-usd')).toHaveTextContent(
      '-0.000001 USD',
    );
    expect(screen.getByTestId('balances-pnl')).toHaveTextContent(
      '-0.000000001 SOL',
    );
    expect(screen.getByTestId('balances-fees')).toHaveTextContent(
      '0.000000001 SOL',
    );
    expect(screen.getByText('Funding: off')).toBeInTheDocument();
  });
  it('does not turn a missing portfolio into zero balances', () => {
    render(<Balances data={null} />);
    expect(screen.getByText(/portfolio unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText('0.000000000 SOL')).not.toBeInTheDocument();
  });
});
