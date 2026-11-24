'use client';

import { useEffect, useMemo } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import type { Connection, PublicKey } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';
import { create } from 'zustand';

import { config } from '@/lib/config';
import { FAILURE_THRESHOLD } from '@/lib/polling';
import { decodeOrNull } from '@/lib/decode';

type BookHeader = sdk.state.BookHeader;
type BookLevel = sdk.state.BookLevel;

export interface BookPollParams {
  connection: Connection;
  programId: PublicKey;
  instrumentId: number;
  intervalMs: number;
  /** Optional override for the book account address. When set, skips PDA
   *  derivation and fetches this address directly. Used on devnet where the
   *  book is a matcher-owned keypair (no InitializeBook instruction yet). */
  bookAddress?: PublicKey | null;
}

interface BookStore {
  data: BookHeader | null;
  /** Orders on the book, decoded from the same book read. */
  orders: sdk.state.RestingOrder[];
  instrumentId: number | null;
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  isPolling: boolean;
  startPolling: (params: BookPollParams) => Promise<void>;
  stopPolling: () => void;
  refresh: () => Promise<void>;
}

let pollHandle: ReturnType<typeof setInterval> | null = null;
let currentParams: BookPollParams | null = null;
let consecutiveFailures = 0;

export const useBookStore = create<BookStore>((set, get) => ({
  data: null,
  orders: [],
  instrumentId: null,
  loading: false,
  error: null,
  lastFetchedAt: null,
  isPolling: false,

  startPolling: async (params) => {
    if (pollHandle) clearInterval(pollHandle);
    currentParams = params;
    consecutiveFailures = 0;
    set({ isPolling: true, instrumentId: params.instrumentId, loading: get().lastFetchedAt === null });
    await get().refresh();
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
    set({ isPolling: false });
  },

  refresh: async () => {
    if (!currentParams) return;
    const { connection, programId, instrumentId, bookAddress } = currentParams;
    const bookPk = bookAddress ?? sdk.deriveBookPda(instrumentId, programId, config.marketContext)[0];
    let acc: Awaited<ReturnType<Connection['getMultipleAccountsInfo']>>[number];
    try {
      const accounts = await connection.getMultipleAccountsInfo([bookPk]);
      acc = accounts[0] ?? null;
    } catch (e) {
      // Keep the last book on transient RPC failures; report once they persist.
      consecutiveFailures++;
      if (consecutiveFailures < FAILURE_THRESHOLD) return;
      set({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    consecutiveFailures = 0;
    try {
      if (!acc) {
        set({
          data: null,
          orders: [],
          loading: false,
          error: null,
          lastFetchedAt: Date.now(),
        });
        return;
      }
      const data = sdk.state.decodeBookHeader(new Uint8Array(acc.data));
      const orders = decodeOrNull(acc, sdk.state.decodeRestingOrders) ?? [];

      set({
        data,
        orders,
        loading: false,
        error: null,
        lastFetchedAt: Date.now(),
      });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
}));

export function useBookTopN(
  instrumentId: number,
  depth = 20,
  intervalMs = 5000,
): {
  bids: BookLevel[];
  asks: BookLevel[];
  data: BookHeader | null;
  loading: boolean;
  error: string | null;
} {
  const { connection } = useConnection();

  const startPolling = useBookStore((s) => s.startPolling);
  const stopPolling = useBookStore((s) => s.stopPolling);

  useEffect(() => {
    startPolling({
      connection,
      programId: config.matcherProgramId,
      instrumentId,
      intervalMs,
      bookAddress: config.bookAddress,
    });
    return () => {
      stopPolling();
    };
  }, [connection, instrumentId, intervalMs, startPolling, stopPolling]);

  const data = useBookStore((s) => s.data);
  const loading = useBookStore((s) => s.loading);
  const error = useBookStore((s) => s.error);

  const { bids, asks } = useMemo(() => {
    if (!data) return { bids: [], asks: [] };
    const filledBids = data.bids.filter((l) => l.orderCount > 0);
    const filledAsks = data.asks.filter((l) => l.orderCount > 0);
    filledBids.sort((a, b) =>
      b.price > a.price ? 1 : b.price < a.price ? -1 : 0,
    );
    filledAsks.sort((a, b) =>
      a.price > b.price ? 1 : a.price < b.price ? -1 : 0,
    );
    return {
      bids: filledBids.slice(0, depth),
      asks: filledAsks.slice(0, depth),
    };
  }, [data, depth]);

  return { bids, asks, data, loading, error };
}
