import { PublicKey } from "@solana/web3.js";
import { decodeAccount } from "../../../layout/index.js";
export function decodeRegistry(data: Uint8Array) {
  const value = decodeAccount("Registry", data);
  return { ...value, governance: new PublicKey(value.governance) };
}
