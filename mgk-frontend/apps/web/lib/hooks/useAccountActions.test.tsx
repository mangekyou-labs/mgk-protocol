import { renderHook } from '@testing-library/react';
import { PublicKey, type Transaction } from '@solana/web3.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as sdk from '@mgk/sdk';
import { layouts } from '../../../../packages/layout/index.js';
import { useAccountActions } from './useAccountActions';

const mocks = vi.hoisted(() => ({ send: vi.fn(), get: vi.fn(), info: vi.fn() }));
const user = new PublicKey('11111111111111111111111111111111');
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => ({ publicKey: user, sendTransaction: mocks.send }), useConnection: () => ({ connection: { getMultipleAccountsInfo: mocks.get, getAccountInfo:mocks.info } }) }));
vi.mock('@/lib/config', async importOriginal => { const actual = await importOriginal<typeof import('@/lib/config')>(); return { ...actual, config: { ...actual.config, get instrumentAddress() { return user; }, get oracleAddress() { return user; } } }; });
vi.mock('@/lib/hooks/useSafeTransaction', () => ({ useSafeTransaction: () => mocks.send }));
vi.mock('@mgk/sdk', async importOriginal => ({ ...await importOriginal<typeof sdk>(), confirmSignature: vi.fn() }));
function portfolio(principal: bigint, free: bigint, equity = free) {
  const data = Buffer.alloc(2848); data[0] = 4; data[1] = 3; user.toBuffer().copy(data, 8);
  data.writeBigInt64LE(equity, 48); data.writeBigUInt64LE(principal, 64); data.writeBigInt64LE(free, 176);
  return { data, owner: new PublicKey('9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT') };
}
beforeEach(() => { vi.stubGlobal('Uint8Array', Object.getPrototypeOf(Buffer)); mocks.send.mockReset().mockResolvedValue('confirmed-signature'); mocks.get.mockReset(); const data = Buffer.from(layouts.Registry.fixture); data.writeBigUInt64LE(0n, layouts.Registry.fields.batchIdCounter[0]); data[layouts.Registry.fields.pauseFlags[0]] = 0; mocks.info.mockReset().mockResolvedValue({data, owner: new PublicKey('9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT')}); });
afterEach(() => vi.unstubAllGlobals());
it('creates a missing portfolio and deposits the exact lamports in one transaction', async () => {
  mocks.get.mockResolvedValue([null]);
  const { result } = renderHook(() => useAccountActions());
  await result.current.deposit(1234567891n);
  const tx = mocks.send.mock.calls[0][0] as Transaction;
  const instructions = tx.instructions.filter(ix => ix.programId.toBase58() === '9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT');
  expect(instructions.map(ix => ix.data[0])).toEqual([19, 2]);
  expect(instructions[1].data.readBigUInt64LE(1)).toBe(1234567891n);
});
it('rejects an over-withdrawal against fresh RPC collateral before signing', async () => {
  mocks.get.mockResolvedValue([portfolio(1000000000n, 200000000n)]);
  const { result } = renderHook(() => useAccountActions());
  await expect(result.current.withdraw(200000001n)).rejects.toThrow(/withdrawable/i);
  expect(mocks.send).not.toHaveBeenCalled();
});

it('withdraws exact net collateral and blocks paused withdrawals', async () => {
  // The hook uses the real Rust-generated registry/batch layouts for RPC reads.
  const { layouts } = await import('../../../../packages/layout/index.js');
  const registryData = Buffer.from(layouts.Registry.fixture);
  registryData.writeBigUInt64LE(0n, layouts.Registry.fields.batchIdCounter[0]);
  registryData[layouts.Registry.fields.pauseFlags[0]] = 0;
  const owner = new PublicKey('9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT');
  mocks.info.mockResolvedValue({ data: registryData, owner });
  mocks.get.mockResolvedValue([portfolio(2000000000n, 1234567891n)]);
  const { result } = renderHook(() => useAccountActions());
  await result.current.withdraw(1234567891n);
  const tx = mocks.send.mock.calls[0][0] as Transaction;
  const ix = tx.instructions[1];
  expect(ix.data.readBigUInt64LE(1)).toBe(1234567891n);
  expect(ix.keys).toHaveLength(4);
  registryData[layouts.Registry.fields.pauseFlags[0]] = 2;
  mocks.send.mockClear();
  await expect(result.current.withdraw(1n)).rejects.toThrow(/paused/);
  expect(mocks.send).not.toHaveBeenCalled();
  registryData[layouts.Registry.fields.pauseFlags[0]] = 0;
  registryData.writeBigUInt64LE(1n, layouts.Registry.fields.batchIdCounter[0]);
  const batchData = Buffer.from(layouts.Batch.fixture);
  batchData[layouts.Batch.fields.status[0]] = sdk.state.BatchStatus.Cleared;
  mocks.info.mockResolvedValueOnce({data:registryData,owner}).mockResolvedValueOnce({data:batchData,owner});
  await expect(result.current.withdraw(1n)).rejects.toThrow(/Cleared/);
  expect(mocks.send).not.toHaveBeenCalled();
});

it('lets mandatory simulation evaluate an exposed withdrawal above a stale risk snapshot', async () => {
  const account = portfolio(1000000000n, 550000000n, 1000000000n);
  account.data.writeUInt16LE(1, layouts.Portfolio.fields.positionsLen[0]);
  mocks.get.mockResolvedValue([account]);
  const { result } = renderHook(() => useAccountActions());
  await expect(result.current.withdraw(600000000n)).resolves.toEqual({ sig: 'confirmed-signature' });
  const tx = mocks.send.mock.calls[0][0] as Transaction;
  expect(tx.instructions[1].data.readBigUInt64LE(1)).toBe(600000000n);
  expect(tx.instructions[1].keys).toHaveLength(6);
});
it('keeps a collateral action pending through confirmation across readiness remounts', async () => {
  mocks.get.mockResolvedValue([portfolio(1000000000n, 1000000000n)]);
  let confirm!: (signature: string) => void;
  vi.mocked(sdk.confirmSignature).mockImplementationOnce(() => new Promise<string>(resolve => { confirm = resolve; }));
  const first = renderHook(() => useAccountActions());
  const pending = first.result.current.withdraw(100000000n);
  await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  first.unmount();
  const second = renderHook(() => useAccountActions());
  await expect(second.result.current.withdraw(100000000n)).rejects.toThrow(/already in progress/);
  expect(mocks.send).toHaveBeenCalledTimes(1);
  confirm('confirmed-signature');
  await expect(pending).resolves.toEqual({ sig: 'confirmed-signature' });
  await expect(second.result.current.withdraw(100000000n)).resolves.toEqual({ sig: 'confirmed-signature' });
});
