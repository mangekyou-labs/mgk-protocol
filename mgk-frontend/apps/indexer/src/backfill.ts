/** Build inclusive RPC ranges without exceeding the provider's range cap. */
export function splitSlotRanges(
  startSlot: number,
  endSlot: number,
  maxRange: number,
): Array<[number, number]> {
  if (startSlot > endSlot) return [];
  const width = Math.max(1, Math.floor(maxRange));
  const ranges: Array<[number, number]> = [];
  for (let start = startSlot; start <= endSlot; start += width) {
    ranges.push([start, Math.min(start + width - 1, endSlot)]);
  }
  return ranges;
}
