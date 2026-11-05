import { describe, expect, it, vi } from 'vitest';
import { Keypair, MessageV0, PublicKey } from '@solana/web3.js';
import { createStore } from './store.js';
import { createSyncer } from './syncer.js';
import { layouts } from '../../../packages/layout/index.js';
import { instructions } from '../../../packages/layout/instructions.js';

const corePk = new PublicKey('9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT');
const matcherPk = new PublicKey('68MQqdugxZQA2F8GahhWZEusPnHbrfAXjqq2V9VCz8tK');
const payer = Keypair.generate().publicKey;

interface LedgerTx { signature: string; slot: number; err: unknown; response: unknown }

function message(keys: PublicKey[], disc: number, accountKeyIndexes: number[] = []) {
  return new MessageV0({
    header: {numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1},
    staticAccountKeys: keys, recentBlockhash: PublicKey.default.toBase58(),
    compiledInstructions: [{programIdIndex: 1, accountKeyIndexes, data: Uint8Array.of(disc)}],
    addressTableLookups: [],
  });
}

/** A core transaction that is not a settlement. */
function plainTx(signature: string, slot: number, err: unknown = null): LedgerTx {
  return {signature, slot, err, response: {slot, blockTime: 1_700_000_000 + slot,
    meta: {err, logMessages: [`Program ${corePk} invoke [1]`, `Program ${corePk} success`], innerInstructions: [], loadedAddresses: {writable: [], readonly: []}},
    transaction: {signatures: [signature], message: message([payer, corePk], 0)}}};
}

/** A settlement of `batchId` whose one effective fill has quantity `qty`. */
function settleTx(signature: string, slot: number, batchId: bigint, qty: bigint, accounts: Map<string, unknown>): LedgerTx {
  const batch = Keypair.generate().publicKey, results = Keypair.generate().publicKey;
  const batchData = Buffer.alloc(layouts.Batch.size); batchData[0] = layouts.Batch.discriminator!; batchData[1] = 1;
  batchData.writeBigUInt64LE(batchId, 8); batchData[16] = 3;
  const resultsData = Buffer.alloc(51 + 58); resultsData[0] = 8; resultsData[1] = 1;
  resultsData.writeBigUInt64LE(batchId, 8); resultsData[16] = 1; resultsData.writeUInt16LE(1, 49);
  resultsData.fill(22, 51, 83); resultsData.writeBigUInt64LE(qty, 91); resultsData.writeBigInt64LE(100_000_000n, 99);
  const receipt = Buffer.alloc(18); receipt.writeBigUInt64LE(batchId); receipt.writeUInt16LE(1, 8); receipt.writeBigUInt64LE(qty, 10);
  accounts.set(batch.toBase58(), {owner: corePk, data: batchData});
  accounts.set(results.toBase58(), {owner: matcherPk, data: resultsData});
  return {signature, slot, err: null, response: {slot, blockTime: 1_700_000_000 + slot,
    meta: {err: null, innerInstructions: [], loadedAddresses: {writable: [], readonly: []}, logMessages: [
      `Program ${corePk} invoke [1]`,
      `Program data: ${Buffer.from('mgk-settlement-v1').toString('base64')} ${receipt.toString('base64')}`,
      `Program ${corePk} success`]},
    transaction: {signatures: [signature], message: message([batch, corePk, matcherPk, results], instructions.core.SettleBatch.disc, [0, 1, 2, 3])}}};
}

/**
 * Fake RPC over an ordered (oldest first) core-program ledger that counts every call.
 * Models provider retention: transactions below `state.firstAvailable` are pruned, and an
 * unknown (or pruned) `until` is ignored, as agave does. `pageCap` models a provider that
 * returns short pages before its history is exhausted.
 */
