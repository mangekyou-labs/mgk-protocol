'use client';

/**
 * Market bar for the single SOL-USD perp. Presentational: the trade page
 * owns the data hooks and passes resolved values in. Every value can be
 * unknown; unknown renders as "--" or "unavailable", never as 0.
 */

import type { ClearPrice, OracleReading } from '@/lib/marketBar';

export interface MarketHeaderProps {
  oracle: OracleReading;
  /** Mark from the most recent cleared batch. null = no valid mark known. */
  mark: ClearPrice | null;
  /** Batch currently collecting orders. null = unknown. */
  collectingBatchId: bigint | null;
}

export function MarketHeader({ oracle, mark, collectingBatchId }: MarketHeaderProps) {
  return (
    <div
      data-testid="market-header"
      className="flex h-12 shrink-0 items-center gap-5 border-b border-border bg-surface-1 px-4"
    >
      <span
        data-testid="market-selector"
        className="text-xs font-medium uppercase tracking-wider text-text"
      >
        SOL-USD Perp
      </span>

      <span className="h-5 w-px bg-border" aria-hidden="true" />

      <Stat testId="stat-oracle" label="Oracle · risk">
        {oracle.state === 'unavailable' ? (
          <span className="text-bear">unavailable</span>
        ) : oracle.state === 'stale' ? (
          <span className="text-warn">
            ${formatUsd(oracle.price)} · stale {oracle.ageSeconds}s
          </span>
        ) : (
          <>
            ${formatUsd(oracle.price)}{' '}
            <span className="text-text-faint">{oracle.ageSeconds}s</span>
          </>
        )}
      </Stat>

      <Stat testId="stat-mark" label="Mark · PnL">
        {mark ? (
          <>
            ${formatUsd(mark.price)}{' '}
            <span className="text-text-faint">batch {mark.batchId.toString()}</span>
          </>
        ) : (
          <span className="text-text-faint">--</span>
        )}
      </Stat>

      <Stat testId="stat-collecting" label="Collecting">
        {collectingBatchId != null ? (
          <>batch {collectingBatchId.toString()}</>
        ) : (
          <span className="text-text-faint">--</span>
        )}
      </Stat>

      <Stat testId="stat-funding" label="Funding">
        <span className="text-text-muted">off</span>
      </Stat>
    </div>
  );
}

function Stat({
  testId,
  label,
  children,
}: {
  testId: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col leading-tight" data-testid={testId}>
      <span className="text-[10px] uppercase tracking-wider text-text-faint">{label}</span>
      <span className="font-mono text-xs tabular-nums text-text">{children}</span>
    </div>
  );
}

function formatUsd(micro: bigint): string {
  return (Number(micro) / 1_000_000).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
