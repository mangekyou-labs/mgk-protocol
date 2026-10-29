import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { INSTRUMENT_ORACLE_OFFSET, readInstrumentOracle } from './instrument.js';

describe('readInstrumentOracle', () => {
  it('reads the oracle address at byte 68 of the instrument account', () => {
    const oracle = PublicKey.unique();
    const data = new Uint8Array(352);
    data.set(oracle.toBytes(), INSTRUMENT_ORACLE_OFFSET);
    expect(readInstrumentOracle(data).equals(oracle)).toBe(true);
  });

  it('rejects a truncated account', () => {
    expect(() => readInstrumentOracle(new Uint8Array(90))).toThrow(/too small/);
  });
});
