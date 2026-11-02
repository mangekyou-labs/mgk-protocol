import * as sdk from '@mgk/sdk';
import type { PublicKey } from '@solana/web3.js';

import type { OrderBookStatus } from '@/lib/marketBar';
import { LAMPORTS_PER_LOT } from '@/lib/protocol';
import { formatSol } from '@/lib/solAmount';

const { BatchStatus } = sdk.state;

/**
 * Lifecycle of the user's last accepted order. Each state is backed by the
 * chain or the indexer; when they cannot confirm a fill the state is
 * `unknown`, never "not filled".
 */
export type OrderLifecycle =
  | { kind: 'accepted'; batchId: bigint }
  | { kind: 'clearing'; batchId: bigint }
  | { kind: 'awaitingSettlement'; batchId: bigint }
  | { kind: 'partiallyFilled'; filledLots: bigint; remainingLots: bigint; awaitingSettlement: boolean }
  | { kind: 'settled'; batchId: bigint }
  | { kind: 'notFilled'; batchId: bigint }
  | { kind: 'unknown'; batchId: bigint };

export interface LifecycleInput {
  acceptedBatchId: bigint;
  /** Status read from the accepted batch's own account; null = unknown. */
  acceptedBatchStatus: sdk.state.BatchStatus | null;
  /** The batch currently running; null = unknown. */
  currentBatch: { id: bigint; status: sdk.state.BatchStatus } | null;
  /**
   * The order on the book, in lots. `absent`: a fresh book read does not
   * contain it. null: the book could not be read.
   */
  order: { qty: bigint; filledQty: bigint } | 'absent' | null;
  /** Batches with an indexed fill for this user since acceptance; null = indexer unavailable or delayed. */
  fillBatchIds: bigint[] | null;
}

type Pending = { phase: 'clearing' | 'awaitingSettlement'; batchId: bigint };

/** A later batch that has stopped collecting but not yet settled. */
function pendingBatch(input: LifecycleInput): Pending | null {
  const current = input.currentBatch;
  if (!current || current.id <= input.acceptedBatchId) return null;
  if (current.status === BatchStatus.Clearing) return { phase: 'clearing', batchId: current.id };
  if (current.status === BatchStatus.Cleared) return { phase: 'awaitingSettlement', batchId: current.id };
  return null;
}

export function orderLifecycle(input: LifecycleInput): OrderLifecycle {
  const n = input.acceptedBatchId;
  const status = input.acceptedBatchStatus;
  if (status === BatchStatus.Clearing) return { kind: 'clearing', batchId: n };
  if (status === BatchStatus.Cleared) return { kind: 'awaitingSettlement', batchId: n };
  if (status !== BatchStatus.Settled) return { kind: 'accepted', batchId: n };

  const unknown: OrderLifecycle = { kind: 'unknown', batchId: n };
  const { order, fillBatchIds } = input;
  if (order == null) return unknown;
  const pending = pendingBatch(input);
  const fills = fillBatchIds?.filter((id) => id >= n) ?? null;
  const latestFill = fills && fills.length > 0 ? fills.reduce((a, b) => (b > a ? b : a)) : null;

  if (order !== 'absent' && order.filledQty === 0n) {
    if (pending) return { kind: pending.phase, batchId: pending.batchId };
    if (fills && fills.length === 0) return { kind: 'notFilled', batchId: n };
    return unknown;
  }
  if (order !== 'absent' && order.filledQty < order.qty) {
    return {
      kind: 'partiallyFilled',
      filledLots: order.filledQty,
      remainingLots: order.qty - order.filledQty,
      awaitingSettlement: pending != null,
    };
  }
  // Fully filled on the book, or gone from it.
  const filledOnBook = order !== 'absent';
  if (pending && (filledOnBook || latestFill != null)) {
    return { kind: 'awaitingSettlement', batchId: pending.batchId };
  }
  if (latestFill != null) return { kind: 'settled', batchId: latestFill };
  return unknown;
}

/** What the page remembers about the order the program accepted. */
export interface AcceptedOrderRef {
  user: PublicKey;
  batchId: bigint;
  side: 'buy' | 'sell';
  price: bigint;
  qty: bigint;
}

/**
 * The accepted order as the book shows it. `absent` needs a fresh book read;
 * a delayed or unavailable book gives null (unknown).
 */
export function acceptedOrderOnBook(
  orders: sdk.state.RestingOrder[],
  ref: AcceptedOrderRef,
  bookStatus: OrderBookStatus,
): LifecycleInput['order'] {
  if (bookStatus !== 'ok') return null;
  const side = ref.side === 'buy' ? sdk.Side.Buy : sdk.Side.Sell;
  const match = orders.findLast(
    (o) =>
      o.user.equals(ref.user) &&
      o.batchPlaced === ref.batchId &&
      o.side === side &&
      o.price === ref.price &&
      o.qty === ref.qty,
  );
  return match ? { qty: match.qty, filledQty: match.filledQty } : 'absent';
}

/**
 * Batches with an indexed fill at or after the accepted batch. null when the
 * indexer errored, has not answered, or its last answer is older than maxAgeMs.
 */
export function fillBatchIdsSince(
  fills: { batch_id: number }[],
  acceptedBatchId: bigint,
  source: { error: string | null; lastFetchedAt: number | null },
  nowMs: number,
  maxAgeMs: number,
): bigint[] | null {
  if (source.error != null || source.lastFetchedAt == null) return null;
  if (nowMs - source.lastFetchedAt > maxAgeMs) return null;
  return fills.map((f) => BigInt(f.batch_id)).filter((id) => id >= acceptedBatchId);
}

const sol = (lots: bigint) => formatSol(lots * LAMPORTS_PER_LOT);

export function lifecycleLabel(l: OrderLifecycle): string {
  switch (l.kind) {
    case 'accepted':
      return `Accepted · on the book in batch ${l.batchId}`;
    case 'clearing':
      return `Accepted · batch ${l.batchId} clearing`;
    case 'awaitingSettlement':
      return `Batch ${l.batchId} cleared · awaiting settlement`;
    case 'partiallyFilled': {
      const text = `Partially filled · ${sol(l.filledLots)} SOL filled, ${sol(l.remainingLots)} SOL on the book`;
      return l.awaitingSettlement ? `${text} · awaiting settlement` : text;
    }
    case 'settled':
      return `Filled · settled in batch ${l.batchId}`;
    case 'notFilled':
      return `Not filled in batch ${l.batchId} · on the book`;
    case 'unknown':
      return `Batch ${l.batchId} settled · fill status unknown`;
  }
}
