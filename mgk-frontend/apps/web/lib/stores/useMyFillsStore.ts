'use client';

import { useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { create } from 'zustand';

import { config } from '@/lib/config';
import { FAILURE_THRESHOLD } from '@/lib/polling';

export interface UserFill {
  /** Solana slot this fill was included in. */
  slot: number;
  /** Batch ID at the time of the fill. */
  batch_id: number;
  /** Instrument ID. */
  instrument_id: number;
  /** 0 = taker is buy, 1 = taker is sell. */
  taker_side: number;
  /** Fill price, scaled 1e6 (USD). */
  price: number;
  /** Fill qty, scaled 1e6 (base units). */
  qty: number;
  /** Whether the user was the taker or the maker on this fill. */
  role: 'taker' | 'maker';
  /** Tx signature (base64). */
  tx_signature: string;
  /** Approximate ms-since-epoch derived from slot (slot * 400ms). */
  ts_estimate: number;
}

export interface MyFillsData {
  fills: UserFill[];
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  isPolling: boolean;
}

const EMPTY: MyFillsData = {
  fills: [],
  loading: false,
  error: null,
  lastFetchedAt: null,
  isPolling: false,
};

interface MyFillsStore {
  /** Poll results, one entry per (wallet, instrument, interval). */
  byKey: Record<string, MyFillsData>;
}

export const useMyFillsStore = create<MyFillsStore>(() => ({ byKey: {} }));

/** Identifies one poller. Consumers with equal params share it. */
export function myFillsKey(pubkey: string, instrumentId: number, intervalMs: number): string {
  return `${pubkey}:${instrumentId}:${intervalMs}`;
}

/** Store entry for a key; unknown keys read as the empty state. */
export function myFillsFor(key: string): MyFillsData {
  return useMyFillsStore.getState().byKey[key] ?? EMPTY;
}

interface Poller {
  pubkey: string;
  instrumentId: number;
  timeoutMs: number;
  handle: ReturnType<typeof setInterval> | null;
  /** Mounted useMyFills consumers sharing this poller. */
  subscribers: number;
  /** Consecutive failed fetches since the last success. */
  failures: number;
}

const pollers = new Map<string, Poller>();

function patch(key: string, next: Partial<MyFillsData>): void {
  useMyFillsStore.setState((s) => ({
    byKey: { ...s.byKey, [key]: { ...(s.byKey[key] ?? EMPTY), ...next } },
  }));
}

async function fetchFills(
  pubkey: string,
  instrumentId: number,
  signal: AbortSignal,
): Promise<UserFill[]> {
  const url = `${config.indexerUrl}/api/users/${pubkey}/fills?instrumentId=${instrumentId}&limit=200`;
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`user fills fetch failed: ${res.status}`);
  }
  const body = (await res.json()) as { fills: UserFill[] };
  return body.fills;
}

async function tick(key: string, poller: Poller): Promise<void> {
  const current = myFillsFor(key);
  if (current.lastFetchedAt === null && !current.error) patch(key, { loading: true });
  try {
    const fills = await fetchFills(
      poller.pubkey,
      poller.instrumentId,
      new AbortController().signal,
    );
    if (pollers.get(key) !== poller) return;
    poller.failures = 0;
    patch(key, { fills, loading: false, error: null, lastFetchedAt: Date.now(), isPolling: true });
  } catch (err) {
    if (pollers.get(key) !== poller) return;
    // Keep the last fills through transient misses; report once they persist.
    poller.failures++;
    if (poller.failures < FAILURE_THRESHOLD) return;
    patch(key, {
      loading: false,
      error: err instanceof Error ? err.message : 'unknown',
      lastFetchedAt: Date.now(),
    });
  }
}

function stopPoller(key: string): void {
  const poller = pollers.get(key);
  if (poller?.handle != null) clearInterval(poller.handle);
  pollers.delete(key);
  useMyFillsStore.setState((s) => {
    const rest = { ...s.byKey };
    delete rest[key];
    return { byKey: rest };
  });
}

/**
 * Starts (or restarts) the poller for these params and resolves after the
 * first fetch. Pollers for other params keep running.
 */
export function startMyFillsPolling(
  pubkey: string,
  instrumentId = 0,
  intervalMs = 5000,
  timeoutMs = 4000,
): Promise<void> {
  const key = myFillsKey(pubkey, instrumentId, intervalMs);
  const previous = pollers.get(key);
  if (previous?.handle != null) clearInterval(previous.handle);
  const poller: Poller = {
    pubkey,
    instrumentId,
    timeoutMs,
    handle: null,
    subscribers: previous?.subscribers ?? 0,
    failures: 0,
  };
  pollers.set(key, poller);
  return tick(key, poller).then(() => {
    if (pollers.get(key) !== poller) return;
    poller.handle = setInterval(() => {
      void tick(key, poller);
    }, intervalMs);
  });
}

/** Stops every poller and clears the store. */
export function stopMyFillsPolling(): void {
  for (const key of [...pollers.keys()]) stopPoller(key);
  useMyFillsStore.setState({ byKey: {} });
}

/**
 * React hook: polls the indexer's `GET /api/users/:pubkey/fills` endpoint
 * for the connected wallet and the given instrument. Consumers with the same
 * params share one poller; consumers with different params each get their
 * own. Starts on mount + wallet-connect, stops when its last consumer leaves.
 */
export function useMyFills(instrumentId = 0, intervalMs = 5000): MyFillsData {
  const { publicKey, connected } = useWallet();
  const pubkey = connected && publicKey ? publicKey.toBase58() : null;
  const key = pubkey ? myFillsKey(pubkey, instrumentId, intervalMs) : null;
  const state = useMyFillsStore((s) => (key ? s.byKey[key] : undefined)) ?? EMPTY;

  useEffect(() => {
    if (!pubkey || !key) return;
    const existing = pollers.get(key);
    if (existing) {
      existing.subscribers += 1;
    } else {
      void startMyFillsPolling(pubkey, instrumentId, intervalMs);
      const started = pollers.get(key);
      if (started) started.subscribers = 1;
    }
    return () => {
      const poller = pollers.get(key);
      if (!poller) return;
      poller.subscribers -= 1;
      if (poller.subscribers <= 0) stopPoller(key);
    };
  }, [pubkey, key, instrumentId, intervalMs]);

  return state;
}

/** Test-only: stop all pollers and clear the store. */
export function __resetMyFillsStore(): void {
  stopMyFillsPolling();
}
