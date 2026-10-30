import { PublicKey } from "@solana/web3.js";
import { layouts, decodeAccount } from "../../layout/index.js";
export const PRICE_ORACLE_SIZE = layouts.PriceOracle.size;
export const PRICE_ORACLE_VERSION = layouts.PriceOracle.version!;
export interface DecodedPriceOracle {
  version: number;
  bump: number;
  isActive: boolean;
  authority: PublicKey;
  instrument: PublicKey;
  price: bigint;
  timestamp: bigint;
  confidence: bigint;
}
export function decodePriceOracle(data: Uint8Array): DecodedPriceOracle {
  const value = decodeAccount("PriceOracle", data);
  return {
    ...value,
    version: PRICE_ORACLE_VERSION,
    isActive: value.isActive,
    authority: new PublicKey(value.authority),
    instrument: new PublicKey(value.instrument),
  };
}
