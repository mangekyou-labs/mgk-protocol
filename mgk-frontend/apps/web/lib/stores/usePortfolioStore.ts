'use client';

import { useEffect } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import type { Connection, PublicKey } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';

type PortfolioState = sdk.state.PortfolioState;
import { create } from 'zustand';

import { config } from '@/lib/config';

export interface PortfolioPollParams {
  user: PublicKey;
  connection: Connection;
  programId: PublicKey;
  intervalMs: number;
}

interface PortfolioStore {
  data: PortfolioState | null;
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  isPolling: boolean;
  startPolling: (params: PortfolioPollParams) => Promise<void>;
  stopPolling: () => void;
  refresh: () => Promise<void>;
}

// Poll state lives at module scope (not in the store) so that the
// `setInterval` handle and the active poll params don't get serialized
// by Zustand devtools / persisted to localStorage. The store stays
// serializable; the closure-based handle is the source of truth for
// "is polling active right now" from a non-React caller.
let pollHandle: ReturnType<typeof setInterval> | null = null;
let currentParams: PortfolioPollParams | null = null;
let requestId = 0;
const consumers = new Set<symbol>();

export const usePortfolioStore = create<PortfolioStore>((set, get) => ({
  data: null,
  loading: false,
  error: null,
  lastFetchedAt: null,
  isPolling: false,

  startPolling: async (params) => {
    if (pollHandle) clearInterval(pollHandle);
    currentParams = params;
    set({ isPolling: true, data: null, error: null, lastFetchedAt: null });
    // Run an initial fetch synchronously with `await` so callers (including
    // tests) can wait for the first result before continuing. The handle is
    // installed *after* the initial fetch so the interval doesn't tick
    // concurrently with the initial fetch.
    await get().refresh();
    if (currentParams !== params) return;
    pollHandle = setInterval(() => {
      void get().refresh();
    }, params.intervalMs);
  },

  stopPolling: () => {
    if (pollHandle) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
    currentParams = null;
    requestId++;
    set({ isPolling: false, data: null, error: null, loading: false, lastFetchedAt: null });
  },

  refresh: async () => {
    if (!currentParams) return;
    const params = currentParams;
    const id = ++requestId;
    set({ loading: true, error: null });
    try {
      const { user, connection, programId } = params;
      const [pda] = sdk.derivePortfolioPda(user, programId);
      const accounts = await connection.getMultipleAccountsInfo([pda], 'confirmed');
      if (currentParams !== params || id !== requestId) return;
      const acc = accounts[0] ?? null;
      if (!acc) {
        set({
          data: null,
          loading: false,
          error: null,
          lastFetchedAt: Date.now(),
        });
        return;
      }
      // `acc.data` is typed as `Buffer` in `@solana/web3.js`; in the browser
      // it can be a Buffer or Uint8Array depending on the polyfill. Wrap in
      // a fresh Uint8Array so `decodePortfolio` always sees a plain view.
      if (!acc.owner.equals(programId)) throw new Error('Portfolio owner does not match the deployment manifest.');
      const data = sdk.state.decodePortfolio(new Uint8Array(acc.data));
      if (!data.user.equals(user)) throw new Error('Portfolio user does not match the connected wallet.');
      set({
        data,
        loading: false,
        error: null,
        lastFetchedAt: Date.now(),
      });
    } catch (e) {
      if (currentParams !== params || id !== requestId) return;
      set({
        data: null,
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
}));

/**
 * React hook that ties the portfolio store to the connected wallet.
 * - When the wallet connects, polling starts (initial fetch + every 3s).
 * - When the wallet disconnects, polling stops.
 * - Returns the live store state for components to render.
 */
export function usePortfolioPolling(intervalMs = 5000): {
  data: PortfolioState | null;
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  isPolling: boolean;
  refresh: () => Promise<void>;
} {
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();

  const startPolling = usePortfolioStore((s) => s.startPolling);
  const stopPolling = usePortfolioStore((s) => s.stopPolling);

  useEffect(() => {
    if (!connected || !publicKey) return;
    const consumer = Symbol();
    consumers.add(consumer);
    if (!currentParams || !currentParams.user.equals(publicKey) || currentParams.connection !== connection || currentParams.intervalMs !== intervalMs) {
      void startPolling({ user: publicKey, connection, programId: config.coreProgramId, intervalMs });
    }
    return () => {
      consumers.delete(consumer);
      if (consumers.size === 0) stopPolling();
    };
  }, [connected, publicKey, connection, intervalMs, startPolling, stopPolling]);

  const data = usePortfolioStore((s) => s.data);
  const current = connected && publicKey && currentParams?.user.equals(publicKey) && currentParams.connection === connection;
  return {
    data: current ? data : null,
    loading: usePortfolioStore((s) => s.loading),
    error: usePortfolioStore((s) => s.error),
    lastFetchedAt: usePortfolioStore((s) => s.lastFetchedAt),
    isPolling: usePortfolioStore((s) => s.isPolling),
    refresh: usePortfolioStore((s) => s.refresh),
  };
}
