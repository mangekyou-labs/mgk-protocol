import { PublicKey } from '@solana/web3.js';

// On-chain `Instrument` is #[repr(C)] with an 8-byte account header; the
// conversion oracle address sits at byte 68 (verified with `offset_of!`).
export const INSTRUMENT_ORACLE_OFFSET = 68;

/** Conversion oracle account an instrument is bound to. */
export function readInstrumentOracle(data: Uint8Array | Buffer): PublicKey {
  if (data.length < INSTRUMENT_ORACLE_OFFSET + 32) {
    throw new Error(
      `readInstrumentOracle: buffer too small (${data.length} < ${INSTRUMENT_ORACLE_OFFSET + 32})`,
    );
  }
  return new PublicKey(data.slice(INSTRUMENT_ORACLE_OFFSET, INSTRUMENT_ORACLE_OFFSET + 32));
}