function fakeRpc(ledger: LedgerTx[], options: {slot: number; firstAvailable?: number; accounts?: Map<string, unknown>; pageCap?: number}) {
  const calls: Record<string, number> = {};
  const count = (method: string) => { calls[method] = (calls[method] ?? 0) + 1; };
  const state = {
    slot: options.slot,
    ledger,
    firstAvailable: options.firstAvailable ?? 0,
    /** Every getSignaturesForAddress options object, in call order. */
    signatureQueries: [] as {before?: string; until?: string; limit?: number}[],
    /** Return a value (or throw) to override getTransaction for a signature; undefined falls through. */
    failTransaction: null as null | ((signature: string) => unknown),
    failSignatures: null as null | (() => void),
  };
  const retained = () => state.ledger.filter(t => t.slot >= state.firstAvailable);
  const connection = {
    getSlot: async () => { count('getSlot'); return state.slot; },
    getFirstAvailableBlock: async () => { count('getFirstAvailableBlock'); return state.firstAvailable; },
    getSignaturesForAddress: async (address: PublicKey, opts: {before?: string; until?: string; limit?: number} = {}) => {
      count('getSignaturesForAddress');
      state.signatureQueries.push({...opts});
      state.failSignatures?.();
      if (!address.equals(corePk)) throw new Error('unexpected address');
      let newestFirst = [...retained()].reverse();
      if (opts.before) newestFirst = newestFirst.slice(newestFirst.findIndex(t => t.signature === opts.before) + 1);
      if (opts.until) { const i = newestFirst.findIndex(t => t.signature === opts.until); if (i >= 0) newestFirst = newestFirst.slice(0, i); }
      const limit = Math.min(opts.limit ?? 1000, options.pageCap ?? Infinity);
      return newestFirst.slice(0, limit).map(t => ({signature: t.signature, slot: t.slot, err: t.err, memo: null, blockTime: null}));
    },
    getTransaction: async (signature: string) => {
      count('getTransaction');
      if (state.failTransaction) { const r = state.failTransaction(signature); if (r !== undefined) return r; }
      return retained().find(t => t.signature === signature)?.response ?? null;
    },
    getAccountInfo: async (pk: PublicKey) => { count('getAccountInfo'); return options.accounts?.get(pk.toBase58()) ?? null; },
    onLogs: vi.fn().mockReturnValue(1),
    removeOnLogsListener: vi.fn().mockResolvedValue(undefined),
  };
  const total = () => Object.values(calls).reduce((a, b) => a + b, 0);
  const reset = () => { for (const k of Object.keys(calls)) delete calls[k]; state.signatureQueries.length = 0; };
  return {connection: connection as never, calls, total, reset, state};
}

function syncerFor(rpc: ReturnType<typeof fakeRpc>, store = createStore(':memory:'), extra: {startSlot?: number; onFill?: (f: Record<string, unknown>) => void} = {}) {
  const syncer = createSyncer({connection: rpc.connection, store, coreProgramId: corePk.toBase58(), matcherProgramId: matcherPk.toBase58(), startSlot: extra.startSlot ?? 100, onFill: extra.onFill});
  return {syncer, store};
}

/** `count` plain core transactions, two per slot, starting at `firstSlot`. */
function ledgerOf(count: number, firstSlot = 100, prefix = 'sig'): LedgerTx[] {
  return Array.from({length: count}, (_, i) => plainTx(`${prefix}-${i}`, firstSlot + Math.floor(i / 2)));
}

