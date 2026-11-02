/** Format integer ledger amounts without converting through a JS number. */
export function PortfolioAmount({
  value,
  decimals,
  unit,
}: {
  value: bigint | null;
  decimals: number;
  unit: string;
}) {
  if (value == null)
    return <span className="text-text-faint">Unavailable</span>;
  const magnitude = value < 0n ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = (magnitude / scale).toLocaleString('en-US');
  const fraction = (magnitude % scale).toString().padStart(decimals, '0');
  const digits =
    decimals === 6 ? fraction.replace(/0+$/, '').padEnd(2, '0') : fraction;
  return (
    <span className="font-mono tabular-nums">
      {value < 0n ? '-' : ''}
      {whole}.{digits} {unit}
    </span>
  );
}
