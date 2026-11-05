import { Connection, PublicKey, type ConfirmedSignatureInfo, type VersionedTransactionResponse } from '@solana/web3.js';
import { coreInvocations } from './coreInvocations.js';
import { instructions } from '../../../packages/layout/instructions.js';
import * as sdk from '@mgk/sdk';
import type { Store } from './store.js';
import { decodeBatchEvent, decodeDfbaFills } from './decoder.js';
import { aggregateCandles } from './aggregator.js';
import { resultsLayout, decodeAccount } from '../../../packages/layout/index.js';
import { settlementQuantities } from './settlementReceipt.js';
import { createHealthTracker, type HealthTracker } from './healthTracker.js';

/** Provider maximum for one getSignaturesForAddress page. */
const SIGNATURE_PAGE_LIMIT = 1000;
/** Concurrent getTransaction requests during replay. */
const TRANSACTION_FETCH_CONCURRENCY = 4;

export interface SyncHistoryParams {
  connection: Connection;
  store: Store;
  marketSeed?: string | null;
  corePk: PublicKey;
  matcherPk: PublicKey;
  /** Highest committed slot. Without `untilSignature`, signatures at or below it count as replayed. */
  cursorSlot: number;
  /** Newest signature already replayed by this process; only newer signatures are scanned. */
  untilSignature?: string | null;
  /** Confirmed slot read before the scan; the cursor advances to it once history is caught up. */
  confirmedSlot: number;
  /** Signatures replayed per atomic commit, so progress survives a later failure. */
  segmentSize?: number;
  onFill?: (fill: Record<string, unknown>) => void;
}

export interface SyncHistoryResult {
  success: boolean;
  txsProcessed: number;
  fillsInserted: number;
  /** Newest signature known to be replayed (committed or already below the cursor), if any. */
  newestSignature: string | null;
  error?: unknown;
}

export interface DecodedFillItem {
  slot: number;
  fillIndex: number;
  batchId: bigint;
  instrumentId: number;
  takerSide: number;
  price: bigint;
  qty: bigint;
  takerPubkey: Uint8Array;
  makerPubkey: Uint8Array;
  txSignature: string;
  isMaker: boolean;
}

/** List core signatures not yet replayed, oldest first (slot order, then in-block order). */
async function listNewSignatures(
  connection: Connection, corePk: PublicKey, cursorSlot: number, until: string | null,
): Promise<{pending: ConfirmedSignatureInfo[]; newestSeen: string | null}> {
  const newestFirst: ConfirmedSignatureInfo[] = [];
  let newestSeen: string | null = null;
  let before: string | undefined;
  for (;;) {
    const page = await connection.getSignaturesForAddress(
      corePk, {before, until: until ?? undefined, limit: SIGNATURE_PAGE_LIMIT}, 'confirmed');
    newestSeen ??= page[0]?.signature ?? null;
    let reachedCursor = false;
    for (const entry of page) {
      if (until === null && entry.slot <= cursorSlot) { reachedCursor = true; break; }
      newestFirst.push(entry);
    }
    // A short page is the end of the address history (archival coverage is checked by the caller).
    if (reachedCursor || page.length < SIGNATURE_PAGE_LIMIT) break;
    const next = page.at(-1)!.signature;
    if (next === before) throw new Error('Signature history did not progress');
    before = next;
  }
  return {pending: newestFirst.reverse(), newestSeen};
}

/**
 * Map with bounded concurrency, preserving input order. The first failure stops
 * every worker from starting new calls; in-flight calls drain before rethrowing,
 * so no request outlives the failed tick.
 */
async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failure: {error: unknown} | null = null;
  const worker = async () => {
    while (failure === null && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!);
      } catch (error) {
        failure ??= {error};
      }
    }
  };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  if (failure !== null) throw (failure as {error: unknown}).error;
  return out;
}

