import { describe, expect, it } from 'vitest';
import { splitSlotRanges } from './backfill.js';

describe('splitSlotRanges', () => {
  it('splits an inclusive slot span into provider-safe ranges', () => {
    expect(splitSlotRanges(10, 23, 5)).toEqual([
      [10, 14],
      [15, 19],
      [20, 23],
    ]);
  });

});
