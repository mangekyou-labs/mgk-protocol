import {describe, expect, it, vi} from 'vitest';
import {Connection, PublicKey} from '@solana/web3.js';
import {createHistoryFetch} from './historyFetch.js';
import {syncChunk} from './syncer.js';
import {createStore} from './store.js';

const core = '9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT';
const other = '11111111111111111111111111111111';
const tx = (keys = [other], version: 'legacy' | 0 | 1 = 'legacy', loaded = {writable: [] as string[], readonly: [] as string[]}) => ({
  version,
  meta: {err: null, fee: 0, preBalances: [0], postBalances: [0], loadedAddresses: loaded},
  transaction: {
    signatures: [],
    message: {accountKeys: keys, header: {numRequiredSignatures: 0, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: keys.length}, instructions: [], recentBlockhash: other, ...(version === 0 ? {addressTableLookups: []} : {}), ...(version === 1 ? {transactionConfig: {computeUnitLimit: null, heapSize: null, loadedAccountsDataSizeLimit: null, priorityFee: null}} : {})},
  },
});
async function filtered(transactions: unknown[]) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({jsonrpc: '2.0', id: '1', result: {blockTime: 123, transactions}})));
  const response = await createHistoryFetch(core, fetcher)('https://example.invalid', {method: 'POST', body: JSON.stringify({method: 'getBlock', params: [100, {encoding: 'json'}]})});
  return await response.json() as {result: {transactions: unknown[]; blockTime: number}};
}