/** Decode the effective settlement fills of one committed core transaction. */
async function decodeTransaction(
  params: SyncHistoryParams, txResp: VersionedTransactionResponse, slot: number, signature: string,
): Promise<DecodedFillItem[]> {
  const { connection, corePk, matcherPk } = params;
  if (!txResp.meta) throw new Error('Transaction metadata unavailable');
  if (txResp.meta.err) return [];
  const decoded: DecodedFillItem[] = [];
  const msg = txResp.transaction.message;
  for (const ix of coreInvocations(msg, txResp.meta, corePk, params.marketSeed)) {
    if (!ix.success || ix.data[0] !== instructions.core.SettleBatch.disc) continue;
    const staticKeys = Array.from({length: ix.keys.length}, (_, i) => ix.keys.get(i)!);

    const batchIdx = ix.accountKeyIndexes[0];
    const batchPk = batchIdx === undefined ? undefined : staticKeys[batchIdx];
    if (!batchPk) throw new Error('Settlement missing batch address');
    const batchInfo = await connection.getAccountInfo(batchPk, 'confirmed');
    if (!batchInfo || !batchInfo.owner.equals(corePk)) throw new Error('Settlement batch unavailable or wrong owner');
    const batch = decodeAccount('Batch', batchInfo.data);
    if (params.marketSeed && !sdk.deriveBatchPda(batch.batchId, corePk, {marketSeed: params.marketSeed})[0].equals(batchPk)) throw new Error('Settlement batch outside selected market');
    if (batch.status !== 3) throw new Error('Settlement batch not settled');
    const resultsIdx = ix.accountKeyIndexes[3];
    const resultsPk = resultsIdx === undefined ? undefined : staticKeys[resultsIdx];
    if (!resultsPk) throw new Error('Settlement missing results address');
    if (params.marketSeed) {
      const expected = sdk.deriveResultsPda(batch.batchId, matcherPk, {marketSeed: params.marketSeed, coreProgramId: corePk})[0];
      if (!expected.equals(resultsPk)) throw new Error('Settlement results outside selected market');
    }
    const accInfo = await connection.getAccountInfo(resultsPk, 'confirmed');
    if (!accInfo || !accInfo.owner.equals(matcherPk)) throw new Error('Settlement results unavailable or wrong owner');
    const results = sdk.state.decodeResults(accInfo.data);
    if (!results.spent || results.batchId !== batch.batchId) throw new Error('Settlement results not spent or batch mismatch');
    const quantities = settlementQuantities(ix.logs, corePk.toBase58(), batch.batchId, results.fills.map(f => f.qty));
    const adjusted = Uint8Array.from(accInfo.data);
    // Wire offsets come from the frozen shared results contract.
    const view = new DataView(adjusted.buffer);
    for (let i = 0; i < quantities.length; i++) view.setBigUint64(resultsLayout.headerSize + i * resultsLayout.fillSize + 40, quantities[i]!, true);
    if (txResp.blockTime == null) throw new Error('Settlement block time unavailable');
    decoded.push(...decodeDfbaFills(adjusted, slot, batch.batchId, 0, signature));
  }
  return decoded;
}

