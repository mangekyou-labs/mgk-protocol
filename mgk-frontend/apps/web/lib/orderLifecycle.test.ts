import { describe, expect, it } from 'vitest';
import * as sdk from '@mgk/sdk';

import { PublicKey } from '@solana/web3.js';

import {
  acceptedOrderOnBook,
  fillBatchIdsSince,
  lifecycleLabel,
  orderLifecycle,
  type LifecycleInput,
} from './orderLifecycle';

const { BatchStatus } = sdk.state;

const base: LifecycleInput = {
  acceptedBatchId: 42n,
  acceptedBatchStatus: BatchStatus.Collecting,
  currentBatch: { id: 42n, status: BatchStatus.Collecting },
  order: { qty: 1_000n, filledQty: 0n },
  fillBatchIds: [],
};

const settled42: LifecycleInput = {
  ...base,
  acceptedBatchStatus: BatchStatus.Settled,
  currentBatch: { id: 43n, status: BatchStatus.Collecting },
};

describe('orderLifecycle', () => {
  it('is on the book in its batch while that batch collects', () => {
    expect(orderLifecycle(base)).toEqual({ kind: 'accepted', batchId: 42n });
  });

  it('stays accepted while the batch status is unknown, never claiming a fill', () => {
    expect(orderLifecycle({ ...base, acceptedBatchStatus: null, currentBatch: null, fillBatchIds: null }))
      .toEqual({ kind: 'accepted', batchId: 42n });
  });

  it('is clearing while its batch auction runs', () => {
    expect(orderLifecycle({ ...base, acceptedBatchStatus: BatchStatus.Clearing }))
      .toEqual({ kind: 'clearing', batchId: 42n });
  });

  it('awaits settlement once its batch has cleared', () => {
    expect(orderLifecycle({ ...base, acceptedBatchStatus: BatchStatus.Cleared, order: { qty: 1_000n, filledQty: 1_000n } }))
      .toEqual({ kind: 'awaitingSettlement', batchId: 42n });
  });

  it('does not call the order settled just because a later batch id exists', () => {
    // A governance batch-counter change can move the counter past an unsettled batch.
    expect(orderLifecycle({ ...base, acceptedBatchStatus: BatchStatus.Cleared, currentBatch: { id: 43n, status: BatchStatus.Collecting } }))
      .toEqual({ kind: 'awaitingSettlement', batchId: 42n });
  });

  it('is settled when the order filled completely and its batch settled', () => {
    expect(orderLifecycle({ ...settled42, order: { qty: 1_000n, filledQty: 1_000n }, fillBatchIds: [42n] }))
      .toEqual({ kind: 'settled', batchId: 42n });
  });

  it('is settled when the order left the book and the indexer reports its fill', () => {
    expect(orderLifecycle({ ...settled42, order: 'absent', fillBatchIds: [42n] }))
      .toEqual({ kind: 'settled', batchId: 42n });
  });

  it('is not filled only when the chain shows no fill and the indexer agrees', () => {
    expect(orderLifecycle(settled42)).toEqual({ kind: 'notFilled', batchId: 42n });
  });

  describe('with the indexer unavailable or behind', () => {
    it('is unknown, never "not filled", when fills cannot be read', () => {
      expect(orderLifecycle({ ...settled42, fillBatchIds: null })).toEqual({ kind: 'unknown', batchId: 42n });
    });

    it('is unknown when the order left the book but no fill is indexed yet', () => {
      expect(orderLifecycle({ ...settled42, order: 'absent', fillBatchIds: [] })).toEqual({ kind: 'unknown', batchId: 42n });
    });

    it('is unknown when the book cannot be read', () => {
      expect(orderLifecycle({ ...settled42, order: null })).toEqual({ kind: 'unknown', batchId: 42n });
    });
  });

  describe('partial fills and fills in later batches', () => {
    it('shows a partial fill with the remainder still on the book, not as settled', () => {
      expect(orderLifecycle({ ...settled42, order: { qty: 1_000n, filledQty: 400n }, fillBatchIds: [42n] }))
        .toEqual({ kind: 'partiallyFilled', filledLots: 400n, remainingLots: 600n, awaitingSettlement: false });
    });

    it('marks a partial fill as awaiting settlement while a later batch it joined is clearing', () => {
      expect(orderLifecycle({
        ...settled42,
        currentBatch: { id: 45n, status: BatchStatus.Cleared },
        order: { qty: 1_000n, filledQty: 400n },
      })).toEqual({ kind: 'partiallyFilled', filledLots: 400n, remainingLots: 600n, awaitingSettlement: true });
    });

    it('follows an order that rests unfilled and fills completely in a later batch', () => {
      const later = { ...settled42, currentBatch: { id: 45n, status: BatchStatus.Cleared }, order: { qty: 1_000n, filledQty: 1_000n } };
      expect(orderLifecycle(later)).toEqual({ kind: 'awaitingSettlement', batchId: 45n });
      expect(orderLifecycle({ ...later, currentBatch: { id: 46n, status: BatchStatus.Collecting }, fillBatchIds: [45n] }))
        .toEqual({ kind: 'settled', batchId: 45n });
    });

    it('is clearing in the later batch it is taking part in', () => {
      expect(orderLifecycle({ ...settled42, currentBatch: { id: 45n, status: BatchStatus.Clearing } }))
        .toEqual({ kind: 'clearing', batchId: 45n });
    });
  });
});

