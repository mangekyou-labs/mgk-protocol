import { describe, expect, it } from 'vitest';
import * as sdk from '@mgk/sdk';

import { orderLifecycle } from './orderLifecycle';

const { BatchStatus } = sdk.state;

describe('orderLifecycle', () => {
  const accepted = 42n;

  it('is resting in its batch while that batch collects', () => {
    expect(orderLifecycle({ acceptedBatchId: accepted, currentBatchId: 42n, currentStatus: BatchStatus.Collecting, filled: false }))
      .toBe('Accepted · resting in batch 42');
  });

  it('stays "accepted" while batch state is unknown, never claiming a fill', () => {
    expect(orderLifecycle({ acceptedBatchId: accepted, currentBatchId: null, currentStatus: null, filled: false }))
      .toBe('Accepted · resting in batch 42');
  });

  it('is filled and awaiting settlement once a fill lands before the batch settles', () => {
    expect(orderLifecycle({ acceptedBatchId: accepted, currentBatchId: 42n, currentStatus: BatchStatus.Cleared, filled: true }))
      .toBe('Filled · awaiting settlement');
  });

  it('does not claim a fill while clearing without one', () => {
    expect(orderLifecycle({ acceptedBatchId: accepted, currentBatchId: 42n, currentStatus: BatchStatus.Clearing, filled: false }))
      .toBe('Accepted · batch 42 clearing');
  });

  it('is settled once the filled batch has settled or a later batch is open', () => {
    expect(orderLifecycle({ acceptedBatchId: accepted, currentBatchId: 42n, currentStatus: BatchStatus.Settled, filled: true }))
      .toBe('Settled · batch 42');
    expect(orderLifecycle({ acceptedBatchId: accepted, currentBatchId: 43n, currentStatus: BatchStatus.Collecting, filled: true }))
      .toBe('Settled · batch 42');
  });

  it('keeps resting when its batch settled without a fill', () => {
    expect(orderLifecycle({ acceptedBatchId: accepted, currentBatchId: 43n, currentStatus: BatchStatus.Collecting, filled: false }))
      .toBe('Resting · not filled in batch 42');
  });
});
