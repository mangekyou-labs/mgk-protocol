import type { RestingOrder } from "./types.js";
import { PublicKey } from "@solana/web3.js";
import { layouts, decodeAccount, decodeStruct } from "../../../layout/index.js";
import { MAX_RESTING_ORDERS } from "./types.js";
export function decodeBookHeader(data: Uint8Array) {
  return decodeAccount("OrderBook", data);
}
export function decodeRestingOrder(
  data: Uint8Array,
  slotIndex: number,
): RestingOrder {
  if (
    !Number.isInteger(slotIndex) ||
    slotIndex < 0 ||
    slotIndex >= MAX_RESTING_ORDERS
  )
    throw new Error("Invalid resting order index");
  decodeBookHeader(data);
  const value = decodeStruct(
    "RestingOrder",
    data,
    layouts.OrderBook.size + slotIndex * layouts.RestingOrder.size,
  );
  return {
    ...value,
    side: value.side as RestingOrder["side"],
    user: new PublicKey(value.user),
    reduceOnly: value.reduceOnly,
  };
}
export function decodeRestingOrders(data: Uint8Array) {
  return Array.from({ length: MAX_RESTING_ORDERS }, (_, i) =>
    decodeRestingOrder(data, i),
  ).filter((v) => v.qty > 0n);
}
