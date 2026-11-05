'use client';
import { useRef } from 'react';
import {
  indexerState,
  type ProtocolStatusReading,
} from '@/lib/hooks/useProtocolStatus';
import { NEW_EXPOSURE_PAUSE_MASK } from '@/lib/protocol';
import { useSustained } from '@/lib/hooks/useSustained';
import { useDismissOnOutside } from '@/lib/hooks/useDismissOnOutside';

/** Short indexer syncs are routine; only a sync that lasts this long is worth reporting. */
const SYNCING_NOTICE_DELAY_MS = 30_000;

type Issue = { title: string; detail?: string };

const CHECK_ISSUES: Record<string, Issue> = {
  batch: { title: 'Settlement delayed.', detail: 'Fills may await settlement; no settlement time is promised.' },
  makerDepth: { title: 'Protocol maker depth unavailable.' },
  fees: { title: 'Service fee SOL low.' },
  insurance: { title: 'Insurance reserve low.' },
};

function systemIssues(status: ProtocolStatusReading, longSync: boolean): Issue[] {
  const checks = status.data?.checks;
  if (!checks)
    return status.loading
      ? []
      : [{ title: 'Indexer down / system status unavailable.', detail: 'History is unavailable; chain reads still work.' }];
  const issues: Issue[] = [];
  const flags = checks.pause?.flags;
  if (checks.pause?.available === false || typeof flags !== 'number' || !Number.isSafeInteger(flags) || flags < 0)
    issues.push({ title: 'Pause state unavailable.' });
  else {
    if (flags & NEW_EXPOSURE_PAUSE_MASK)
      issues.push({ title: 'New exposure paused.', detail: 'Cancels and reduce-only closes remain permitted.' });
    if (flags & 2) issues.push({ title: 'Withdrawals paused.' });
    if (flags & 4) issues.push({ title: 'Liquidations paused.' });
    if (flags & 32) issues.push({ title: 'Clearing paused.' });
  }
  if (checks.rpc?.reachable !== true)
    issues.push({ title: 'RPC unavailable.', detail: 'Account values may be missing.' });
  const indexer = indexerState(status);
  if (indexer === 'down' || indexer === 'unavailable')
    issues.push({ title: 'Indexer down.', detail: 'History is unavailable.' });
  else if (longSync) issues.push({ title: 'Indexer syncing.', detail: 'History may be incomplete.' });
  const oracle = checks.oracle;
  if (!oracle || oracle.available === false)
    issues.push({ title: 'Oracle status unavailable.', detail: 'On-chain price checks still apply.' });
  else if (oracle.severity === 'warn')
    issues.push({ title: 'Oracle update delayed.', detail: 'Prices up to 60 s old remain valid.' });
  else if (oracle.severity === 'critical')
    issues.push({ title: 'Oracle stale or unavailable.', detail: 'On-chain price checks still apply.' });
  for (const [key, issue] of Object.entries(CHECK_ISSUES)) {
    const check = checks[key];
    if (!check || check.available === false || check.severity !== 'ok') issues.push(issue);
  }
  return issues;
}

/** Protocol issues as one footer chip; details open above it so the trade screen never moves. */
export function SystemStatus({ status }: { status: ProtocolStatusReading }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useDismissOnOutside(ref);
  const longSync = useSustained(indexerState(status) === 'syncing', SYNCING_NOTICE_DELAY_MS);
  const issues = systemIssues(status, longSync);
  return (
    <details ref={ref} data-testid="system-status" hidden={issues.length === 0} className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded px-1 text-warn focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-warn" />
        {issues.length === 1 ? issues[0]!.title.replace(/\.$/, '') : `${issues.length} notices`}
      </summary>
      <ul
        role="status"
        aria-live="polite"
        className="absolute bottom-full right-0 mb-2 w-80 space-y-2 rounded border border-border bg-surface-2 p-3 font-sans text-xs leading-relaxed shadow-lg"
      >
        {issues.map(({ title, detail }) => (
          <li key={title}>
            <span className="text-text">{title}</span>
            {detail && <> <span className="text-text-muted">{detail}</span></>}
          </li>
        ))}
      </ul>
    </details>
  );
}
