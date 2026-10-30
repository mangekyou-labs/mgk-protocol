import { PublicKey } from "@solana/web3.js";
import { decodeAccount, decodeStruct } from "../../../layout/index.js";
export function decodePosition(view: DataView, offset: number) {
  return decodeStruct(
    "Position",
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    offset,
  );
}
export function decodePortfolio(data: Uint8Array) {
  const value = decodeAccount("Portfolio", data);
  if (value.positionsLen > value.positions.length)
    throw new Error("Portfolio: invalid position count");
  return {
    ...value,
    user: new PublicKey(value.user),
    positions: value.positions.slice(0, value.positionsLen),
  };
}
