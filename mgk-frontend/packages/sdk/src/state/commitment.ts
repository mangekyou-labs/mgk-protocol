import { PublicKey } from "@solana/web3.js";
import { decodeAccount, decodeStruct } from "../../../layout/index.js";
import type { RevealedOrder as RawOrder } from "../../../layout/index.js";
function order(value: RawOrder) {
  return {
    ...value,
    user: new PublicKey(value.user),
    reduceOnly: value.reduceOnly,
  };
}
export function decodeRevealedOrder(view: DataView, offset: number) {
  return order(
    decodeStruct(
      "RevealedOrder",
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      offset,
    ),
  );
}
export function decodeCommitment(data: Uint8Array) {
  const value = decodeAccount("Commitment", data);
  return {
    ...value,
    user: new PublicKey(value.user),
    orderHash: new Uint8Array(value.orderHash),
    revealed: order(value.revealed),
  };
}