/** Commit fills, candles and the cursor atomically; broadcast only newly inserted fills. */
function commitSegment(
  store: Store, fills: DecodedFillItem[], blockTimes: Map<number, number>, cursorSlot: number,
  onFill?: (fill: Record<string, unknown>) => void,
): number {
  const newlyInsertedFills: DecodedFillItem[] = [];
  const now = Date.now();
  store.db.transaction(() => {
    for (const fill of fills) {
      const info = store.insertFill.run([
        fill.slot,
        Number(fill.batchId),
        fill.instrumentId,
        fill.takerSide,
        Number(fill.price),
        Number(fill.qty),
        Buffer.from(fill.takerPubkey),
        Buffer.from(fill.makerPubkey),
        Buffer.from(fill.txSignature, 'utf-8'),
        fill.isMaker ? 1 : 0,
        fill.fillIndex,
      ]);
      if (info.changes > 0) {
        newlyInsertedFills.push(fill);
        aggregateCandles(store, [{
          instrumentId: fill.instrumentId,
          timestampMs: blockTimes.get(fill.slot)!,
          price: fill.price,
          qty: fill.qty,
        }]);
      }
    }
    store.updateSyncSuccess(cursorSlot, now);
  })();

  // Retries cannot duplicate broadcasts: only rows this commit inserted are sent.
  if (onFill) {
    for (const fill of newlyInsertedFills) {
      onFill({
        slot: fill.slot,
        batch_id: Number(fill.batchId),
        instrument_id: fill.instrumentId,
        taker_side: fill.takerSide,
        price: Number(fill.price),
        qty: Number(fill.qty),
        taker_pubkey: Buffer.from(fill.takerPubkey),
        maker_pubkey: Buffer.from(fill.makerPubkey),
        tx_signature: Buffer.from(fill.txSignature, 'utf-8'),
        is_maker: fill.isMaker ? 1 : 0,
      });
    }
  }
  return newlyInsertedFills.length;
}

/**
 * Replay core-program history by signature: list signatures newer than the
 * cursor, fetch each committed transaction, decode settlements oldest first and
 * commit fills + candles + cursor atomically per segment. Any RPC failure,
 * missing transaction or decode fault holds the cursor at the last committed
 * segment, so a gap never looks like replayed history.
 */
export async function syncHistory(params: SyncHistoryParams): Promise<SyncHistoryResult> {
  const { connection, store, corePk, confirmedSlot, onFill } = params;
  const segmentSize = Math.max(1, params.segmentSize ?? SIGNATURE_PAGE_LIMIT);
  let cursorSlot = params.cursorSlot;
  let newestSignature = params.untilSignature ?? null;
  let txsProcessed = 0;
  let fillsInserted = 0;

  try {
    const {pending, newestSeen} = await listNewSignatures(connection, corePk, cursorSlot, params.untilSignature ?? null);
    if (pending.length === 0) {
      newestSignature = newestSeen ?? newestSignature;
      cursorSlot = Math.max(cursorSlot, confirmedSlot);
      commitSegment(store, [], new Map(), cursorSlot);
      return {success: true, txsProcessed, fillsInserted, newestSignature};
    }

    for (let start = 0; start < pending.length; start += segmentSize) {
      const segment = pending.slice(start, start + segmentSize);
      const committed = segment.filter(entry => entry.err === null);
      const txs = await mapBounded(committed, TRANSACTION_FETCH_CONCURRENCY, entry => connection.getTransaction(entry.signature, {
        commitment: 'confirmed', maxSupportedTransactionVersion: 1, ...{encoding: 'json'},
      }));

      const fills: DecodedFillItem[] = [];
      const blockTimes = new Map<number, number>();
      for (let i = 0; i < committed.length; i++) {
        const entry = committed[i]!;
        const tx = txs[i];
        if (!tx) throw new Error(`Transaction ${entry.signature} unavailable; cursor held for retry`);
        if (tx.slot !== entry.slot) throw new Error(`Transaction ${entry.signature} slot mismatch`);
        if (tx.blockTime != null) blockTimes.set(entry.slot, tx.blockTime * 1000);
        fills.push(...await decodeTransaction(params, tx, entry.slot, entry.signature));
      }

      // A slot may straddle segments; only commit through the last complete slot.
      const last = segment.at(-1)!;
      const following = pending[start + segmentSize];
      const throughSlot = following === undefined
        ? Math.max(confirmedSlot, last.slot)
        : following.slot === last.slot ? last.slot - 1 : last.slot;
      cursorSlot = Math.max(cursorSlot, throughSlot);
      fillsInserted += commitSegment(store, fills, blockTimes, cursorSlot, onFill);
      txsProcessed += committed.length;
      newestSignature = last.signature;
    }
    return {success: true, txsProcessed, fillsInserted, newestSignature};
  } catch (error) {
    store.updateSyncError(Date.now());
    return {success: false, txsProcessed, fillsInserted, newestSignature, error};
  }
}

