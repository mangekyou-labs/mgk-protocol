'use client';

import { useEffect } from 'react';
import type { NormalizedPythPrice } from '@mgk/sdk';
import { create } from 'zustand';

import { fetchPythLatest } from '@/lib/feeds/pyth';
import { FAILURE_THRESHOLD } from '@/lib/polling';

interface PythFeedState {
  data: NormalizedPythPrice | null;
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
}

export type { PythFeedState };

interface PythPriceStore {
  /** feed-id (lowercase hex, no 0x) → state. */
  feeds: Record<string, PythFeedState>;
  setFeed: (id: string, state: PythFeedState) => void;
}

export const usePythPriceStore = create<PythPriceStore>((set) => ({
  feeds: {},
  setFeed: (id, state) =>
    set((prev) => ({ feeds: { ...prev.feeds, [id]: state } })),
}));

interface PollParams {
  feedIds: readonly string[];
  intervalMs: number;
  timeoutMs?: number;
}

let pollHandle: ReturnType<typeof setInterval> | null = null;
let currentParams: PollParams | null = null;
let consecutiveFailures = 0;

async function tick(setFeed: PythPriceStore['setFeed'], params: PollParams): Promise<void> {
  // Mark a feed as loading only until its first result; later ticks keep
  // the previous price visible instead of flickering back to "loading".
  const feeds = usePythPriceStore.getState().feeds;
  for (const id of params.feedIds) {
    if (!feeds[id]) setFeed(id, { data: null, loading: true, error: null, lastFetchedAt: null });
  }
  try {
    const prices = await fetchPythLatest(params.feedIds, {
      timeoutMs: params.timeoutMs,
    });
    if (currentParams !== params) return;
    consecutiveFailures = 0;
    const now = Date.now();
    const byId = new Map(prices.map((p) => [p.id.replace(/^0x/, '').toLowerCase(), p]));
    for (const id of params.feedIds) {
      const price = byId.get(id.toLowerCase());
      if (price) {
        setFeed(id, { data: price, loading: false, error: null, lastFetchedAt: now });
      } else {
        setFeed(id, {
          data: null,
          loading: false,
          error: `Pyth returned no data for feed ${id}`,
          lastFetchedAt: now,
        });
      }
    }
  } catch (e) {
    if (currentParams !== params) return;
    consecutiveFailures++;
    if (consecutiveFailures < FAILURE_THRESHOLD) return;
    const msg = e instanceof Error ? e.message : String(e);
    const now = Date.now();
    for (const id of params.feedIds) {
      setFeed(id, { data: null, loading: false, error: msg, lastFetchedAt: now });
    }
  }
}

/**
 * Start polling the given feed IDs. Returns a stop function. Safe to
 * call multiple times — only the most recent call's params are used.
 *
 * Polling state lives at module scope so the interval handle and the
 * active params don't get serialized by Zustand devtools (mirrors the
 * pattern from usePortfolioStore / useBatchStore / useBookStore).
 */
export function startPythPolling(params: PollParams): () => void {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  currentParams = params;
  consecutiveFailures = 0;
  const setFeed = usePythPriceStore.getState().setFeed;
  void tick(setFeed, params);
  pollHandle = setInterval(() => {
    if (currentParams) void tick(setFeed, currentParams);
  }, params.intervalMs);
  return () => {
    if (pollHandle) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
    currentParams = null;
  };
}

interface UsePythPricesOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

/**
 * React hook: subscribe to the current Pyth state for the given feed
 * IDs. The polling itself is started by the first component that calls
 * this hook (via `useEffect`); subsequent calls share the same interval.
 */
export function usePythPrices(
  feedIds: readonly string[],
  options: UsePythPricesOptions = {},
): PythFeedState[] {
  const intervalMs = options.intervalMs ?? 10_000;
  const timeoutMs = options.timeoutMs;

  // Stable key for the feedIds array so the effect re-runs only when
  // the ID set actually changes.
  const feedKey = feedIds.join(',');

  useEffect(() => {
    if (feedIds.length === 0) return;
    const stop = startPythPolling({ feedIds, intervalMs, timeoutMs });
    return stop;
    // feedKey is the stable identity; the actual feedIds array
    // reference may change every render, but its content is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedKey, intervalMs, timeoutMs]);

  // Subscribe to the store (selector so we re-render only when `feeds` changes).
  const feeds = usePythPriceStore((s) => s.feeds);

  return feedIds.map((id) => {
    return (
      feeds[id] ?? { data: null, loading: false, error: null, lastFetchedAt: null }
    );
  });
}
