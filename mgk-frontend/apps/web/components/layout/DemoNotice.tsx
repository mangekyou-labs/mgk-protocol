'use client';
import { useRef } from 'react';
import { useDismissOnOutside } from '@/lib/hooks/useDismissOnOutside';

/** The demo's scope as a footer badge; limits open above it so nothing on the page moves. */
export function DemoNotice() {
  const ref = useRef<HTMLDetailsElement>(null);
  useDismissOnOutside(ref);
  return (
    <details ref={ref} data-testid="demo-notice" className="group relative">
      <summary className="cursor-pointer list-none rounded px-1 text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        Restricted demo
      </summary>
      <div className="absolute bottom-full right-0 mb-2 w-80 space-y-2 rounded border border-border bg-surface-2 p-3 font-sans text-xs leading-relaxed text-text-muted shadow-lg">
        <p className="text-text">Earlier devnet balances were not carried over.</p>
        <p>
          Devnet SOL-PERP only. Limit GTC and reduce-only orders. Funding: off.
          No mainnet, other markets, market/IOC/post-only/stop/TP/SL orders or
          maker rebates.
        </p>
        <p>
          No ADL or socialized loss. Insurance exhaustion pauses the market
          until an operator recovers it. Liquidation takes over the position at
          the conversion price.
        </p>
      </div>
    </details>
  );
}
