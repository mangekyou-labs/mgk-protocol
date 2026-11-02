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

  it('does not call non-numeric input a lot multiple', () => {
    expect(parseLots('abc')).toEqual({ lots: null, lotMultiple: false });
    expect(parseLots('-1')).toEqual({ lots: null, lotMultiple: false });
    expect(parseLots('1e3')).toEqual({ lots: null, lotMultiple: false });
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
  batchGate: null,
  withdrawableCollateral: 10_000_000_000n,
  positionLots: 0n,
  // 100 SOL fund covers 0.4 x (larger side + order) well past the 50 SOL side limit.
  market: { openInterestLong: 0n, openInterestShort: 0n, insuranceFund: 100_000_000_000n },
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
    expect(orderBlockReason({ ...base, batchGate: { phase: 'cleared', batchId: 41n } }))
      .toBe('Batch 41 cleared, awaiting settlement.');
  });

  it('blocks while the batch auction is still clearing, without calling it cleared', () => {
    expect(orderBlockReason({ ...base, batchGate: { phase: 'clearing', batchId: 41n } }))
      .toBe('Batch 41 clearing. Orders reopen after settlement.');
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

  it('rejects non-numeric sizes as invalid, not as a lot problem', () => {
    expect(orderBlockReason({ ...base, size: 'abc' })).toBe('Enter a valid size.');
  });

  it('applies the 10 SOL portfolio exposure limit', () => {
    expect(orderBlockReason({ ...base, size: '10.001' })).toBe('Portfolio exposure limit is 10 SOL.');
    expect(orderBlockReason({ ...base, size: '4', positionLots: 7_000n })).toBe('Portfolio exposure limit is 10 SOL.');
    expect(orderBlockReason({ ...base, size: '10' })).toBeNull();
  });

  it('states how much margin is needed against withdrawable collateral', () => {
    // 1 SOL at $150 needs 0.2 IM + 0.0005 fee = 0.2005 SOL.
    expect(orderBlockReason({ ...base, withdrawableCollateral: 100_000_000n }))
      .toBe('Needs 0.2005 SOL margin, 0.1 SOL withdrawable.');
  });

  it('blocks when withdrawable collateral is unknown', () => {
    expect(orderBlockReason({ ...base, withdrawableCollateral: null })).toBe('Withdrawable collateral unknown.');
  });

  describe('market exposure limit and insurance fund', () => {
    it('blocks when the open interest on the order side would pass 50 SOL', () => {
      const market = { ...base.market!, openInterestLong: 49_500n };
      expect(orderBlockReason({ ...base, market })).toBe('Market exposure limit: long open interest 49.5 of 50 SOL.');
      expect(orderBlockReason({ ...base, market, size: '0.5' })).toBeNull();
      // The other side is unaffected.
      expect(orderBlockReason({ ...base, market, side: 'sell' })).toBeNull();
    });

    it('checks the short side for sells', () => {
      const market = { ...base.market!, openInterestShort: 50_000n };
      expect(orderBlockReason({ ...base, market, side: 'sell' }))
        .toBe('Market exposure limit: short open interest 50 of 50 SOL.');
    });

    it('refuses exposure while the insurance fund is below its reserve (risk-off)', () => {
      // 10 SOL long OI + 1 SOL order needs 0.4 x 11 = 4.4 SOL in the fund.
      const market = { openInterestLong: 10_000n, openInterestShort: 0n, insuranceFund: 4_399_999_999n };
      expect(orderBlockReason({ ...base, market }))
        .toBe('Risk-off: insurance fund below reserve. Only reduce-only orders are accepted.');
      expect(orderBlockReason({ ...base, market: { ...market, insuranceFund: 4_400_000_000n } })).toBeNull();
    });

    it('blocks exposure when market data is unknown', () => {
      expect(orderBlockReason({ ...base, market: null })).toBe('Market exposure unknown.');
    });
  });

  describe('reduce-only', () => {
    const ro = { ...base, reduceOnly: true, side: 'sell' as const, positionLots: 2_000n };

    it('still works while new exposure is paused, risk-off or market data is unknown', () => {
      expect(orderBlockReason({ ...ro, newExposurePaused: true })).toBeNull();
      expect(orderBlockReason({ ...ro, newExposurePaused: null })).toBeNull();
      expect(orderBlockReason({ ...ro, market: null })).toBeNull();
      expect(orderBlockReason({ ...ro, market: { openInterestLong: 50_000n, openInterestShort: 0n, insuranceFund: 0n } })).toBeNull();
    });

    it('needs an oracle price to reserve its fee', () => {
      expect(orderBlockReason({ ...ro, oracle: { state: 'unavailable', price: null, ageSeconds: null } }))
        .toBe('Oracle unavailable. Reduce-only fee cannot be priced.');
      expect(orderBlockReason({ ...ro, oracle: { state: 'stale', price: 150_000_000n, ageSeconds: 74 } }))
        .toBe('Oracle stale (74 s > 60 s). Reduce-only fee cannot be priced.');
    });

    it('needs an open position', () => {
      expect(orderBlockReason({ ...ro, positionLots: 0n })).toBe('Reduce-only needs an open position.');
    });

    it('says when the position is unknown', () => {
      expect(orderBlockReason({ ...ro, positionLots: null })).toBe('Position unknown. Reduce-only needs your position.');
    });

    it('must trade against the position', () => {
      expect(orderBlockReason({ ...ro, side: 'buy' })).toBe('Reduce-only must be Sell against your long.');
      expect(orderBlockReason({ ...ro, side: 'sell', positionLots: -2_000n })).toBe('Reduce-only must be Buy against your short.');
    });

    it('cannot exceed the position', () => {
      expect(orderBlockReason({ ...ro, size: '2.5' })).toBe('Reduce-only can close at most 2 SOL.');
    });

    it('needs withdrawable collateral for its fee', () => {
      // 2 SOL at $150 reserves a 0.001 SOL fee.
      expect(orderBlockReason({ ...ro, size: '2', withdrawableCollateral: 999_999n }))
        .toBe('Needs 0.001 SOL fee, 0.000999999 SOL withdrawable.');
      expect(orderBlockReason({ ...ro, size: '2', withdrawableCollateral: 1_000_000n })).toBeNull();
      expect(orderBlockReason({ ...ro, withdrawableCollateral: null })).toBe('Withdrawable collateral unknown.');
    });
  });
});
