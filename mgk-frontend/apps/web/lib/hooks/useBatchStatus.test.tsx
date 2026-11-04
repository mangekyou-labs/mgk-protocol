import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as sdk from '@mgk/sdk';
import { useBatchStatus } from './useBatchStatus';

const mocks = vi.hoisted(() => ({ getAccountInfo: vi.fn() }));
const connection = { getAccountInfo: mocks.getAccountInfo };
vi.mock('@solana/wallet-adapter-react', () => ({ useConnection: () => ({ connection }) }));
vi.mock('@mgk/sdk', async importOriginal => {
  const actual = await importOriginal<typeof sdk>();
  return { ...actual, state: { ...actual.state, decodeBatch: (data: Uint8Array) => ({ status: data[0] }) } };
});

const account = (status: number) => ({ data: new Uint8Array([status]) });

beforeEach(() => { mocks.getAccountInfo.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

it('keeps the last batch status through transient read failures and drops it once they persist', async () => {
  vi.useFakeTimers();
  mocks.getAccountInfo.mockResolvedValueOnce(account(sdk.state.BatchStatus.Collecting)).mockRejectedValue(new Error('429 Too Many Requests'));
  const { result } = renderHook(() => useBatchStatus(5n, 1000));
  await act(async () => { await Promise.resolve(); });
  expect(result.current).toBe(sdk.state.BatchStatus.Collecting);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(mocks.getAccountInfo).toHaveBeenCalledTimes(3);
  expect(result.current).toBe(sdk.state.BatchStatus.Collecting);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(result.current).toBeNull();
});
