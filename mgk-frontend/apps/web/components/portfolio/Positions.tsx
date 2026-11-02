'use client';

import type { state } from '@mgk/sdk';
import { NumberDisplay } from '@/components/common/NumberDisplay';
import { Pill } from '@/components/common/Pill';
import type { ClearPrice, OracleReading } from '@/lib/marketBar';
import { valuePosition } from '@/lib/positionValuation';
import { PortfolioAmount } from './PortfolioAmount';

export interface PositionsProps {
  data: state.PortfolioState | null;
  mark?: ClearPrice | null;
  oracle?: OracleReading;
  loading?: boolean;
  className?: string;
}
const UNAVAILABLE: OracleReading = {
  state: 'unavailable',
  price: null,
  ageSeconds: null,
};

export function Positions({
  data,
  mark = null,
  oracle = UNAVAILABLE,
  loading,
  className,
}: PositionsProps) {
  const rows = data?.positions.slice(0, data.positionsLen) ?? [];
  const message = !data
    ? loading
      ? 'Loading positions…'
      : 'Portfolio unavailable.'
    : rows.length === 0
      ? 'You have no open positions yet.'
      : null;
  return (
    <section
      data-testid="positions"
      data-state={
        !data
          ? loading
            ? 'loading'
            : 'unavailable'
          : rows.length
            ? 'ready'
            : 'empty'
      }
      className={`rounded-md border border-border bg-surface-1 p-3 ${className ?? ''}`}
    >
      <h3 className="text-xs uppercase tracking-wider text-text-muted">
        Positions
      </h3>
      {message ? (
        <p className="mt-2 text-text-faint">{message}</p>
      ) : (
        <>
          <p className="my-2 text-text-muted">
            Unrealized PnL ·{' '}
            {mark && mark.price > 0n && mark.batchId >= 0n
              ? `DFBA mark, batch ${mark.batchId}`
              : 'DFBA mark unavailable'}{' '}
            · unpaid
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-text-faint">
                <tr>
                  {[
                    'Side',
                    'Size (SOL)',
                    'Entry (USD)',
                    'Unrealized PnL (USD)',
                    'SOL PnL estimate',
                    'Health (oracle, SOL)',
                    'Liquidation price (oracle, USD)',
                  ].map((label) => (
                    <th key={label} className="p-2 text-right font-normal">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((position, i) => {
                  // The restricted demo has one SOL-PERP position. Other layouts fail closed.
                  const value =
                    rows.length === 1 && position.instrumentId === 0
                      ? valuePosition(position, data!.equity, mark, oracle)
                      : null;
                  return (
                    <tr
                      key={`${position.instrumentId}-${i}`}
                      data-testid="position-row"
                      className="border-t border-border"
                    >
                      <td className="p-2">
                        <Pill tone={position.qty > 0n ? 'bull' : 'bear'}>
                          {position.qty > 0n ? 'Long' : 'Short'}
                        </Pill>
                      </td>
                      <td className="p-2 text-right">
                        <NumberDisplay value={position.qty} kind="lots" />
                      </td>
                      <td className="p-2 text-right">
                        <PortfolioAmount
                          value={
                            position.entryVwap > 0n ? position.entryVwap : null
                          }
                          decimals={6}
                          unit="USD"
                        />
                      </td>
                      <td className="p-2 text-right" data-testid="position-pnl">
                        <PortfolioAmount
                          value={value?.unrealizedUsd ?? null}
                          decimals={6}
                          unit="USD"
                        />
                      </td>
                      <td
                        className="p-2 text-right"
                        data-testid="position-sol-pnl"
                      >
                        <PortfolioAmount
                          value={value?.estimatedLamports ?? null}
                          decimals={9}
                          unit="SOL estimate"
                        />
                      </td>
                      <td
                        className="p-2 text-right"
                        data-testid="position-health"
                      >
                        <PortfolioAmount
                          value={value?.health ?? null}
                          decimals={9}
                          unit="SOL"
                        />
                      </td>
                      <td className="p-2 text-right" data-testid="position-liq">
                        {value?.liquidationPrice == null ? (
                          'Unavailable'
                        ) : (
                          <PortfolioAmount
                            value={value.liquidationPrice}
                            decimals={6}
                            unit="USD"
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-text-faint">
            Risk priced at the validated oracle ·{' '}
            <PortfolioAmount
              value={
                oracle.state === 'valid' && oracle.price > 0n
                  ? oracle.price
                  : null
              }
              decimals={6}
              unit="USD"
            />
            . Liquidation price is an estimate for this single position.
          </p>
        </>
      )}
    </section>
  );
}
