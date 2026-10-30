import * as sdk from "@mgk/sdk";

export interface DecodedFill {
  /** The slot this fill was included in */
  slot: number;
  /** The batch ID */
  batchId: bigint;
  /** Instrument ID */
  instrumentId: number;
  /** 0 = taker is buy, 1 = taker is sell */
  takerSide: number;
  /** Fill price (i64, scaled 1e6) */
  price: bigint;
  /** Fill quantity (u64) */
  qty: bigint;
  /** Taker pubkey bytes */
  takerPubkey: Uint8Array;
  /** Maker pubkey bytes */
  makerPubkey: Uint8Array;
  /** Transaction signature */
  txSignature: string;
  /** Whether the fill is from the maker side */
  isMaker: boolean;
}

/** Current versioned DFBA results only; malformed/legacy buffers fail closed. */
export function decodeDfbaFills(
  data: Uint8Array,
  slot: number,
  batchId: bigint,
  instrumentId: number,
  txSignature: string,
): DecodedFill[] {
  const result = sdk.state.decodeResults(data);
  if (result.batchId !== batchId)
    throw new Error("BatchResults: batch ID mismatch");
  return result.fills
    .filter((f) => f.qty > 0n)
    .map((f) => ({
      slot,
      batchId,
      instrumentId,
      txSignature,
      takerSide: f.auction === 0 ? 1 : 0,
      price: f.price,
      qty: f.qty,
      takerPubkey: f.user,
      makerPubkey: Uint8Array.from(f.user),
      isMaker: f.isMaker,
    }));
}
/** @deprecated Unversioned CLOB results are unsupported. */
export function decodeFills(
  _data: Uint8Array,
  _slot: number,
  _batchId: bigint,
  _instrumentId: number,
  _txSignature: string,
  _takerSide: number,
): DecodedFill[] {
  throw new Error("Legacy CLOB results are unsupported");
}

/**
 * Decode batch events from a BatchState. Emits one event per observed
 * phase transition.
 */
export interface BatchEvent {
  batchId: bigint;
  ts: number;
  phase: number;
  numCommitments: number;
  closeSlot: bigint;
  vwap: bigint;
}

export function decodeBatchEvent(batch: sdk.state.BatchState): BatchEvent {
  return {
    batchId: batch.batchId,
    ts: Date.now(),
    phase: batch.status,
    numCommitments: batch.totalCommitments + batch.totalRevealed,
    closeSlot: batch.closeSlot,
    vwap: batch.clearingPrice,
  };
}
