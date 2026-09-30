import { describe, expect, it } from 'vitest';

import {
  DEMO_DISCLOSURES,
  IFC_SOURCE_LINKS,
  createSandboxReceipt,
  getNextBatchState,
  validateSandboxOrder,
  type SandboxOrder,
} from './usTech100';

const VALID_ORDER: SandboxOrder = {
  eligible: true,
  role: 'taker',
  side: 'buy',
  limitPrice: '21482.50',
  quantity: '12',
};

describe('US Tech 100 sandbox domain', () => {
  it('requires partner eligibility before accepting an order', () => {
    expect(validateSandboxOrder({ ...VALID_ORDER, eligible: false })).toEqual({
      eligible: 'Confirm partner eligibility to continue.',
    });
  });

  it('requires valid role, side, limit, and quantity selections', () => {
    expect(
      validateSandboxOrder({
        eligible: true,
        role: '' as SandboxOrder['role'],
        side: '' as SandboxOrder['side'],
        limitPrice: '0',
        quantity: '-2',
      }),
    ).toEqual({
      role: 'Choose maker or taker intent.',
      side: 'Choose buy or sell.',
      limitPrice: 'Enter a limit price greater than zero.',
      quantity: 'Enter a quantity greater than zero.',
    });
  });

  it('moves through one deterministic batch lifecycle', () => {
    expect(getNextBatchState('ready')).toBe('collecting');
    expect(getNextBatchState('collecting')).toBe('clearing');
    expect(getNextBatchState('clearing')).toBe('settled');
    expect(getNextBatchState('settled')).toBe('settled');
  });

  it('creates a deterministic taker-buy ask-auction receipt', () => {
    expect(createSandboxReceipt(VALID_ORDER)).toEqual({
      receiptId: 'MGK-US100-84A7C2',
      batchId: 'IFC-SBX-000184',
      instrument: 'US Tech 100 Sandbox',
      role: 'Taker',
      side: 'Buy',
      auctionLeg: 'Ask auction · maker sells × taker buys',
      limitPrice: 21482.5,
      uniformPrice: 21478.25,
      requestedQuantity: 12,
      filledQuantity: 12,
      allocationRule: 'Price priority; pro-rata at the marginal price',
      evidenceRoot: '7a4f…c219',
      matcherBuild: 'mgk-dfba-demo@84a7c2',
      simulated: true,
    });
  });

  it('maps the opposite flow to the independent bid auction', () => {
    const receipt = createSandboxReceipt({
      ...VALID_ORDER,
      role: 'taker',
      side: 'sell',
      quantity: '20',
    });

    expect(receipt.auctionLeg).toBe('Bid auction · maker buys × taker sells');
    expect(receipt.filledQuantity).toBe(16);
  });

  it('publishes the sandbox disclosures and authoritative source links', () => {
    expect(DEMO_DISCLOSURES.join(' ')).toContain('simulated');
    expect(DEMO_DISCLOSURES.join(' ')).toContain('no wallet');
    expect(DEMO_DISCLOSURES.join(' ')).toContain('no onchain write');
    expect(IFC_SOURCE_LINKS).toHaveLength(8);
    expect(IFC_SOURCE_LINKS.every((source) => source.href.startsWith('https://'))).toBe(true);
  });
});
