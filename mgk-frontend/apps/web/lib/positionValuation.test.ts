import { describe, expect, it } from 'vitest';
import { valuePosition } from './positionValuation';
const position = {
  instrumentId: 0,
  qty: 1000n,
  entryVwap: 100_000_000n,
  entryRemainder: 0n,
  entryDenominator: 0n,
};
const oracle = { state: 'valid' as const, price: 125_000_000n, ageSeconds: 0 };
describe('settled position valuation', () => {
  it('values a 1 SOL long opened at $100 at batch 8 mark $120: $20, estimated 0.16 SOL at oracle $125', () => {
    expect(
      valuePosition(
        position,
        500_000_000n,
        { price: 120_000_000n, batchId: 8n },
        oracle,
      ),
    ).toEqual({
      unrealizedUsd: 20_000_000n,
      estimatedLamports: 160_000_000n,
      health: 600_000_000n,
      liquidationPrice: 71_428_571n,
    });
  });
  it('withholds liquidation and PnL for a missing mark while retaining independently oracle-priced health', () => {
    expect(
      valuePosition({ ...position, qty: -1000n }, 500_000_000n, null, oracle),
    ).toEqual({
      unrealizedUsd: null,
      estimatedLamports: null,
      health: 200_000_000n,
      liquidationPrice: null,
    });
  });
  it('makes unrealized PnL and oracle risk unavailable with a stale oracle', () => {
    expect(
      valuePosition(
        position,
        500_000_000n,
        { price: 120_000_000n, batchId: 8n },
        { ...oracle, state: 'stale' },
      ),
    ).toEqual({
      unrealizedUsd: null,
      estimatedLamports: null,
      health: null,
      liquidationPrice: null,
    });
  });
  it('honours fractional entry, floors losses, and rejects malformed entry metadata', () => {
    const fractional = {
      ...position,
      qty: 1n,
      entryDenominator: 1_000_000_000_000n,
      entryRemainder: 500_000_000_000n,
    };
    expect(
      valuePosition(
        fractional,
        1_000_000_000n,
        { price: 100_000_000n, batchId: 8n },
        oracle,
      ).unrealizedUsd,
    ).toBe(-1n);
    expect(
      valuePosition({ ...fractional, entryDenominator: 1n }, 1n, null, oracle)
        .health,
    ).toBeNull();
  });
});
