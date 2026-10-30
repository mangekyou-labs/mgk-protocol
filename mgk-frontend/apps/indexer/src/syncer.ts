import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import * as sdk from '@mgk/sdk';
import type { Store } from './store.js';
import { decodeBatchEvent, decodeDfbaFills } from './decoder.js';
import { aggregateCandles } from './aggregator.js';
import { splitSlotRanges } from './backfill.js';
import { resultsLayout, decodeAccount } from '../../../packages/layout/index.js';
import { settlementQuantities } from './settlementReceipt.js';
import { createHealthTracker, type HealthTracker } from './healthTracker.js';

export interface SyncChunkParams {
  connection: Connection;
  store: Store;
  corePk: PublicKey;
  matcherPk: PublicKey;
  startSlot: number;
  endSlot: number;
  onFill?: (fill: Record<string, unknown>) => void;
}

export interface SyncChunkResult {
  success: boolean;
  slotsProcessed: number;
  fillsInserted: number;
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

/**
 * Fetch and decode all blocks in [startSlot, endSlot] and commit fills + candles + cursor atomically.
 * On any RPC failure, nothing is committed and the chunk is left uncommitted for retry.
 */
export async function syncChunk(params: SyncChunkParams): Promise<SyncChunkResult> {
  const { connection, store, corePk, matcherPk, startSlot, endSlot, onFill } = params;
  if (startSlot > endSlot) {
    return { success: true, slotsProcessed: 0, fillsInserted: 0 };
  }

  const decodedFills: DecodedFillItem[] = [];
  const blockTimes = new Map<number, number>();

  try {
    // Solana getBlocks returns only slots that actually produced confirmed blocks
    // Split into provider-safe sub-ranges if necessary (e.g. 64 slots per getBlocks call)
    const blockSlots: number[] = [];
    const ranges = splitSlotRanges(startSlot, endSlot, 64);
    for (const [rStart, rEnd] of ranges) {
      const slots = await connection.getBlocks(rStart, rEnd, 'confirmed');
      blockSlots.push(...slots);
    }

    for (const slot of blockSlots) {
      const block = await connection.getBlock(slot, {
        maxSupportedTransactionVersion: 1,
        commitment: 'confirmed',
        ...{encoding: 'json'},
      });
      if (block?.blockTime != null) blockTimes.set(slot, block.blockTime * 1000);
      if (!block?.transactions) throw new Error(`Block ${slot} unavailable; cursor held for retry`);

      for (const txResp of block.transactions) {
        if (!txResp.meta) throw new Error('Transaction metadata unavailable');
        if (txResp.meta.err) continue;
        const msg = txResp.transaction.message;
        const keys = msg.getAccountKeys({accountKeysFromLookups: txResp.meta.loadedAddresses});
        const staticKeys = Array.from({length: keys.length}, (_, i) => keys.get(i)!);
        const compiledIxs = msg.compiledInstructions;
        for (const ix of compiledIxs) {
          const progKey = staticKeys[ix.programIdIndex];
          if (!progKey || !progKey.equals(corePk)) continue;

          const data = ix.data;
          let parsed: Uint8Array;
          if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
            parsed = new Uint8Array(data);
          } else if (typeof data === 'string') {
            parsed = bs58.decode(data);
          } else {
            continue;
          }

          if (parsed.length < 1 || parsed[0] !== 8) continue; // SettleBatch discriminator = 8

          const batchIdx = ix.accountKeyIndexes[0];
          const batchPk = batchIdx === undefined ? undefined : staticKeys[batchIdx];
          if (!batchPk) throw new Error('Settlement missing batch address');
          const batchInfo = await connection.getAccountInfo(batchPk, 'confirmed');
          if (!batchInfo || !batchInfo.owner.equals(corePk)) throw new Error('Settlement batch unavailable or wrong owner');
          const batch = decodeAccount('Batch', batchInfo.data);
          if (batch.status !== 3) throw new Error('Settlement batch not settled');
          const resultsIdx = ix.accountKeyIndexes[3];
          const resultsPk = resultsIdx === undefined ? undefined : staticKeys[resultsIdx];
          if (!resultsPk) throw new Error('Settlement missing results address');
          const accInfo = await connection.getAccountInfo(resultsPk, 'confirmed');
          if (!accInfo || !accInfo.owner.equals(matcherPk)) throw new Error('Settlement results unavailable or wrong owner');
          const results = sdk.state.decodeResults(accInfo.data);
          if (!results.spent || results.batchId !== batch.batchId) throw new Error('Settlement results not spent or batch mismatch');
          const quantities = settlementQuantities(txResp.meta.logMessages, corePk.toBase58(), batch.batchId, results.fills.map(f => f.qty));
          const adjusted = Uint8Array.from(accInfo.data);
          // Wire offsets come from the frozen shared results contract.
          const view = new DataView(adjusted.buffer);
          for (let i = 0; i < quantities.length; i++) view.setBigUint64(resultsLayout.headerSize + i * resultsLayout.fillSize + 40, quantities[i]!, true);
          const signature = txResp.transaction.signatures[0];
          if (!signature) throw new Error('Settlement signature unavailable');
          if (!blockTimes.has(slot)) throw new Error('Settlement block time unavailable');
          const fills = decodeDfbaFills(adjusted, slot, batch.batchId, 0, signature);
          decodedFills.push(...fills);
        }
      }
    }
  } catch (error) {
    store.updateSyncError(Date.now());
    return {
      success: false,
      slotsProcessed: 0,
      fillsInserted: 0,
      error,
    };
  }

