'use client';

import { MgkTradeMarkers } from './MgkTradeMarkers';
import { TradingViewWidget } from './TradingViewWidget';
import { useIndexerWs } from '@/lib/chart/useIndexerWs';

export interface PriceChartProps {
  instrumentId?: number;
  className?: string;
}

const CHART_HEIGHT = 400;
const TV_SYMBOL = 'BINANCE:SOLUSDT' as const;

/**
 * External reference chart. The candles come from Binance, not from this
 * protocol, so the chart is labelled as a reference that cannot be traded.
 */
export function PriceChart({ instrumentId = 0, className }: PriceChartProps) {
  const { simpleMarkers } = useIndexerWs(instrumentId);

  return (
    <div className={className} data-testid="price-chart" data-instrument-id={instrumentId}>
      <div
        data-testid="price-chart-label"
        className="border-b border-surface-3 px-3 py-1.5 font-mono text-[11px] text-text-muted"
      >
        Binance SOLUSDT · 15m · external reference · not executable
      </div>
      <div className="relative" style={{ height: CHART_HEIGHT }}>
        <TradingViewWidget symbol={TV_SYMBOL} interval="15" />
        <MgkTradeMarkers markers={simpleMarkers} containerHeight={CHART_HEIGHT} />
      </div>
    </div>
  );
}
