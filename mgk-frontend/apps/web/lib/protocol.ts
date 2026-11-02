/**
 * Protocol constants mirrored from perps-core and mgk-common. User-facing
 * copy derives its numbers from these, so a change here changes the text.
 */

/** 1 lot = 0.001 SOL. */
export const LOTS_PER_SOL = 1_000n;
/** Lamports in one lot (perps-core state::vault::LAMPORTS_PER_LOT). */
export const LAMPORTS_PER_LOT = 1_000_000n;
/** Portfolio exposure limit: 10 SOL in lots (PORTFOLIO_EXPOSURE_LIMIT_LOTS). */
export const PORTFOLIO_EXPOSURE_LIMIT_LOTS = 10_000n;
/** Market exposure limit per side: 50 SOL in lots (MARKET_EXPOSURE_LIMIT_LOTS). */
export const MARKET_EXPOSURE_LIMIT_LOTS = 50_000n;
/** Insurance fund reserve per lot of larger-side open interest: 0.4 lot. */
export const RESERVE_LAMPORTS_PER_LOT = (LAMPORTS_PER_LOT * 2n) / 5n;
/** Oracle readings older than this are rejected on-chain (MAX_PRICE_AGE_SECONDS). */
export const ORACLE_MAX_AGE_SECONDS = 60;
/** Pause bits that block new exposure: PAUSE_TRADING | PAUSE_POST. */
export const NEW_EXPOSURE_PAUSE_MASK = 1 | 16;

/** Shared poll interval for chain reads on the trade screen. */
export const TRADE_POLL_INTERVAL_MS = 3000;

export function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}