describe('lifecycleLabel', () => {
  it('names each state in glossary terms', () => {
    expect(lifecycleLabel({ kind: 'accepted', batchId: 42n })).toBe('Accepted · on the book in batch 42');
    expect(lifecycleLabel({ kind: 'clearing', batchId: 42n })).toBe('Accepted · batch 42 clearing');
    expect(lifecycleLabel({ kind: 'awaitingSettlement', batchId: 42n })).toBe('Batch 42 cleared · awaiting settlement');
    expect(lifecycleLabel({ kind: 'settled', batchId: 42n })).toBe('Filled · settled in batch 42');
    expect(lifecycleLabel({ kind: 'notFilled', batchId: 42n })).toBe('Not filled in batch 42 · on the book');
    expect(lifecycleLabel({ kind: 'unknown', batchId: 42n })).toBe('Batch 42 settled · fill status unknown');
  });

  it('gives partial fills in SOL with the remainder on the book', () => {
    expect(lifecycleLabel({ kind: 'partiallyFilled', filledLots: 400n, remainingLots: 600n, awaitingSettlement: false }))
      .toBe('Partially filled · 0.4 SOL filled, 0.6 SOL on the book');
    expect(lifecycleLabel({ kind: 'partiallyFilled', filledLots: 400n, remainingLots: 600n, awaitingSettlement: true }))
      .toBe('Partially filled · 0.4 SOL filled, 0.6 SOL on the book · awaiting settlement');
  });
});

describe('acceptedOrderOnBook', () => {
  const me = new PublicKey('DdqGmK5uamYN5vmuZrzpQhKeehLdwtPLVJdhu5P2iJKC');
  const other = new PublicKey('11111111111111111111111111111112');
  const ref = { user: me, batchId: 42n, side: 'buy' as const, price: 150_000_000n, qty: 1_000n };
  const resting = (over: Partial<sdk.state.RestingOrder> = {}): sdk.state.RestingOrder => ({
    orderId: 1n,
    user: me,
    side: sdk.Side.Buy,
    price: 150_000_000n,
    qty: 1_000n,
    filledQty: 0n,
    instrumentId: 0,
    reduceOnly: false,
    batchPlaced: 42n,
    nextOrderOffset: 0,
    ...over,
  });

  it('finds the order by wallet, batch, side, price and size', () => {
    const orders = [resting({ user: other }), resting({ orderId: 2n, filledQty: 400n })];
    expect(acceptedOrderOnBook(orders, ref, 'ok')).toEqual({ qty: 1_000n, filledQty: 400n });
  });

  it('is absent only when a fresh book read does not contain it', () => {
    const orders = [resting({ side: sdk.Side.Sell }), resting({ batchPlaced: 41n })];
    expect(acceptedOrderOnBook(orders, ref, 'ok')).toBe('absent');
    expect(acceptedOrderOnBook(orders, ref, 'delayed')).toBeNull();
    expect(acceptedOrderOnBook([], ref, 'unavailable')).toBeNull();
  });
});

describe('fillBatchIdsSince', () => {
  const fill = (batch_id: number) => ({ batch_id });
  const now = 100_000;

  it('lists indexed fill batches from the accepted batch on', () => {
    expect(fillBatchIdsSince([fill(41), fill(42), fill(44)], 42n, { error: null, lastFetchedAt: now - 1_000 }, now, 10_000))
      .toEqual([42n, 44n]);
  });

  it('is unknown when the indexer errors, has not answered, or is delayed', () => {
    expect(fillBatchIdsSince([], 42n, { error: 'down', lastFetchedAt: now }, now, 10_000)).toBeNull();
    expect(fillBatchIdsSince([], 42n, { error: null, lastFetchedAt: null }, now, 10_000)).toBeNull();
    expect(fillBatchIdsSince([], 42n, { error: null, lastFetchedAt: now - 20_000 }, now, 10_000)).toBeNull();
  });
});
