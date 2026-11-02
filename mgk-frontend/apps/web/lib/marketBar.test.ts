import { describe, expect, it } from 'vitest';
import { state } from '@mgk/sdk';

import { batchGate, bookStatus, lastClearOf, marketExposure, readOracle } from './marketBar';

const oracle = (over: Partial<{ isActive: boolean; price: bigint; timestamp: bigint }> = {}) => ({
  isActive: true,
  price: 150_250_000n,
  timestamp: 1_000n,
  ...over,
});

function batch(over: Partial<state.BatchState>): state.BatchState {
  return { clearingPrice: 0n, markValid: false, status: state.BatchStatus.Collecting, ...over } as state.BatchState;
}

describe('readOracle', () => {
  it('is unavailable when the account is missing', () => {
    expect(readOracle(null, 1_000)).toEqual({ state: 'unavailable', price: null, ageSeconds: null });
  });

  it('is unavailable when the oracle is inactive or has no price', () => {
    expect(readOracle(oracle({ isActive: false }), 1_001).state).toBe('unavailable');
    expect(readOracle(oracle({ price: 0n }), 1_001).state).toBe('unavailable');
  });

  it('is valid with its age while within 60 seconds', () => {
    expect(readOracle(oracle(), 1_003)).toEqual({ state: 'valid', price: 150_250_000n, ageSeconds: 3 });
    expect(readOracle(oracle(), 1_060).state).toBe('valid');
  });

  it('is stale once older than 60 seconds', () => {
    expect(readOracle(oracle(), 1_074)).toEqual({ state: 'stale', price: 150_250_000n, ageSeconds: 74 });
  });

  it('clamps a timestamp ahead of the local clock to age 0', () => {
    expect(readOracle(oracle({ timestamp: 1_005n }), 1_000).ageSeconds).toBe(0);
  });
});

describe('lastClearOf', () => {
  it('returns the clearing price labelled with its batch when the mark is valid', () => {
    expect(lastClearOf(batch({ markValid: true, clearingPrice: 149_900_000n, status: state.BatchStatus.Settled }), 41n))
      .toEqual({ price: 149_900_000n, batchId: 41n });
  });

  it('returns null when the batch has no valid mark', () => {
    expect(lastClearOf(batch({ markValid: false, clearingPrice: 149_900_000n }), 41n)).toBeNull();
    expect(lastClearOf(batch({ markValid: true, clearingPrice: 0n }), 41n)).toBeNull();
    expect(lastClearOf(null, 41n)).toBeNull();
  });
});

describe('bookStatus', () => {
  const NOW = 100_000;
  it('is loading before the first read completes', () => {
    expect(bookStatus({ hasData: false, error: null, lastFetchedAt: null, nowMs: NOW, intervalMs: 5_000 }))
      .toEqual({ status: 'loading', ageSeconds: null });
  });

  it('is ok with a fresh successful read', () => {
    expect(bookStatus({ hasData: true, error: null, lastFetchedAt: NOW - 2_000, nowMs: NOW, intervalMs: 5_000 }))
      .toEqual({ status: 'ok', ageSeconds: 2 });
  });

  it('is delayed, keeping the last levels, when the latest read failed', () => {
    expect(bookStatus({ hasData: true, error: 'timeout', lastFetchedAt: NOW - 12_000, nowMs: NOW, intervalMs: 5_000 }))
      .toEqual({ status: 'delayed', ageSeconds: 12 });
  });

  it('is delayed when the last good read is older than three poll intervals', () => {
    expect(bookStatus({ hasData: true, error: null, lastFetchedAt: NOW - 16_000, nowMs: NOW, intervalMs: 5_000 }).status)
      .toBe('delayed');
  });

  it('is unavailable when reads fail with nothing to show, or the book account is missing', () => {
    expect(bookStatus({ hasData: false, error: 'rpc down', lastFetchedAt: null, nowMs: NOW, intervalMs: 5_000 }).status)
      .toBe('unavailable');
    expect(bookStatus({ hasData: false, error: null, lastFetchedAt: NOW - 1_000, nowMs: NOW, intervalMs: 5_000 }).status)
      .toBe('unavailable');
  });
});

describe('batchGate', () => {
  it('is open while the batch collects orders', () => {
    expect(batchGate(state.BatchStatus.Collecting, 41n)).toBeNull();
  });

  it('separates an auction still clearing from a cleared batch awaiting settlement', () => {
    expect(batchGate(state.BatchStatus.Clearing, 41n)).toEqual({ phase: 'clearing', batchId: 41n });
    expect(batchGate(state.BatchStatus.Cleared, 41n)).toEqual({ phase: 'cleared', batchId: 41n });
  });

  it('is open once settled', () => {
    expect(batchGate(state.BatchStatus.Settled, 41n)).toBeNull();
  });
});

describe('marketExposure', () => {
  it('reads open interest per side and the insurance fund from the vault', () => {
    const vault = {
      balance: 9n,
      bump: 1,
      insuranceFund: 5_000_000_000n,
      openInterestLong: 1_200n,
      openInterestShort: 800n,
      uncoveredBadDebt: 0n,
    };
    expect(marketExposure(vault)).toEqual({
      openInterestLong: 1_200n,
      openInterestShort: 800n,
      insuranceFund: 5_000_000_000n,
    });
  });

  it('is unknown without a vault', () => {
    expect(marketExposure(null)).toBeNull();
  });
});
