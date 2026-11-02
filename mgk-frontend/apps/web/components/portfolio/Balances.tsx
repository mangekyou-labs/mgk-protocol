'use client';

import type { state } from '@mgk/sdk';
import { PortfolioAmount } from './PortfolioAmount';
export interface BalancesProps {
  data: state.PortfolioState | null;
  loading?: boolean;
  className?: string;
}
export function Balances({ data, loading, className }: BalancesProps) {
  const rows = data
    ? ([
        ['Collateral equity', 'balances-equity', data.equity, 9, 'SOL'],
        [
          'Withdrawable collateral (last chain refresh)',
          'balances-free',
          data.freeCollateral,
          9,
          'SOL',
        ],
        [
          'Order reservations',
          'balances-reserved',
          data.reservedCollateral,
          9,
          'SOL',
        ],
        [
          'Cumulative realized USD PnL',
          'balances-realized-usd',
          data.realizedUsd,
          6,
          'USD',
        ],
        [
          'Cumulative realized SOL PnL',
          'balances-pnl',
          data.realizedLamports,
          9,
          'SOL',
        ],
        ['Fees paid', 'balances-fees', data.feesPaid, 9, 'SOL'],
      ] as const)
    : [];
  return (
    <section
      data-testid="balances"
      data-state={!data ? (loading ? 'loading' : 'unavailable') : 'ready'}
      className={`rounded-md border border-border bg-surface-1 p-4 ${className ?? ''}`}
    >
      <h3 className="text-xs uppercase tracking-wider text-text-muted">
        Collateral
      </h3>
      {!data ? (
        <p className="mt-2 text-text-faint">
          {loading ? 'Loading collateral…' : 'Portfolio unavailable.'}
        </p>
      ) : (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          {rows.map(([label, id, value, decimals, unit]) => (
            <div key={id} className="contents">
              <dt>{label}</dt>
              <dd data-testid={id} className="text-right">
                <PortfolioAmount
                  value={value}
                  decimals={decimals}
                  unit={unit}
                />
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p className="mt-3 text-text-faint">Funding: off</p>
    </section>
  );
}
