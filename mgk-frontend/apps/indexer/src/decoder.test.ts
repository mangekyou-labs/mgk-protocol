import { describe, expect, it } from 'vitest';
import { decodeDfbaFills, decodeFills } from './decoder.js';

describe('decodeFills', () => {
  it('decodes an empty results account (no fills)', () => {
    const buf = new Uint8Array(2);
    const view = new DataView(buf.buffer);
    view.setUint16(0, 0, true); // num_fills = 0
    const fills = decodeFills(buf, 100, 1n, 0, 'sig', 0);
    expect(fills).toHaveLength(0);
  });

  it('returns empty array for data shorter than 2 bytes', () => {
    const fills = decodeFills(new Uint8Array(1), 100, 1n, 0, 'sig', 0);
    expect(fills).toHaveLength(0);
  });

  it('decodes a single fill', () => {
    const user = new Uint8Array(32).fill(0x42);
    const buf = new Uint8Array(2 + 49);
    const view = new DataView(buf.buffer);
    view.setUint16(0, 1, true);
    buf.set(user, 2);
    view.setBigUint64(34, 1000n, true); // qty
    view.setBigUint64(42, 150000n, true); // notional
    view.setUint8(50, 0); // not maker

    const fills = decodeFills(buf, 42, 7n, 0, 'txsig123', 1);
    expect(fills).toHaveLength(1);
    expect(fills[0]!.slot).toBe(42);
    expect(fills[0]!.batchId).toBe(7n);
    expect(fills[0]!.qty).toBe(1000n);
  });

  it('skips fills with zero qty', () => {
    const buf = new Uint8Array(2 + 49);
    const view = new DataView(buf.buffer);
    view.setUint16(0, 1, true);
    view.setBigUint64(34, 0n, true); // qty = 0
    view.setBigUint64(42, 100n, true); // notional

    const fills = decodeFills(buf, 1, 1n, 0, 'sig', 0);
    expect(fills).toHaveLength(0);
  });

  it('decodes the live DFBA dual-auction results layout', () => {
    const bidMaker = new Uint8Array(32).fill(0x11);
    const askTaker = new Uint8Array(32).fill(0x22);
    const buf = new Uint8Array(34 + 2 * 58);
    const view = new DataView(buf.buffer);

    view.setBigInt64(0, 100_000n, true); // bid clearing price
    view.setBigInt64(8, 101_000n, true); // ask clearing price
    view.setBigUint64(16, 500n, true); // matched bid quantity
    view.setBigUint64(24, 700n, true); // matched ask quantity
    view.setUint16(32, 2, true); // num fills

    buf.set(bidMaker, 34);
    view.setBigUint64(34 + 40, 500n, true);
    view.setBigInt64(34 + 48, 100_000n, true);
    view.setUint8(34 + 56, 1); // maker
    view.setUint8(34 + 57, 0); // bid auction

    buf.set(askTaker, 34 + 58);
    view.setBigUint64(34 + 58 + 40, 700n, true);
    view.setBigInt64(34 + 58 + 48, 101_000n, true);
    view.setUint8(34 + 58 + 56, 0); // taker
    view.setUint8(34 + 58 + 57, 1); // ask auction

    const fills = decodeDfbaFills(buf, 42, 63n, 0, 'dfba-signature');

    expect(fills).toHaveLength(2);
    expect(fills[0]).toMatchObject({
      batchId: 63n,
      price: 100_000n,
      qty: 500n,
      takerSide: 1,
      isMaker: true,
    });
    expect(Array.from(fills[0]!.takerPubkey)).toEqual(Array.from(bidMaker));
    expect(fills[1]).toMatchObject({
      price: 101_000n,
      qty: 700n,
      takerSide: 0,
      isMaker: false,
    });
    expect(Array.from(fills[1]!.makerPubkey)).toEqual(Array.from(askTaker));
  });
});
