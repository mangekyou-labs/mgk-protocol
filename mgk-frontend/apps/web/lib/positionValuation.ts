import type { state } from '@mgk/sdk';
import type { ClearPrice, OracleReading } from './marketBar';

const ENTRY_SCALE = 1_000_000_000_000n;
const floor = (n: bigint, d: bigint) =>
  n / d - (n < 0n && n % d !== 0n ? 1n : 0n);

/** Convert exact position PnL to SOL at the oracle, flooring in the protocol's favor. */
function pnlLamports(qty: bigint, entry: bigint, price: bigint, oraclePrice: bigint) {
  return floor(
    qty * 1_000_000n * (price * ENTRY_SCALE - entry),
    oraclePrice * ENTRY_SCALE,
  );
}

/** USD in micro-USD; collateral/health in lamports. SOL-PERP only, 1,000 lots = 1 SOL. */
export function valuePosition(
  position: state.Position,
  equity: bigint,
  mark: ClearPrice | null,
  oracle: OracleReading,
) {
  const unavailable = {
    unrealizedUsd: null,
    estimatedLamports: null,
    health: null,
    liquidationPrice: null,
  };
  const { qty, entryVwap, entryRemainder, entryDenominator } = position;
  if (
    qty === 0n ||
    entryVwap <= 0n ||
    ![0n, ENTRY_SCALE].includes(entryDenominator) ||
    entryRemainder < 0n ||
    entryRemainder >= (entryDenominator || 1n)
  )
    return unavailable;
  const entry = entryVwap * ENTRY_SCALE + entryRemainder;
  const validOracle = oracle.state === 'valid' && oracle.price > 0n;
  const validMark = mark != null && mark.price > 0n && mark.batchId >= 0n;
  const unrealizedUsd =
    validMark && validOracle
      ? floor(qty * (mark.price * ENTRY_SCALE - entry), 1000n * ENTRY_SCALE)
      : null;
  const estimatedLamports =
    validOracle && validMark
      ? pnlLamports(qty, entry, mark.price, oracle.price)
      : null;
  const lots = qty < 0n ? -qty : qty;
  const maintenance = lots * 100_000n;
  const health = validOracle
    ? equity +
      pnlLamports(qty, entry, oracle.price, oracle.price) -
      maintenance
    : null;
  // Solve equity + qty*1e6*(price-entry)/price = maintenance.
  // This is the single-position oracle risk model, not the DFBA mark.
  const denominator = equity + qty * 1_000_000n - maintenance;
  const candidate =
    validOracle && validMark && denominator !== 0n
      ? (qty * 1_000_000n * entry) / (denominator * ENTRY_SCALE)
      : null;
  return {
    unrealizedUsd,
    estimatedLamports,
    health,
    liquidationPrice: candidate != null && candidate > 0n ? candidate : null,
  };
}
