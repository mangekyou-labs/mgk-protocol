import { act, renderHook } from '@testing-library/react';
import { PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as sdk from '@mgk/sdk';
import { useSafeTransaction } from './useSafeTransaction';

const mocks = vi.hoisted(() => ({ send: vi.fn(), genesis: vi.fn(), ready: true, connected: true, accounts: vi.fn(), simulate: vi.fn(), latest: vi.fn() }));
const user = new PublicKey('11111111111111111111111111111111');
const connection = { getGenesisHash: mocks.genesis, getMultipleAccountsInfo: mocks.accounts, getLatestBlockhash: mocks.latest, simulateTransaction: mocks.simulate };
vi.mock('@mgk/sdk', async importOriginal => ({ ...await importOriginal<typeof sdk>(), state: { decodeRegistry: vi.fn(), decodeInstrument: () => ({ instrumentId: 0, oracleAddr: user }), decodeAccount: vi.fn() } }));
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({ publicKey: user, connected: mocks.connected, sendTransaction: mocks.send }),
  useConnection: () => ({ connection }),
}));
vi.mock('@/lib/config', () => ({ config: { get deploymentReady() { return mocks.ready; }, get coreProgramId() { return user; }, get matcherProgramId() { return user; }, get oracleProgramId() { return user; }, get registryAddress() { return user; }, get instrumentAddress() { return user; }, get oracleAddress() { return user; }, get vaultAddress() { return user; } }, deployment: { cluster: 'devnet' } }));
beforeEach(() => { vi.stubGlobal('Uint8Array', Object.getPrototypeOf(Buffer)); vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok:true,json:async()=>({cluster:'devnet'})})); mocks.ready = true; mocks.connected = true; mocks.send.mockReset(); mocks.genesis.mockReset(); mocks.accounts.mockReset().mockResolvedValue(Array.from({length:7},(_,i)=>({owner:user,executable:i<3,data:Buffer.alloc(8)}))); mocks.latest.mockReset().mockResolvedValue({blockhash:user.toBase58(),lastValidBlockHeight:12}); mocks.simulate.mockReset().mockResolvedValue({value:{err:null}}); });
afterEach(() => vi.unstubAllGlobals());
it('blocks signing against a non-devnet RPC with an actionable message', async () => {
  mocks.genesis.mockResolvedValue('mainnet');
  const { result } = renderHook(() => useSafeTransaction());
  await expect(result.current(new Transaction())).rejects.toThrow(/devnet RPC/);
  expect(mocks.send).not.toHaveBeenCalled();
});
it('blocks a pending manifest before a wallet request', async () => {
  mocks.ready = false;
  const { result } = renderHook(() => useSafeTransaction());
  await expect(result.current(new Transaction())).rejects.toThrow(/deployment.*pending/i);
  expect(mocks.send).not.toHaveBeenCalled();
});
it('rejects a wallet disconnect while the RPC guard is in flight', async () => {
  let resolve!: (hash: string) => void;
  mocks.genesis.mockImplementation(() => new Promise<string>(r => { resolve = r; }));
  const { result, rerender } = renderHook(() => useSafeTransaction());
  const pending = result.current(new Transaction());
  mocks.connected = false;
  rerender();
  const assertion = expect(pending).rejects.toThrow(/Wallet or RPC changed/);
  await act(async () => { resolve('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'); });
  await assertion;
  expect(mocks.send).not.toHaveBeenCalled();
});

it('blocks a stale browser manifest before a wallet request', async () => {
  mocks.genesis.mockResolvedValue('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  vi.mocked(fetch).mockResolvedValue({ok:true,json:async()=>({cluster:'devnet',name:'replacement-market'})} as Response);
  const { result } = renderHook(() => useSafeTransaction());
  await expect(result.current(new Transaction())).rejects.toThrow(/manifest mismatch/i);
  expect(mocks.send).not.toHaveBeenCalled();
});

const transaction = () => new Transaction().add(SystemProgram.transfer({fromPubkey:user,toPubkey:user,lamports:1}));
it('simulates the verified transaction before requesting a signature', async () => {
  mocks.genesis.mockResolvedValue('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'); mocks.send.mockResolvedValue('sig');
  const { result } = renderHook(() => useSafeTransaction());
  await expect(result.current(transaction())).resolves.toBe('sig');
  expect(mocks.simulate).toHaveBeenCalledWith(expect.anything(), {sigVerify:false,commitment:'confirmed'});
  expect(mocks.send).toHaveBeenCalledWith(expect.any(Transaction),connection,{skipPreflight:false,preflightCommitment:'confirmed'});
});
it('blocks simulation failure without a signature', async () => {
  mocks.genesis.mockResolvedValue('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  mocks.simulate.mockResolvedValue({value:{err:{InstructionError:[0,'Custom']}}});
  const { result } = renderHook(() => useSafeTransaction());
  await expect(result.current(transaction())).rejects.toThrow(/Simulation failed/);
  expect(mocks.send).not.toHaveBeenCalled();
});
it('blocks a manifest account with the wrong owner', async () => {
  mocks.genesis.mockResolvedValue('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  mocks.accounts.mockResolvedValue(Array.from({length:7},()=>({owner:new PublicKey('11111111111111111111111111111112'),executable:true,data:Buffer.alloc(8)})));
  const { result } = renderHook(() => useSafeTransaction());
  await expect(result.current(transaction())).rejects.toThrow(/manifest mismatch/i);
  expect(mocks.send).not.toHaveBeenCalled();
});
it('retains a pending wallet request across readiness unmount and remount', async () => {
  mocks.genesis.mockResolvedValue('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  let resolve!: (signature: string) => void;
  mocks.send.mockResolvedValue('duplicate-signature').mockImplementationOnce(() => new Promise<string>(r => { resolve = r; }));
  const first = renderHook(() => useSafeTransaction());
  const pending = first.result.current(transaction());
  await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  first.unmount();
  const second = renderHook(() => useSafeTransaction());
  await expect(second.result.current(transaction())).rejects.toThrow(/already in progress/);
  expect(mocks.send).toHaveBeenCalledTimes(1);
  resolve('first-signature');
  await expect(pending).resolves.toBe('first-signature');
  mocks.send.mockResolvedValue('second-signature');
  await expect(second.result.current(transaction())).resolves.toBe('second-signature');
});

it.each([
  [400, "You don't have enough margin for this order.", 'retryable'],
  [610, 'Unknown perps-core error (610).', 'unknown'],
] as const)('humanizes structured simulation error %s with severity while retaining diagnostics and blocking the wallet', async (code, message, severity) => {
  mocks.genesis.mockResolvedValue('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  const err = { InstructionError: [1, { Custom: code }] };
  const logs = ['Program log: withdrawal risk rejected'];
  mocks.simulate.mockResolvedValue({ value: { err, logs } });
  const { result } = renderHook(() => useSafeTransaction());
  await expect(result.current(transaction())).rejects.toMatchObject({
    message: expect.stringContaining(message),
    code, severity, simulationError: err, logs,
  });
  expect(mocks.send).not.toHaveBeenCalled();
});
