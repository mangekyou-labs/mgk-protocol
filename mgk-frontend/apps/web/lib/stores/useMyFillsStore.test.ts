import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import {
  __resetMyFillsStore,
  startMyFillsPolling,
  stopMyFillsPolling,
  useMyFills,
  myFillsFor,
  myFillsKey,
} from './useMyFillsStore';

const PUBKEY = 'DdqGmK5uamYN5vmuZrzpQhKeehLdwtPLVJdhu5P2iJKC';
const INSTRUMENT = 0;
const KEY = myFillsKey(PUBKEY, INSTRUMENT, 60_000);
const FILLS_RESPONSE = {
  fills: [
    {
      slot: 1001,
      batch_id: 1,
      instrument_id: 0,
      taker_side: 0,
      price: 150_400_000,
      qty: 5_000_000,
      role: 'taker',
      tx_signature: 'YWFhYWE=',
      ts_estimate: 1001 * 400,
    },
    {
      slot: 1002,
      batch_id: 1,
      instrument_id: 0,
      taker_side: 1,
      price: 151_000_000,
      qty: 3_000_000,
      role: 'maker',
      tx_signature: 'YmJiYmI=',
      ts_estimate: 1002 * 400,
    },
  ],
};

function mockFetchOnce(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

let mockWallet: { publicKey: { toBase58: () => string } | null; connected: boolean };
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => mockWallet,
}));

describe('useMyFillsStore', () => {
  beforeEach(() => {
    __resetMyFillsStore();
    globalThis.fetch = vi.fn();
    mockWallet = {
      publicKey: { toBase58: () => PUBKEY },
      connected: true,
    };
  });

  afterEach(() => {
    stopMyFillsPolling();
    vi.restoreAllMocks();
    __resetMyFillsStore();
  });

  it('starts empty and not polling', () => {
    const s = myFillsFor(KEY);
    expect(s.fills).toEqual([]);
    expect(s.loading).toBe(false);
    expect(s.isPolling).toBe(false);
  });

  it('fetches fills and populates the store', async () => {
    globalThis.fetch = mockFetchOnce(FILLS_RESPONSE);
    await startMyFillsPolling(PUBKEY, INSTRUMENT, 60_000);
    const s = myFillsFor(KEY);
    expect(s.fills).toEqual(FILLS_RESPONSE.fills);
    expect(s.error).toBeNull();
    expect(s.lastFetchedAt).toBeGreaterThan(0);
  });

  it('calls the correct indexer URL', async () => {
    const fetchMock = mockFetchOnce(FILLS_RESPONSE);
    globalThis.fetch = fetchMock;
    await startMyFillsPolling(PUBKEY, INSTRUMENT, 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain(`/api/users/${PUBKEY}/fills`);
    expect(url).toContain(`instrumentId=${INSTRUMENT}`);
    expect(url).toContain('limit=200');
  });

  it('stays quiet after one non-OK response, then records the error once failures persist', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: 'no' }), { status: 500 }));
    await startMyFillsPolling(PUBKEY, INSTRUMENT, 10);
    const key = myFillsKey(PUBKEY, INSTRUMENT, 10);
    expect(myFillsFor(key).error).toBeNull();
    await vi.waitFor(() => expect(myFillsFor(key).error).toMatch(/500/));
    expect(myFillsFor(key).fills).toEqual([]);
    expect(myFillsFor(key).loading).toBe(false);
  });

  it('records an error string on persistent network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection refused'));
    await startMyFillsPolling(PUBKEY, INSTRUMENT, 10);
    await vi.waitFor(() => expect(myFillsFor(myFillsKey(PUBKEY, INSTRUMENT, 10)).error).toMatch(/connection refused/));
  });

  it('restarts the interval when called twice with different params', async () => {
    const fetchMock = mockFetchOnce(FILLS_RESPONSE);
    globalThis.fetch = fetchMock;
    await startMyFillsPolling(PUBKEY, 0, 60_000);
    await startMyFillsPolling(PUBKEY, 1, 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const lastUrl = fetchMock.mock.calls[1]![0] as string;
    expect(lastUrl).toContain('instrumentId=1');
  });

  it('the useMyFills hook auto-starts on mount with the connected wallet', async () => {
    globalThis.fetch = mockFetchOnce(FILLS_RESPONSE);
    renderHook(() => useMyFills(INSTRUMENT, 60_000));
    await waitFor(() => {
      expect(myFillsFor(KEY).fills.length).toBe(2);
    });
  });

  it('gives each consumer the fills for its own params, whichever mounted last', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      const instrument = url.includes('instrumentId=1') ? 1 : 0;
      const fills = FILLS_RESPONSE.fills
        .slice(0, instrument === 1 ? 1 : 2)
        .map((f) => ({ ...f, instrument_id: instrument }));
      return new Response(JSON.stringify({ fills }), { status: 200 });
    });
    const sol = renderHook(() => useMyFills(0, 60_000));
    const other = renderHook(() => useMyFills(1, 60_000));
    await waitFor(() => {
      expect(sol.result.current.fills.length).toBe(2);
      expect(other.result.current.fills.length).toBe(1);
    });
    expect(sol.result.current.fills.every((f) => f.instrument_id === 0)).toBe(true);
    expect(other.result.current.fills.every((f) => f.instrument_id === 1)).toBe(true);
    other.unmount();
    sol.unmount();
  });

  it('keeps polling for the remaining consumer when another one unmounts', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify(FILLS_RESPONSE), { status: 200 }),
    );
    const page = renderHook(() => useMyFills(INSTRUMENT, 60_000));
    const tab = renderHook(() => useMyFills(INSTRUMENT, 60_000));
    await waitFor(() => {
      expect(myFillsFor(KEY).fills.length).toBe(2);
    });
    tab.unmount();
    expect(myFillsFor(KEY).fills.length).toBe(2);
    page.unmount();
    expect(myFillsFor(KEY).fills.length).toBe(0);
  });
});
