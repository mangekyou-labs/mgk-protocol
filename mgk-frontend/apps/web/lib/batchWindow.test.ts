import { describe, expect, it } from 'vitest';

import { isBatchClosedError, runwaySlots } from './batchWindow';

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
