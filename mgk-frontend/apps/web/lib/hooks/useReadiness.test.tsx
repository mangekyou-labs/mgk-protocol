import { act, renderHook, waitFor } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { beforeEach, expect, it, vi } from 'vitest';
import { useReadiness } from './useReadiness';
const mocks = vi.hoisted(() => ({ wallet: '11111111111111111111111111111111', connected: true, balance: vi.fn(), genesis: vi.fn() }));
const keys = new Map<string, PublicKey>();
const walletKey = () => { if (!keys.has(mocks.wallet)) keys.set(mocks.wallet, new PublicKey(mocks.wallet)); return keys.get(mocks.wallet)!; };
// A fresh connection per test: the genesis hash is cached per connection.
let connection = { getGenesisHash: mocks.genesis, getBalance: mocks.balance };
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => ({ publicKey: walletKey(), connected: mocks.connected }), useConnection: () => ({ connection }) }));
vi.mock('./useSafeTransaction', () => ({ assertDeployment: vi.fn().mockResolvedValue(undefined) }));
beforeEach(() => { connection = { getGenesisHash: mocks.genesis, getBalance: mocks.balance }; mocks.wallet = '11111111111111111111111111111111'; mocks.connected = true; mocks.genesis.mockReset().mockResolvedValue('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'); mocks.balance.mockReset().mockResolvedValue(1234567891); });
it('reads exact wallet funding anew after remount and clears it immediately for another wallet', async () => {
  const first = renderHook(() => useReadiness());
  await waitFor(() => expect(first.result.current.walletLamports).toBe(1234567891n));
  mocks.wallet = '11111111111111111111111111111112';
  first.rerender();
  expect(first.result.current.walletLamports).toBeNull();
  expect(first.result.current.signingBlockedReason).toMatch(/Checking/);
  first.unmount();
  mocks.balance.mockResolvedValue(2000000001);
  const second = renderHook(() => useReadiness());
  await waitFor(() => expect(second.result.current.walletLamports).toBe(2000000001n));
  expect(mocks.balance).toHaveBeenCalledTimes(2);
});
it('discards late RPC funding when disconnected', async () => {
  let resolve!: (balance: number) => void;
  mocks.balance.mockImplementation(() => new Promise<number>(r => { resolve = r; }));
  const { result, rerender } = renderHook(() => useReadiness());
  await waitFor(() => expect(mocks.balance).toHaveBeenCalled());
  mocks.connected = false; rerender();
  await act(async () => resolve(9000000000));
  expect(result.current.walletLamports).toBeNull();
  expect(result.current.signingBlockedReason).toMatch(/Connect/);
});
it('checks the cluster genesis once per connection, not on every refresh', async () => {
  const { result } = renderHook(() => useReadiness());
  await waitFor(() => expect(result.current.walletLamports).toBe(1234567891n));
  await act(async () => { await result.current.refresh(); await result.current.refresh(); });
  expect(mocks.balance).toHaveBeenCalledTimes(3);
  expect(mocks.genesis).toHaveBeenCalledTimes(1);
});
it('keeps the last balance through transient RPC failures and blocks only once they persist', async () => {
  const { result } = renderHook(() => useReadiness());
  await waitFor(() => expect(result.current.walletLamports).toBe(1234567891n));
  mocks.balance.mockRejectedValue(new Error('429 Too Many Requests'));
  await act(async () => { await result.current.refresh(); await result.current.refresh(); });
  expect(result.current.walletLamports).toBe(1234567891n);
  expect(result.current.error).toBeNull();
  expect(result.current.signingBlockedReason).toBeNull();
  await act(async () => { await result.current.refresh(); });
  expect(result.current.walletLamports).toBeNull();
  expect(result.current.error).toBe('Network busy, retrying…');
  expect(result.current.signingBlockedReason).toMatch(/Network busy/);
});
it('flags a wallet that cannot cover network fees', async () => {
  mocks.balance.mockResolvedValue(4000);
  const { result } = renderHook(() => useReadiness());
  await waitFor(() => expect(result.current.walletLamports).toBe(4000n));
  expect(result.current.lowFeeBalance).toBe(true);
  mocks.balance.mockResolvedValue(50_000_000);
  await act(async () => { await result.current.refresh(); });
  expect(result.current.lowFeeBalance).toBe(false);
});
