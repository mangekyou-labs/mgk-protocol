'use client';
import {
  indexerState,
  type ProtocolStatusReading,
} from '@/lib/hooks/useProtocolStatus';
import { NEW_EXPOSURE_PAUSE_MASK } from '@/lib/protocol';
import { useSustained } from '@/lib/hooks/useSustained';

/** Short indexer syncs are routine; only a sync that lasts this long is worth a banner. */
const SYNCING_BANNER_DELAY_MS = 30_000;

const CHECK_MESSAGES: Record<string, string> = {
  batch:
    'Batch processing delayed or unavailable. Fills may be awaiting settlement; no settlement time is promised.',
  makerDepth: 'Protocol maker depth unavailable.',
  fees: 'Service fee SOL low or unavailable.',
  insurance: 'Insurance reserve low or unavailable.',
};
export function SystemStatus({ status }: { status: ProtocolStatusReading }) {
  const checks = status.data?.checks;
  const longSync = useSustained(indexerState(status) === 'syncing', SYNCING_BANNER_DELAY_MS);
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
        messages.push(
          'New exposure paused. Cancels and reduce-only closes remain permitted; other risk checks still apply.',
        );
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
    else if (longSync)
      messages.push('Indexer syncing. History may be incomplete.');
    const oracle = checks.oracle;
    if (!oracle || oracle.available === false)
      messages.push('Oracle status unavailable. Chain price validation remains independent.');
    else if (oracle.severity === 'warn')
      messages.push('Oracle update delayed. Prices up to 60 seconds old remain valid.');
    else if (oracle.severity === 'critical')
      messages.push(
        'Oracle stale or unavailable according to system status. Chain price validation remains independent.',
      );
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
    </div>
  );
}
