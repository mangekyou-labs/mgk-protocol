'use client';

import { useWallet } from '@solana/wallet-adapter-react';
import { deployment } from '@/lib/config';
import {
  indexerState,
  type ProtocolStatusReading,
} from '@/lib/hooks/useProtocolStatus';
import { truncatePubkey } from '@/lib/pubkey';

export function StatusBar({ status }: { status: ProtocolStatusReading }) {
  const { connected, publicKey } = useWallet();
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
  return (
    <footer
      data-testid="status-bar"
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-surface-1 px-3 py-1 font-mono text-[10px] text-text-muted"
      aria-label="Connection status"
    >
      <span data-testid="status-rpc">RPC: {rpcLabel}</span>
      <span data-testid="status-indexer-label">
        Indexer: {indexerLabel}
        {indexer?.lagSlots != null ? ` · ${indexer.lagSlots} slots behind` : ''}
      </span>
      <span data-testid="status-cluster">Cluster: {deployment.cluster}</span>
      <span data-testid="status-wallet-label" className="ml-auto">
        {connected && publicKey
          ? `Wallet: connected · ${truncatePubkey(publicKey)}`
          : 'Wallet: disconnected'}
      </span>
    </footer>
  );
}
