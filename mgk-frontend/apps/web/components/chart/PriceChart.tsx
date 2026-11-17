'use client';

import { useEffect, useRef, useState } from 'react';
import { MgkTradeMarkers } from './MgkTradeMarkers';
import { TradingViewWidget } from './TradingViewWidget';
import { useIndexerWs } from '@/lib/chart/useIndexerWs';

export interface PriceChartProps {
  instrumentId?: number;
  className?: string;
}

const TV_SYMBOL = 'BINANCE:SOLUSDT' as const;

/** Tracks an element's height so overlays can follow a chart that fills its slot. */
function useHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) =>
      setHeight(Math.round(entry.contentRect.height)),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, height] as const;
}

/**
 * External reference chart. The candles come from Binance, not from this
 * protocol, so the chart is labelled as a reference that cannot be traded.
 * It fills whatever height its parent gives it.
 */
export function PriceChart({ instrumentId = 0, className }: PriceChartProps) {
  const { simpleMarkers } = useIndexerWs(instrumentId);
  const [chartRef, chartHeight] = useHeight<HTMLDivElement>();

  return (
    <div
      className={`flex flex-col ${className ?? ''}`}
      data-testid="price-chart"
      data-instrument-id={instrumentId}
    >
      <div
        data-testid="price-chart-label"
        className="shrink-0 border-b border-surface-3 px-3 py-1.5 font-mono text-[11px] text-text-muted"
      >
        Reference price · Binance
      </div>
      <div ref={chartRef} className="relative min-h-0 flex-1">
        <TradingViewWidget
          symbol={TV_SYMBOL}
          interval="15"
          className="absolute inset-0"
        />
        {chartHeight > 0 && (
          <MgkTradeMarkers markers={simpleMarkers} containerHeight={chartHeight} />
        )}
      </div>
    </div>
  );
}