  // Atomic SQLite transaction: commit fills, candles, and sync cursor together
  const newlyInsertedFills: DecodedFillItem[] = [];
  const now = Date.now();

  const commitChunk = store.db.transaction(() => {
    for (const fill of decodedFills) {
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
        aggregateCandles(store, [
          {
            instrumentId: fill.instrumentId,
            timestampMs: blockTimes.get(fill.slot)!,
            price: fill.price,
            qty: fill.qty,
          },
        ]);
      }
    }

    store.updateSyncSuccess(endSlot, now);
  });

  commitChunk();

  // Broadcast only newly inserted fills so retries cannot duplicate broadcasts
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

  return {
    success: true,
    slotsProcessed: endSlot - startSlot + 1,
    fillsInserted: newlyInsertedFills.length,
  };
}

export interface SyncerConfig {
  connection: Connection;
  store: Store;
  coreProgramId: string;
  matcherProgramId: string;
  startSlot?: number;
  maxChunkSlots?: number;
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
    maxChunkSlots = 256,
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

  const runtimeSubscriptions = {
    core: false,
    matcher: false,
  };

  async function pollBatchState(): Promise<void> {
    try {
      const [registryPda] = sdk.deriveRegistryPda(corePk);
      const accounts = await connection.getMultipleAccountsInfo([registryPda]);
      const regData = accounts[0];
      if (!regData) return;

      const registry = sdk.state.decodeRegistry(new Uint8Array(regData.data));
      const batchId = registry.batchIdCounter - 1n;
      if (batchId < 0n) return;

      const [batchPda] = sdk.deriveBatchPda(batchId, corePk);
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
        } catch (error) {
          rpcReachable = false;
          healthTracker.recordPollFailure();
          store.updateSyncError(Date.now());
          break;
        }

        let syncState = store.getSyncState();
        let cursor = syncState.processedThroughSlot;

        if (cursor === null) cursor = startSlot - 1;
        // An archival gap must never masquerade as successfully replayed history.
        const firstAvailable = await connection.getFirstAvailableBlock();
        if (firstAvailable > cursor + 1) {
          store.updateSyncError(Date.now());
          healthTracker.recordPollFailure();
          break;
        }

        // Process chunks until caught up
        while (cursor < currentConfirmedSlot) {
          const chunkStart = cursor + 1;
          const chunkEnd = Math.min(chunkStart + maxChunkSlots - 1, currentConfirmedSlot);

          const result = await syncChunk({
            connection,
            store,
            corePk,
            matcherPk,
            startSlot: chunkStart,
            endSlot: chunkEnd,
            onFill,
          });

          lastHeartbeat = Date.now();

          if (!result.success) {
            console.error("History replay paused at slot", chunkStart, result.error);
            healthTracker.recordPollFailure();
            // Leave chunk uncommitted for next retry
            break;
          }

          healthTracker.recordReconciliation(chunkEnd);
          cursor = chunkEnd;
        }
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