describe('history RPC filtering before web3 block hydration', () => {
  it.each(['legacy', 0, 1] as const)('drops unrelated transactions before Connection decodes a %s block', async version => {
    const result = {blockhash: other, previousBlockhash: other, parentSlot: 99, blockTime: 123, blockHeight: 100, transactions: [tx(), tx([core], version), tx()]};
    const fetcher = vi.fn(async (_url, options) => new Response(JSON.stringify({jsonrpc: '2.0', id: JSON.parse(String(options?.body)).id, result})));
    const connection = new Connection('https://example.invalid', {fetch: createHistoryFetch(core, fetcher)});
    const block = await connection.getBlock(100, {maxSupportedTransactionVersion: 1});
    expect(block?.transactions).toHaveLength(1);
    expect(block?.transactions[0]?.transaction.message.staticAccountKeys[0]?.toBase58()).toBe(core);
    expect(block?.transactions[0]?.transaction.message.version).toBe(version);
    expect(block?.blockTime).toBe(123);
  });

  it('retains legacy, v0 lookup-loaded and v1 resolved core keys in order', async () => {
    const relevant = [tx([core]), tx([other], 0, {writable: [core], readonly: []}), tx([other], 0, {writable: [], readonly: [core]}), tx([core], 1)];
    relevant[1]!.transaction.message.addressTableLookups = [{accountKey: other, writableIndexes: [0], readonlyIndexes: []}] as never;
    relevant[2]!.transaction.message.addressTableLookups = [{accountKey: other, writableIndexes: [], readonlyIndexes: [0]}] as never;
    const response = await filtered([tx(), ...relevant, tx()]);
    expect(response.result.transactions).toEqual(relevant);
    expect(response.result.blockTime).toBe(123);
  });

  it('keeps lookup indexes usable by the actual v0 Connection decoder', async () => {
    const relevant = tx([other], 0, {writable: [], readonly: [core]});
    relevant.transaction.message.addressTableLookups = [{accountKey: other, writableIndexes: [], readonlyIndexes: [0]}] as never;
    const result = {blockhash: other, previousBlockhash: other, parentSlot: 99, blockTime: 123, blockHeight: 100, transactions: [tx(), relevant]};
    const fetcher = vi.fn(async (_url, options) => new Response(JSON.stringify({jsonrpc: '2.0', id: JSON.parse(String(options?.body)).id, result})));
    const connection = new Connection('https://example.invalid', {fetch: createHistoryFetch(core, fetcher)});
    const block = await connection.getBlock(100, {maxSupportedTransactionVersion: 1});
    expect(block?.transactions).toHaveLength(1);
    const decoded = block!.transactions[0]!;
    expect(decoded.transaction.message.getAccountKeys({accountKeysFromLookups: decoded.meta!.loadedAddresses}).get(1)?.toBase58()).toBe(core);
  });

  it('keeps a produced block present when every transaction is unrelated', async () => {
    const response = await filtered([tx()]);
    expect(response.result.transactions).toEqual([]);
    expect(response.result.blockTime).toBe(123);
  });

  it.each(['writable', 'readonly'] as const)('holds the replay cursor when v0 %s lookup addresses are truncated', async side => {
    const incomplete = tx([other], 0);
    incomplete.transaction.message.addressTableLookups = [{accountKey: other, writableIndexes: side === 'writable' ? [0] : [], readonlyIndexes: side === 'readonly' ? [0] : []}] as never;
    const result = {blockhash: other, previousBlockhash: other, parentSlot: 99, blockTime: 123, blockHeight: 100, transactions: [incomplete]};
    const fetcher = vi.fn(async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      return new Response(JSON.stringify({jsonrpc: '2.0', id: request.id, result: request.method === 'getBlocks' ? [100] : result}));
    });
    const connection = new Connection('https://example.invalid', {fetch: createHistoryFetch(core, fetcher)});
    const store = createStore(':memory:');
    store.setSyncCursor(99);
    try {
      const replay = await syncChunk({connection, store, corePk: new PublicKey(core), matcherPk: new PublicKey(other), startSlot: 100, endSlot: 100});
      expect(replay.success).toBe(false);
      expect(String(replay.error)).toMatch(/lookup addresses/);
      expect(store.getSyncState().processedThroughSlot).toBe(99);
    } finally { store.close(); }
  });

  it('retains incomplete ordinary metadata for downstream validation', async () => {
    const missingMeta = {...tx(), meta: null};
    const missingKeys = {...tx(), transaction: {message: {}}};
    const malformedLoaded = {...tx(), meta: {...tx().meta, loadedAddresses: {writable: null, readonly: []}}};
    const incomplete = [missingMeta, missingKeys, malformedLoaded];
    expect((await filtered(incomplete)).result.transactions).toEqual(JSON.parse(JSON.stringify(incomplete)));
  });

  it('rejects missing loaded addresses when v0 lookup indexes require them', async () => {
    const unresolved = tx([other], 0);
    unresolved.transaction.message.addressTableLookups = [{accountKey: other, writableIndexes: [0], readonlyIndexes: []}] as never;
    const missingLoaded = {...unresolved, meta: {...unresolved.meta, loadedAddresses: undefined}};
    await expect(filtered([missingLoaded])).rejects.toThrow('Incomplete transaction lookup addresses');
  });

  it('retains unsupported transaction versions for the SDK to reject', async () => {
    const unsupported = {...tx(), version: 2};
    expect((await filtered([unsupported])).result.transactions).toEqual([unsupported]);
  });

  it.each([null, {code: -32004, message: 'Block unavailable'}])('preserves unavailable blocks and RPC errors (%j)', async value => {
    const body = value === null ? {result: null} : {error: value};
    const fetcher = vi.fn(async () => new Response(JSON.stringify({jsonrpc: '2.0', id: 1, ...body})));
    const response = await createHistoryFetch(core, fetcher)('https://example.invalid', {body: JSON.stringify({method: 'getBlock'})});
    expect(await response.json()).toEqual({jsonrpc: '2.0', id: 1, ...body});
  });

  it('passes through non-block calls and unsuccessful HTTP responses untouched', async () => {
    const response = new Response('rate limited', {status: 429});
    const fetcher = vi.fn(async () => response);
    expect(await createHistoryFetch(core, fetcher)('https://example.invalid', {body: JSON.stringify({method: 'getBlock'})})).toBe(response);
    expect(await createHistoryFetch(core, fetcher)('https://example.invalid', {body: JSON.stringify({method: 'getAccountInfo'})})).toBe(response);
  });
});