describe('syncer - signature-driven history replay', () => {
  it('replays an empty store across multiple signature pages back to the start slot', async () => {
    const ledger = [plainTx('before-start', 50), ...ledgerOf(2500)];
    const rpc = fakeRpc(ledger, {slot: 5000});
    const {syncer, store} = syncerFor(rpc);
    await syncer.triggerSync();
    expect(rpc.calls.getTransaction).toBe(2500);
    expect(store.getSyncState().processedThroughSlot).toBe(5000);
    store.close();
  });

  it('resumes from the committed cursor without refetching replayed transactions', async () => {
    const accounts = new Map<string, unknown>();
    const ledger = [settleTx('old', 150, 1n, 5n, accounts), settleTx('new', 151, 2n, 7n, accounts)];
    const rpc = fakeRpc(ledger, {slot: 200, accounts});
    const store = createStore(':memory:');
    store.updateSyncSuccess(150, 1_700_000_000_000);
    const fills: Record<string, unknown>[] = [];
    const {syncer} = syncerFor(rpc, store, {onFill: f => fills.push(f)});
    await syncer.triggerSync();
    expect(rpc.calls.getTransaction).toBe(1);
    expect(fills.map(f => f.batch_id)).toEqual([2]);
    expect(store.getSyncState().processedThroughSlot).toBe(200);
    store.close();
  });

  it('replays oldest to newest, preserving slot order and in-block order', async () => {
    const accounts = new Map<string, unknown>();
    // Ledger order is chain order: slot 300 holds batches 1 then 2; slot 301 holds batch 3.
    const ledger = [settleTx('a', 300, 1n, 1n, accounts), settleTx('b', 300, 2n, 2n, accounts), settleTx('c', 301, 3n, 3n, accounts)];
    const rpc = fakeRpc(ledger, {slot: 400, accounts});
    const fills: Record<string, unknown>[] = [];
    const {syncer, store} = syncerFor(rpc, undefined, {onFill: f => fills.push(f)});
    await syncer.triggerSync();
    expect(fills.map(f => [f.slot, f.batch_id, f.qty])).toEqual([[300, 1, 1], [300, 2, 2], [301, 3, 3]]);
    expect(store.db.prepare('SELECT count(*) AS n FROM candles_1m').get()).toEqual({n: 1});
    store.close();
  });

  it('skips failed transactions without fetching them', async () => {
    const accounts = new Map<string, unknown>();
    const failed = settleTx('failed', 120, 9n, 9n, accounts);
    failed.err = {InstructionError: [0, {Custom: 1}]};
    const rpc = fakeRpc([failed, settleTx('ok', 121, 1n, 4n, accounts)], {slot: 130, accounts});
    const fills: Record<string, unknown>[] = [];
    const {syncer, store} = syncerFor(rpc, undefined, {onFill: f => fills.push(f)});
    await syncer.triggerSync();
    expect(rpc.calls.getTransaction).toBe(1);
    expect(fills.map(f => f.batch_id)).toEqual([1]);
    expect(store.getSyncState().processedThroughSlot).toBe(130);
    store.close();
  });

  it.each([
    ['a missing transaction', (rpc: ReturnType<typeof fakeRpc>) => { rpc.state.failTransaction = sig => sig === 'sig-3' ? null : undefined; }],
    ['a getTransaction 429', (rpc: ReturnType<typeof fakeRpc>) => { rpc.state.failTransaction = sig => { if (sig === 'sig-3') throw new Error('429 Too Many Requests'); }; }],
    ['a signature-page 429', (rpc: ReturnType<typeof fakeRpc>) => { rpc.state.failSignatures = () => { throw new Error('429 Too Many Requests'); }; }],
  ])('holds the cursor and records a poll failure on %s', async (_name, inject) => {
    const rpc = fakeRpc(ledgerOf(6), {slot: 500});
    inject(rpc);
    const store = createStore(':memory:');
    store.updateSyncSuccess(99, 1_700_000_000_000);
    const {syncer} = syncerFor(rpc, store);
    await syncer.triggerSync();
    expect(store.getSyncState().processedThroughSlot).toBe(99);
    expect(store.getSyncState().lastSyncErrorAt).not.toBeNull();
    expect(syncer.getHealthTracker().snapshot(500).status).toBe('degraded');

    // The next tick retries the held range and catches up.
    rpc.state.failTransaction = null; rpc.state.failSignatures = null;
    await syncer.triggerSync();
    expect(store.getSyncState().processedThroughSlot).toBe(500);
    store.close();
  });

  it('refuses to replay from a cursor older than the archival floor', async () => {
    const rpc = fakeRpc(ledgerOf(4), {slot: 500, firstAvailable: 1000});
    const {syncer, store} = syncerFor(rpc);
    await syncer.triggerSync();
    expect(store.getSyncState().processedThroughSlot).toBeNull();
    expect(rpc.calls.getSignaturesForAddress).toBeUndefined();
    store.close();
  });

  it('advances the slot cursor to the pre-scan confirmed slot when there are no new transactions', async () => {
    const rpc = fakeRpc(ledgerOf(4), {slot: 500});
    const {syncer, store} = syncerFor(rpc);
    await syncer.triggerSync();
    expect(store.getSyncState().processedThroughSlot).toBe(500);
    rpc.state.slot = 900;
    await syncer.triggerSync();
    expect(store.getSyncState().processedThroughSlot).toBe(900);
    store.close();
  });

  it('picks up new transactions on the next tick and never moves the cursor backwards', async () => {
    const accounts = new Map<string, unknown>();
    const rpc = fakeRpc([settleTx('first', 100, 1n, 1n, accounts)], {slot: 500, accounts});
    const fills: Record<string, unknown>[] = [];
    const {syncer, store} = syncerFor(rpc, undefined, {onFill: f => fills.push(f)});
    await syncer.triggerSync();
    // A late-indexed transaction below the cursor still arrives via the signature scan.
    rpc.state.ledger.push(settleTx('second', 480, 2n, 2n, accounts));
    rpc.state.slot = 520;
    await syncer.triggerSync();
    expect(fills.map(f => f.batch_id)).toEqual([1, 2]);
    expect(store.getSyncState().processedThroughSlot).toBe(520);
    store.close();
  });

  it('keeps committed progress when a later segment fails', async () => {
    const store = createStore(':memory:');
    const rpc = fakeRpc(ledgerOf(2500), {slot: 5000});
    rpc.state.failTransaction = sig => { if (sig === 'sig-2200') throw new Error('429 Too Many Requests'); };
    const {syncer} = syncerFor(rpc, store);
    await syncer.triggerSync();
    // Segments 1-2 (sig-0..sig-1999, slots 100..1099) committed before sig-2200 failed.
    expect(store.getSyncState().processedThroughSlot).toBe(1099);

    rpc.state.failTransaction = null;
    rpc.reset();
    await syncer.triggerSync();
    expect(rpc.calls.getTransaction).toBe(500);
    expect(store.getSyncState().processedThroughSlot).toBe(5000);
    store.close();
  });
});

