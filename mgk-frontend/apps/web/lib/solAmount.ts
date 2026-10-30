/** Exact decimal SOL conversion; never round or truncate user input. */
export function parseSol(input: string): bigint | null {
  if (!/^\d+(?:\.\d{0,9})?$/.test(input)) return null;
  const [whole, fraction = ''] = input.split('.');
  const value = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
  return value > 0n && value <= 18446744073709551615n ? value : null;
}
export function formatSol(value: bigint | null): string {
  if (value === null) return 'unavailable';
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const fraction = (magnitude % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${magnitude / 1_000_000_000n}${fraction ? `.${fraction}` : ''}`;
}
