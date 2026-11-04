/** The one place the trade screen states the demo's scope; limits expand on demand. */
export function DemoNotice() {
  return (
    <details data-testid="demo-notice" className="border-b border-border bg-surface-1 px-4 py-1 text-xs text-text-muted">
      <summary className="cursor-pointer">
        Restricted demo · Earlier devnet balances were not carried over.
      </summary>
      <p className="mt-2">
        Devnet SOL-PERP only. Limit GTC and reduce-only orders. Funding: off.
        No mainnet, other markets, market/IOC/post-only/stop/TP/SL orders or
        maker rebates.
      </p>
      <p className="mb-1">
        No ADL or socialized loss. Insurance exhaustion pauses the market;
        recovery requires an operator. Liquidation uses position takeover at
        the conversion price, without an auction.
      </p>
    </details>
  );
}