describe('syncer - gaps never look like replayed history', () => {
  it('keeps walking past short pages until it reaches the start slot', async () => {
    // The provider returns 400-signature pages although 1000 were asked for.
    const rpc = fakeRpc(ledgerOf(1000), {slot: 5000, pageCap: 400});
    const {syncer, store} = syncerFor(rpc);
    await syncer.triggerSync();
    expect(rpc.calls.getTransaction).toBe(1000);
    expect(store.getSyncState().processedThroughSlot).toBe(5000);
    store.close();
  });

  it('flags a cursor the pruning floor has overtaken since it was cached', async () => {
    vi.useFakeTimers({toFake: ['Date']});
    try {
      const rpc = fakeRpc(ledgerOf(4), {slot: 5000});
      const store = createStore(':memory:');
      const {syncer} = syncerFor(rpc, store);
      await syncer.triggerSync();
      expect(store.getSyncState().processedThroughSlot).toBe(5000);

      // The process sleeps (no new slots) while the provider prunes past the cursor.
      rpc.state.firstAvailable = 6000;
      vi.setSystemTime(Date.now() + 10 * 60_000);
      rpc.state.slot = 7000;
      await syncer.triggerSync();
      expect(store.getSyncState().processedThroughSlot).toBe(5000);
      expect(store.getSyncState().lastSyncErrorAt).not.toBeNull();
      expect(syncer.getHealthTracker().snapshot(7000).status).toBe('degraded');
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-reads the floor every tick while the cursor is near it', async () => {
    const rpc = fakeRpc([], {slot: 5000, firstAvailable: 4800});
    const store = createStore(':memory:');
    store.updateSyncSuccess(4900, 1_700_000_000_000);
    const {syncer} = syncerFor(rpc, store);
    await syncer.triggerSync();
    expect(store.getSyncState().processedThroughSlot).toBe(5000);

    // No time passes, but the floor moves past the cursor; the next tick must notice.
    rpc.state.firstAvailable = 5200;
    rpc.state.slot = 5100;
    await syncer.triggerSync();
    expect(store.getSyncState().processedThroughSlot).toBe(5000);
    expect(syncer.getHealthTracker().snapshot(5100).status).toBe('degraded');
    store.close();
  });
});

describe('syncer - RPC budget', () => {
  it('catch-up costs ceil(N/1000) + 1 + N history calls + 2 per settlement; an idle tick costs 2', async () => {
    const accounts = new Map<string, unknown>();
    const M = 2497, S = 3;
    const ledger = [...ledgerOf(M), ...Array.from({length: S}, (_, i) => settleTx(`settle-${i}`, 2000 + i, BigInt(i + 1), 1n, accounts))];
    const N = M + S;
    const rpc = fakeRpc(ledger, {slot: 5000, accounts});
    const {syncer, store} = syncerFor(rpc);
    await syncer.triggerSync();
    // ceil(N/1000) pages, the last one short; with no signature at or below the start slot
    // seen, one more page (before = oldest) must come back empty to prove the end of history.
    expect(rpc.calls.getSignaturesForAddress).toBe(Math.ceil(N / 1000) + 1);
    expect(rpc.calls.getTransaction).toBe(N);
    // Each SettleBatch reads its Batch and Results accounts.
    expect(rpc.calls.getAccountInfo).toBe(2 * S);
    // Plus getSlot (health) and one getFirstAvailableBlock (retention floor).
    expect(rpc.total()).toBe(Math.ceil(N / 1000) + 1 + N + 2 * S + 2);
    console.log(`[rpc-budget] catch-up N=${N} (S=${S} settlements): ${rpc.total()} calls`, rpc.calls);

    for (let tick = 0; tick < 3; tick++) {
      rpc.reset();
      rpc.state.slot += 5;
      await syncer.triggerSync();
      expect(rpc.total()).toBe(2);
      expect(rpc.calls.getFirstAvailableBlock).toBeUndefined();
    }
    console.log('[rpc-budget] idle tick:', rpc.total(), 'calls', rpc.calls);
    expect(store.getSyncState().processedThroughSlot).toBe(5015);
    store.close();
  });

  it('a restarted process reaches the 2-call idle tick after one catch-up tick', async () => {
    const rpc = fakeRpc(ledgerOf(10), {slot: 5000});
    const store = createStore(':memory:');
    await syncerFor(rpc, store).syncer.triggerSync();
    const {syncer} = syncerFor(rpc, store);
    rpc.reset();
    await syncer.triggerSync();
    expect(rpc.calls.getTransaction).toBeUndefined();
    rpc.reset();
    await syncer.triggerSync();
    expect(rpc.total()).toBe(2);
    store.close();
  });
});

describe('syncer - lifecycle', () => {
  it('truthful subscription health sets flags true only after onLogs and false on stop', async () => {
    const rpc = fakeRpc([], {slot: 100});
    const {syncer, store} = syncerFor(rpc);
    expect(syncer.getRuntimeHealth().subscriptions).toEqual({ core: false, matcher: false });
    await syncer.start();
    expect(syncer.getRuntimeHealth().subscriptions).toEqual({ core: true, matcher: true });
    await syncer.stop();
    expect(syncer.getRuntimeHealth().subscriptions).toEqual({ core: false, matcher: false });
    store.close();
  });

  it('single-flight worker coalesces overlapping triggers', async () => {
    const rpc = fakeRpc([], {slot: 200});
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const listSignatures = (rpc.connection as {getSignaturesForAddress: (...a: unknown[]) => Promise<unknown>}).getSignaturesForAddress;
    let scans = 0;
    (rpc.connection as {getSignaturesForAddress: unknown}).getSignaturesForAddress = async (...args: unknown[]) => { scans++; await gate; return listSignatures(...args); };
    const store = createStore(':memory:');
    store.setSyncCursor(100);
    const {syncer} = syncerFor(rpc, store);

    const runs = [syncer.triggerSync(), syncer.triggerSync(), syncer.triggerSync()];
    await new Promise(r => setTimeout(r, 10));
    expect(scans).toBe(1);
    release();
    await Promise.all(runs);
    // The coalesced re-scan runs once, not once per trigger.
    expect(scans).toBe(2);
    expect(store.getSyncState().processedThroughSlot).toBe(200);
    store.close();
  });
});
