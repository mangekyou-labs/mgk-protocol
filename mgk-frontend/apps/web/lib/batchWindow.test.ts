import { describe, expect, it } from 'vitest';

import * as sdk from '@mgk/sdk';

import { hasPostableRunway, isBatchClosedError, runwaySlots } from './batchWindow';

describe('runwaySlots', () => {
  it('counts slots left before the commit deadline', () => {
    expect(runwaySlots(120n, 100n)).toBe(20n);
  });

  it('is zero at or past the deadline', () => {
    expect(runwaySlots(100n, 100n)).toBe(0n);
    expect(runwaySlots(100n, 130n)).toBe(0n);
  });
});

describe('isBatchClosedError', () => {
  it.each([
    'Transaction simulation failed: custom program error: 0x1f6',
    'Program failed: custom program error: 502',
    'BatchNotOpen: batch not open',
  ])('recognises %s', (raw) => {
    expect(isBatchClosedError(raw)).toBe(true);
  });

  it('ignores other program errors', () => {
    expect(isBatchClosedError('custom program error: 0x1f7')).toBe(false);
    expect(isBatchClosedError('custom program error: 5020')).toBe(false);
  });
});

describe('hasPostableRunway', () => {
  const batch = (totalCommitments: number, commitDeadlineSlot: bigint) =>
    ({ status: sdk.state.BatchStatus.Collecting, totalCommitments, commitDeadlineSlot }) as sdk.state.BatchState;

  it('needs the minimum runway once the batch holds orders', () => {
    expect(hasPostableRunway(batch(1, 130n), 100n, 15n)).toBe(true);
    expect(hasPostableRunway(batch(1, 110n), 100n, 15n)).toBe(false);
  });

  it('treats an idle open batch past its deadline as postable: the first post restarts it', () => {
    expect(hasPostableRunway(batch(0, 50n), 100n, 15n)).toBe(true);
  });
});
