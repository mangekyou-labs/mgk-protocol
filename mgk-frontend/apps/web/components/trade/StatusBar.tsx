'use client';

import { useState, type ReactNode } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { deployment } from '@/lib/config';
import {
  indexerState,
  type ProtocolStatusReading,
} from '@/lib/hooks/useProtocolStatus';
import { truncatePubkey } from '@/lib/pubkey';

/**
 * One status dot; RPC, indexer, cluster and wallet details show on hover or focus.
 * Notices sit on the right and open upwards, so they never push the page down.
 */
export function StatusBar({ status, children }: { status: ProtocolStatusReading; children?: ReactNode }) {
  const { connected, publicKey } = useWallet();
  const [open, setOpen] = useState(false);
  const rpc = status.data?.checks.rpc;
  const indexer = status.data?.checks.indexer;
  const rpcLabel =
    rpc?.reachable === true
      ? 'reachable'
      : rpc?.reachable === false
        ? 'unreachable'
        : 'unavailable';
  const state = indexerState(status);
  const indexerLabel = state === 'down' ? 'down / unavailable' : state;
  const [summary, dot] =
    rpc?.reachable !== true
      ? [status.loading && !status.data ? 'Checking' : `RPC ${rpcLabel}`, status.loading && !status.data ? 'bg-text-faint' : 'bg-offline']
      : state !== 'live'
        ? ['Degraded', 'bg-warn']
        : ['Connected', 'bg-online'];
  return (
    <footer
      data-testid="status-bar"
      className="flex h-7 shrink-0 items-center border-t border-border bg-surface-1 px-3 font-mono text-[11px] text-text-muted"
      aria-label="Connection status"
    >
      <div
        data-testid="status-hover"
        className="relative"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls="status-details"
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${dot}`} />
          <span>Status: {summary}</span>
        </button>
        <div
          id="status-details"
          data-testid="status-details"
          hidden={!open}
          className="absolute bottom-full left-0 mb-2 flex flex-col whitespace-nowrap gap-1 rounded border border-border bg-surface-2 px-3 py-2 shadow-lg"
        >
          <span data-testid="status-rpc">RPC: {rpcLabel}</span>
          <span data-testid="status-indexer-label">
            Indexer: {indexerLabel}
            {indexer?.lagSlots != null ? ` · ${indexer.lagSlots} slots behind` : ''}
          </span>
          <span data-testid="status-cluster">Cluster: {deployment.cluster}</span>
          <span data-testid="status-wallet-label">
            {connected && publicKey
              ? `Wallet: connected · ${truncatePubkey(publicKey)}`
              : 'Wallet: disconnected'}
          </span>
        </div>
      </div>
      <div className="ml-auto flex items-center gap-3">{children}</div>
    </footer>
  );
}