export interface SyncerConfig {
  connection: Connection;
  store: Store;
  marketSeed?: string | null;
  coreProgramId: string;
  matcherProgramId: string;
  startSlot?: number;
  pollIntervalMs?: number;
  onFill?: (fill: Record<string, unknown>) => void;
  onBatchEvent?: (event: unknown) => void;
}

export interface SyncerRuntimeHealth {
  rpcSlot: number | null;
  rpcReachable: boolean | null;
  processedThroughSlot: number | null;
  lastSuccessfulSyncAt: number | null;
  lastSyncErrorAt: number | null;
  lastHeartbeat: number | null;
  subscriptions: { core: boolean; matcher: boolean };
  lastBatch: { batchId: number; phase: number; ts: number } | null;
  inFlight: boolean;
}

export interface Syncer {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  triggerSync: () => Promise<void>;
  getRuntimeHealth: () => SyncerRuntimeHealth;
  getHealthTracker: () => HealthTracker;
}

export function createSyncer(config: SyncerConfig): Syncer {
  const {
    connection,
    store,
    coreProgramId,
    matcherProgramId,
    startSlot = 0,
    pollIntervalMs = 2000,
    onFill,
    onBatchEvent,
  } = config;

  const corePk = new PublicKey(coreProgramId);
  const matcherPk = new PublicKey(matcherProgramId);

  const healthTracker = createHealthTracker();

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let batchPollTimer: ReturnType<typeof setInterval> | null = null;
  let coreListenerId: number | null = null;
  let matcherListenerId: number | null = null;

  let inFlight = false;
  let pendingScan = false;

  let rpcSlot: number | null = null;
  let rpcReachable: boolean | null = null;
  let lastHeartbeat: number | null = null;
  let lastBatch: { batchId: number; phase: number; ts: number } | null = null;

  let lastBatchId: bigint | null = null;
  let lastPhase: number | null = null;

  // Newest replayed core signature; steady-state scans fetch only newer ones.
  let newestSignature: string | null = null;
  // Archival floor, read once per process rather than every tick.
  let firstAvailableBlock: number | null = null;

  const runtimeSubscriptions = {
    core: false,
    matcher: false,
  };

  async function pollBatchState(): Promise<void> {
    try {
      const [registryPda] = sdk.deriveRegistryPda(corePk,{marketSeed:config.marketSeed});
      const accounts = await connection.getMultipleAccountsInfo([registryPda]);
      const regData = accounts[0];
      if (!regData) return;

      const registry = sdk.state.decodeRegistry(new Uint8Array(regData.data));
      const batchId = registry.batchIdCounter - 1n;
      if (batchId < 0n) return;

      const [batchPda] = sdk.deriveBatchPda(batchId, corePk,{marketSeed:config.marketSeed});
      const batchAccounts = await connection.getMultipleAccountsInfo([batchPda]);
      const batchData = batchAccounts[0];
      if (!batchData) return;

      const batch = sdk.state.decodeBatch(new Uint8Array(batchData.data));

      lastBatch = {
        batchId: Number(batch.batchId),
        phase: batch.status,
        ts: Date.now(),
      };

      if (batchId !== lastBatchId || batch.status !== lastPhase) {
        const event = decodeBatchEvent(batch);
        store.insertBatchEvent.run([
          Number(event.batchId),
          event.ts,
          event.phase,
          event.numCommitments,
          Number(event.closeSlot),
          Number(event.vwap) / 1e6,
        ]);

        if (onBatchEvent) {
          onBatchEvent(event);
        }

        lastBatchId = batchId;
        lastPhase = batch.status;
      }
    } catch {
      // Best-effort batch state update
    }
  }

  async function triggerSync(): Promise<void> {
    if (inFlight) {
      pendingScan = true;
      return;
    }

    inFlight = true;
    lastHeartbeat = Date.now();

    try {
      do {
        pendingScan = false;

        let currentConfirmedSlot: number;
        try {
          currentConfirmedSlot = await connection.getSlot('confirmed');
          rpcSlot = currentConfirmedSlot;
          rpcReachable = true;
          lastHeartbeat = Date.now();
          healthTracker.recordPollSuccess(currentConfirmedSlot);
        } catch {
          rpcReachable = false;
          healthTracker.recordPollFailure();
          store.updateSyncError(Date.now());
          break;
        }

        const committed = store.getSyncState().processedThroughSlot;
        const cursor = committed ?? startSlot - 1;

        // An archival gap must never masquerade as successfully replayed history.
        firstAvailableBlock ??= await connection.getFirstAvailableBlock();
        if (firstAvailableBlock > cursor + 1) {
          store.updateSyncError(Date.now());
          healthTracker.recordPollFailure();
          break;
        }

        const result = await syncHistory({
          connection,
          store,
          marketSeed: config.marketSeed,
          corePk,
          matcherPk,
          cursorSlot: cursor,
          untilSignature: newestSignature,
          confirmedSlot: currentConfirmedSlot,
          onFill,
        });
        newestSignature = result.newestSignature;
        lastHeartbeat = Date.now();

        if (!result.success) {
          console.error('History replay paused after slot', store.getSyncState().processedThroughSlot ?? cursor, result.error);
          healthTracker.recordPollFailure();
          break;
        }
        healthTracker.recordReconciliation(store.getSyncState().processedThroughSlot ?? cursor);
      } while (pendingScan);
    } catch {
      store.updateSyncError(Date.now());
      healthTracker.recordPollFailure();
    } finally {
      inFlight = false;
    }
  }

  return {
    async start() {
      lastHeartbeat = Date.now();

      // Install truthful log subscriptions
      try {
        coreListenerId = connection.onLogs(
          corePk,
          () => {
            void triggerSync();
          },
          'confirmed',
        );
        runtimeSubscriptions.core = true;
      } catch {
        runtimeSubscriptions.core = false;
      }

      try {
        matcherListenerId = connection.onLogs(
          matcherPk,
          () => {
            void triggerSync();
          },
          'confirmed',
        );
        runtimeSubscriptions.matcher = true;
      } catch {
        runtimeSubscriptions.matcher = false;
      }

      // Start fallback poll loop (every 2s)
      pollTimer = setInterval(() => {
        void triggerSync();
      }, pollIntervalMs);

      // Start batch polling loop (every 5s)
      batchPollTimer = setInterval(() => {
        void pollBatchState();
      }, 5000);

      // Initial runs
      void pollBatchState();
      await triggerSync();
    },

    async stop() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (batchPollTimer) {
        clearInterval(batchPollTimer);
        batchPollTimer = null;
      }

      if (coreListenerId !== null) {
        try {
          await connection.removeOnLogsListener(coreListenerId);
        } catch {
          // ignore
        }
        coreListenerId = null;
      }
      runtimeSubscriptions.core = false;

      if (matcherListenerId !== null) {
        try {
          await connection.removeOnLogsListener(matcherListenerId);
        } catch {
          // ignore
        }
        matcherListenerId = null;
      }
      runtimeSubscriptions.matcher = false;
    },

    triggerSync,

    getRuntimeHealth(): SyncerRuntimeHealth {
      const syncState = store.getSyncState();
      return {
        rpcSlot,
        rpcReachable,
        processedThroughSlot: syncState.processedThroughSlot,
        lastSuccessfulSyncAt: syncState.lastSuccessfulSyncAt,
        lastSyncErrorAt: syncState.lastSyncErrorAt,
        lastHeartbeat,
        subscriptions: { ...runtimeSubscriptions },
        lastBatch,
        inFlight,
      };
    },

    getHealthTracker(): HealthTracker {
      return healthTracker;
    },
  };
}
