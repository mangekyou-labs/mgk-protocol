'use client';
import {
  indexerState,
  type ProtocolStatusReading,
} from '@/lib/hooks/useProtocolStatus';
import { NEW_EXPOSURE_PAUSE_MASK } from '@/lib/protocol';

const CHECK_MESSAGES: Record<string, string> = {
  oracle:
    'Oracle stale or unavailable. Oracle-priced estimates are unavailable.',
  batch:
    'Batch processing delayed or unavailable. Fills may be awaiting settlement; no settlement time is promised.',
  makerDepth: 'Protocol maker depth unavailable.',
  fees: 'Service fee SOL low or unavailable.',
  insurance: 'Insurance reserve low or unavailable.',
};
export function SystemStatus({ status }: { status: ProtocolStatusReading }) {
  const checks = status.data?.checks;
  const messages: string[] = [];
  if (!checks)
    messages.push(
      status.loading
        ? 'Checking system status…'
        : 'Indexer down / system status unavailable. History is unavailable; chain reads remain independent.',
    );
  else {
    const pause = checks.pause;
    const flags = pause?.flags;
    if (
      pause?.available === false ||
      typeof flags !== 'number' || !Number.isSafeInteger(flags) || flags < 0
    )
      messages.push('Pause state unavailable.');
    else {
      if (flags & NEW_EXPOSURE_PAUSE_MASK)
        messages.push('New exposure paused.');
      if (flags & 2) messages.push('Withdrawals paused.');
      if (flags & 4) messages.push('Liquidations paused.');
      if (flags & 32) messages.push('Clearing paused.');
    }
    if (checks.rpc?.reachable !== true)
      messages.push(
        'RPC unavailable. Chain account values may be unavailable.',
      );
    if (
      indexerState(status) === 'down' ||
      indexerState(status) === 'unavailable'
    )
      messages.push('Indexer down / unavailable. History is unavailable.');
    else if (indexerState(status) === 'syncing')
      messages.push('Indexer syncing. History may be incomplete.');
    for (const [key, label] of Object.entries(CHECK_MESSAGES))
      if (
        !checks[key] ||
        checks[key].available === false ||
        checks[key].severity !== 'ok'
      )
        messages.push(label);
  }
  return (
    <div
      data-testid="system-status"
      className="border-b border-border bg-surface-1 px-4 py-2 text-xs"
    >
      {messages.length > 0 && (
        <div role="status" aria-live="polite" className="space-y-1 text-warn">
          {messages.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      )}
      <details className="mt-1 text-text-muted">
        <summary className="cursor-pointer">
          Restricted demo · protections and limits
        </summary>
        <p className="mt-2">
          Devnet SOL-PERP only. Limit GTC and reduce-only orders. Funding: off.
          No mainnet, other markets, market/IOC/post-only/stop/TP/SL orders or
          maker rebates.
        </p>
        <p>
          No ADL or socialized loss. Insurance exhaustion pauses the market;
          recovery requires an operator. Liquidation uses position takeover at
          the oracle, without an external backstop auction.
        </p>
      </details>
    </div>
  );
}
