import { describe, expect, it } from 'vitest';

import { orderBlockReason, parseLots, parsePriceMicro, reservation, type TicketInput } from './orderTicket';

describe('parseLots', () => {
  it('turns a SOL size into 0.001-SOL lots', () => {
    expect(parseLots('1')).toEqual({ lots: 1_000n, lotMultiple: true });
    expect(parseLots('0.25')).toEqual({ lots: 250n, lotMultiple: true });
    expect(parseLots('0.001')).toEqual({ lots: 1n, lotMultiple: true });
  });

  it('flags sizes finer than 0.001 SOL instead of rounding them', () => {
    expect(parseLots('0.0015')).toEqual({ lots: null, lotMultiple: false });
  });

  it('is empty for blank or zero input', () => {
    expect(parseLots('')).toEqual({ lots: null, lotMultiple: true });
    expect(parseLots('0')).toEqual({ lots: null, lotMultiple: true });
  });
});

describe('parsePriceMicro', () => {
  it('converts a USD price to micro-USD', () => {
    expect(parsePriceMicro('150.25')).toBe(150_250_000n);
    expect(parsePriceMicro('150')).toBe(150_000_000n);
  });

  it('is null for blank, zero or over-precise prices', () => {
    expect(parsePriceMicro('')).toBeNull();
    expect(parsePriceMicro('0')).toBeNull();
    expect(parsePriceMicro('1.0000001')).toBeNull();
  });
});

describe('reservation', () => {
  // 1 SOL at $150 with the oracle at $150: notional 1 SOL, IM 20 %, fee 5 bps.
  it('reserves 20% initial margin plus a 5 bps fee in lamports', () => {
    expect(reservation({ lots: 1_000n, price: 150_000_000n, oraclePrice: 150_000_000n, reduceOnly: false }))
      .toEqual({ orderValue: 150_000_000n, initialMargin: 200_000_000n, fee: 500_000n });
  });

  it('values a limit above the oracle at the limit price', () => {
    // 1 SOL at $300 with oracle $150 is 2 SOL notional.
    expect(reservation({ lots: 1_000n, price: 300_000_000n, oraclePrice: 150_000_000n, reduceOnly: false }).initialMargin)
      .toBe(400_000_000n);
  });

  it('rounds margin and fee up', () => {
    // 0.007 SOL at $150: notional 7_000_000 lamports.
    expect(reservation({ lots: 7n, price: 150_000_000n, oraclePrice: 150_000_000n, reduceOnly: false }))
      .toEqual({ orderValue: 1_050_000n, initialMargin: 1_400_000n, fee: 3_500n });
    // 0.001 SOL at $150.000001 over oracle $150: fee 500.0000033 lamports rounds up to 501.
    expect(reservation({ lots: 1n, price: 150_000_001n, oraclePrice: 150_000_000n, reduceOnly: false }).fee).toBe(501n);
  });

  it('reserves only the fee for reduce-only orders', () => {
    expect(reservation({ lots: 1_000n, price: 150_000_000n, oraclePrice: 150_000_000n, reduceOnly: true }))
      .toEqual({ orderValue: 150_000_000n, initialMargin: 0n, fee: 500_000n });
  });
});

const base: TicketInput = {
  side: 'buy',
  price: '150',
  size: '1',
  reduceOnly: false,
  oracle: { state: 'valid', price: 150_000_000n, ageSeconds: 2 },
  newExposurePaused: false,
  unsettledBatchId: null,
  freeCollateral: 10_000_000_000n,
  positionLots: 0n,
};

describe('orderBlockReason', () => {
  it('allows a valid order', () => {
    expect(orderBlockReason(base)).toBeNull();
  });

  it('blocks new exposure while trading is paused', () => {
    expect(orderBlockReason({ ...base, newExposurePaused: true }))
      .toBe('New exposure paused (insurance exhausted). Cancel and reduce-only still work.');
  });

  it('blocks on a stale oracle with its age', () => {
    expect(orderBlockReason({ ...base, oracle: { state: 'stale', price: 150_000_000n, ageSeconds: 74 } }))
      .toBe('Oracle stale (74 s > 60 s). New exposure blocked.');
  });

  it('blocks when the oracle is unavailable', () => {
    expect(orderBlockReason({ ...base, oracle: { state: 'unavailable', price: null, ageSeconds: null } }))
      .toBe('Oracle unavailable. New exposure blocked.');
  });

  it('blocks while the batch has cleared but not settled', () => {
    expect(orderBlockReason({ ...base, unsettledBatchId: 41n })).toBe('Batch 41 cleared, awaiting settlement.');
  });

  it('asks for a price', () => {
    expect(orderBlockReason({ ...base, price: '' })).toBe('Enter a price.');
  });

  it('asks for a size', () => {
    expect(orderBlockReason({ ...base, size: '' })).toBe('Enter a size.');
  });

  it('rejects sizes that are not whole lots', () => {
    expect(orderBlockReason({ ...base, size: '0.0005' })).toBe('Size must be a multiple of 0.001 SOL.');
  });

  it('caps a portfolio at 10 SOL', () => {
    expect(orderBlockReason({ ...base, size: '10.001' })).toBe('Max 10 SOL per portfolio.');
    expect(orderBlockReason({ ...base, size: '4', positionLots: 7_000n })).toBe('Max 10 SOL per portfolio.');
    expect(orderBlockReason({ ...base, size: '10' })).toBeNull();
  });

  it('states how much margin is needed against what is available', () => {
    // 1 SOL at $150 needs 0.2 IM + 0.0005 fee = 0.2005 SOL.
    expect(orderBlockReason({ ...base, freeCollateral: 100_000_000n }))
      .toBe('Needs 0.2005 SOL margin, 0.1 available.');
  });

  it('blocks when available collateral is unknown', () => {
    expect(orderBlockReason({ ...base, freeCollateral: null })).toBe('Available margin unknown.');
  });

  describe('reduce-only', () => {
    const ro = { ...base, reduceOnly: true, side: 'sell' as const, positionLots: 2_000n };

    it('still works while new exposure is paused or the oracle is down', () => {
      expect(orderBlockReason({ ...ro, newExposurePaused: true })).toBeNull();
      expect(orderBlockReason({ ...ro, oracle: { state: 'unavailable', price: null, ageSeconds: null } })).toBeNull();
    });

    it('needs an open position', () => {
      expect(orderBlockReason({ ...ro, positionLots: 0n })).toBe('Reduce-only needs an open position.');
      expect(orderBlockReason({ ...ro, positionLots: null })).toBe('Reduce-only needs an open position.');
    });

    it('must trade against the position', () => {
      expect(orderBlockReason({ ...ro, side: 'buy' })).toBe('Reduce-only must be Sell against your long.');
      expect(orderBlockReason({ ...ro, side: 'sell', positionLots: -2_000n })).toBe('Reduce-only must be Buy against your short.');
    });

    it('cannot exceed the position', () => {
      expect(orderBlockReason({ ...ro, size: '2.5' })).toBe('Reduce-only can close at most 2 SOL.');
    });
  });
});
