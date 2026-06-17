use pinocchio::pubkey::Pubkey;

pub const MAX_POSITIONS: usize = 32;
pub const MAX_INSTRUMENTS: usize = 32;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Portfolio {
    pub user: Pubkey,
    pub equity: i128,
    pub principal: i128,
    pub pnl: i128,
    pub im: u128,
    pub mm: u128,
    pub free_collateral: i128,
    pub health: i128,
    pub positions_len: u16,
    pub positions: [Position; MAX_POSITIONS],
    pub last_funding_checkpoint: [i128; MAX_INSTRUMENTS],
    pub last_batch_id: u64,
    pub last_slot: u64,
    pub bump: u8,
    pub _padding: [u8; 7],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Position {
    pub instrument_id: u16,
    pub qty: i64,
    pub entry_vwap: i64,
}

impl Position {
    /// M7 7.7 (D4): worst-case liquidation price for a position given
    /// the oracle price and confidence band. Longs get the lower band
    /// (worst for the holder of a long), shorts get the upper band.
    /// Saturates on underflow/overflow to keep the math panic-free
    /// (conservative: clamps to i64::MIN / i64::MAX, which produces the
    /// maximum possible loss but never wraps).
    pub fn liquidation_mark_price(qty: i64, oracle_price: i64, confidence: i64) -> i64 {
        if qty >= 0 {
            oracle_price.saturating_sub(confidence)
        } else {
            oracle_price.saturating_add(confidence)
        }
    }

    /// M7 7.7 (D4): PnL delta (positive = profit, negative = loss) if
    /// this position were closed at the worst-case liquidation price.
    /// Used by the iterative reduction in `process_liquidate_user` to
    /// compute per-position losses and to recompute `health` after each
    /// round. A zero-qty position returns 0 (no impact).
    ///
    /// Note: this returns the PnL delta of the position alone. The
    /// portfolio-level impact is the sum across all positions (the
    /// liquidator subtracts this from `portfolio.equity`).
    pub fn liquidation_pnl(&self, oracle_price: i64, confidence: i64) -> i128 {
        if self.qty == 0 {
            return 0;
        }
        let mark = Self::liquidation_mark_price(self.qty, oracle_price, confidence);
        let price_delta = (mark as i128) - (self.entry_vwap as i128);
        (self.qty as i128) * price_delta
    }

    /// M7 7.7 (D4): absolute notional value of this position at the
    /// given oracle price, as `u128` (max product of two i64s is
    /// ~7.3e18, which fits comfortably). Used as the sort key for
    /// iterative reduction: largest notional first.
    pub fn abs_notional(&self, oracle_price: i64) -> u128 {
        let abs_qty = (self.qty as i128).unsigned_abs();
        let abs_price = (oracle_price as i128).unsigned_abs();
        abs_qty.saturating_mul(abs_price)
    }
}

/// M7 7.7 (D4): returns position indices sorted by abs notional
/// (|qty * oracle_price|) descending. Used by `process_liquidate_user`
/// to determine which position to reduce first in iterative reduction.
///
/// The first `positions_len` slots contain the indices of the user's
/// positions, sorted by notional desc. The remaining slots
/// (`positions_len..MAX_POSITIONS`) are filled with `MAX_POSITIONS` as
/// a sentinel (valid indices are always < `MAX_POSITIONS`).
///
/// Zero-qty positions are skipped (they have no notional and shouldn't
/// be reduced). If `positions_len == 0` or all positions have qty == 0,
/// the returned array is all sentinels.
///
/// We use insertion sort: n <= `MAX_POSITIONS = 32`, so the O(n^2)
/// inner loop runs at most 1024 iterations — well within the BPF
/// compute budget and `no_std`-friendly (no heap).
pub fn sort_position_indices_by_abs_notional(
    positions: &[Position; MAX_POSITIONS],
    positions_len: usize,
    oracle_price: i64,
) -> [usize; MAX_POSITIONS] {
    const SENTINEL: usize = MAX_POSITIONS;
    let mut indices = [SENTINEL; MAX_POSITIONS];
    if positions_len == 0 {
        return indices;
    }

    // Seed the index array with the indices of non-zero positions.
    let mut n: usize = 0;
    for (i, pos) in positions[..positions_len].iter().enumerate() {
        if pos.qty != 0 {
            indices[n] = i;
            n += 1;
        }
    }
    if n == 0 {
        return [SENTINEL; MAX_POSITIONS];
    }

    // Insertion sort: indices sorted by abs notional desc.
    for i in 1..n {
        let mut j = i;
        while j > 0 {
            let a_notional = positions[indices[j - 1]].abs_notional(oracle_price);
            let b_notional = positions[indices[j]].abs_notional(oracle_price);
            // Descending: swap if previous notional is smaller.
            if a_notional < b_notional {
                indices.swap(j - 1, j);
                j -= 1;
            } else {
                break;
            }
        }
    }

    // Remaining slots (n..MAX_POSITIONS) are already SENTINEL from
    // the initial `[SENTINEL; MAX_POSITIONS]` declaration.
    indices
}

impl Portfolio {
    pub fn initialize_in_place(&mut self, user: Pubkey, bump: u8) {
        self.user = user;
        self.equity = 0;
        self.principal = 0;
        self.pnl = 0;
        self.im = 0;
        self.mm = 0;
        self.free_collateral = 0;
        self.health = 0;
        self.positions_len = 0;
        self.positions = [Position::default(); MAX_POSITIONS];
        self.last_funding_checkpoint = [0; MAX_INSTRUMENTS];
        self.last_batch_id = 0;
        self.last_slot = 0;
        self.bump = bump;
        self._padding = [0; 7];
    }

    pub fn recalc_margin(&mut self) {
        self.free_collateral = self.equity - self.im as i128;
        self.health = self.equity - self.mm as i128;
    }

    /// Returns `true` if the portfolio is underwater (`health < 0`) and
    /// should be liquidated. M7 7.6 (decision D2): after all fills in a
    /// batch are applied, `SettleBatch` calls this to flag eligible
    /// portfolios for the keeper; the actual liquidation is a separate
    /// `LiquidateUser` transaction (which already enforces `health >= 0`).
    pub fn needs_liquidation(&self) -> bool {
        self.health < 0
    }

    pub fn find_position(&self, instrument_id: u16) -> Option<(usize, &Position)> {
        for i in 0..self.positions_len as usize {
            if self.positions[i].instrument_id == instrument_id {
                return Some((i, &self.positions[i]));
            }
        }
        None
    }

    pub fn find_position_mut(&mut self, instrument_id: u16) -> Option<(usize, &mut Position)> {
        for i in 0..self.positions_len as usize {
            if self.positions[i].instrument_id == instrument_id {
                return Some((i, &mut self.positions[i]));
            }
        }
        None
    }

    #[cfg(test)]
    pub fn new(user: Pubkey) -> Self {
        let mut p = Self {
            user,
            equity: 0,
            principal: 0,
            pnl: 0,
            im: 0,
            mm: 0,
            free_collateral: 0,
            health: 0,
            positions_len: 0,
            positions: [Position::default(); MAX_POSITIONS],
            last_funding_checkpoint: [0; MAX_INSTRUMENTS],
            last_batch_id: 0,
            last_slot: 0,
            bump: 0,
            _padding: [0; 7],
        };
        p.recalc_margin();
        p
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_portfolio_new() {
        let user = Pubkey::default();
        let p = Portfolio::new(user);
        assert_eq!(p.user, user);
        assert_eq!(p.equity, 0);
        assert_eq!(p.free_collateral, 0);
    }

    #[test]
    fn test_recalc_margin() {
        let mut p = Portfolio::new(Pubkey::default());
        p.equity = 1000;
        p.im = 100;
        p.mm = 50;
        p.recalc_margin();
        assert_eq!(p.free_collateral, 900);
        assert_eq!(p.health, 950);
    }

    #[test]
    fn test_needs_liquidation_healthy_portfolio() {
        let mut p = Portfolio::new(Pubkey::default());
        p.equity = 1000;
        p.mm = 50;
        p.recalc_margin();
        assert_eq!(p.health, 950);
        assert!(!p.needs_liquidation());
    }

    #[test]
    fn test_needs_liquidation_underwater_portfolio() {
        // M7 7.6 (D2): post-hoc check. equity < mm → health < 0 → liquidate.
        let mut p = Portfolio::new(Pubkey::default());
        p.equity = 40;
        p.mm = 50;
        p.recalc_margin();
        assert_eq!(p.health, -10);
        assert!(p.needs_liquidation());
    }

    #[test]
    fn test_needs_liquidation_at_boundary() {
        // health == 0 is the boundary: still NOT eligible for liquidation
        // (LiquidateUser rejects health >= 0). M7 7.6 uses strict `< 0`.
        let mut p = Portfolio::new(Pubkey::default());
        p.equity = 50;
        p.mm = 50;
        p.recalc_margin();
        assert_eq!(p.health, 0);
        assert!(!p.needs_liquidation());
    }

    #[test]
    fn test_find_position() {
        let mut p = Portfolio::new(Pubkey::default());
        p.positions[0] = Position {
            instrument_id: 1,
            qty: 100,
            entry_vwap: 50_000_000,
        };
        p.positions_len = 1;

        let found = p.find_position(1).unwrap();
        assert_eq!(found.1.qty, 100);

        assert!(p.find_position(2).is_none());
    }

    // ----- M7 7.7 (D4) liquidation PnL math -----

    fn long(qty: i64, entry: i64) -> Position {
        Position {
            instrument_id: 1,
            qty,
            entry_vwap: entry,
        }
    }

    fn short(qty: i64, entry: i64) -> Position {
        Position {
            instrument_id: 1,
            qty: -qty.abs(),
            entry_vwap: entry,
        }
    }

    #[test]
    fn test_liquidation_mark_price_long_gets_lower_band() {
        // Long: worst case is oracle - confidence
        assert_eq!(Position::liquidation_mark_price(10, 100_000, 5_000), 95_000);
    }

    #[test]
    fn test_liquidation_mark_price_short_gets_upper_band() {
        // Short: worst case is oracle + confidence
        assert_eq!(Position::liquidation_mark_price(-10, 100_000, 5_000), 105_000);
    }

    #[test]
    fn test_liquidation_mark_price_zero_qty_treats_as_long() {
        // qty == 0 returns oracle - confidence (arbitrary; caller must
        // not call with qty == 0 anyway — see liquidation_pnl short-circuit).
        let m = Position::liquidation_mark_price(0, 100_000, 5_000);
        assert_eq!(m, 95_000);
    }

    #[test]
    fn test_liquidation_mark_price_saturates_on_underflow() {
        // oracle - confidence underflows only at i64::MIN edge.
        // Plain (100 - 1_000 = -900) does NOT saturate — that's
        // just a large negative number, not a wrap.
        let m = Position::liquidation_mark_price(1, i64::MIN, 0);
        assert_eq!(m, i64::MIN, "confidence=0 → identity");
        let m = Position::liquidation_mark_price(1, 100, 1_000);
        assert_eq!(m, -900, "100 - 1000 = -900 (no wrap)");
        let m = Position::liquidation_mark_price(1, i64::MIN, 1);
        assert_eq!(m, i64::MIN, "i64::MIN - 1 saturates to i64::MIN");
    }

    #[test]
    fn test_liquidation_mark_price_saturates_on_overflow() {
        let m = Position::liquidation_mark_price(-1, i64::MAX, 0);
        assert_eq!(m, i64::MAX);
        let m = Position::liquidation_mark_price(-1, i64::MAX - 100, 1_000);
        assert_eq!(m, i64::MAX);
    }

    #[test]
    fn test_liquidation_pnl_zero_qty_returns_zero() {
        let p = Position {
            instrument_id: 1,
            qty: 0,
            entry_vwap: 100_000_000,
        };
        assert_eq!(p.liquidation_pnl(100_000_000, 5_000_000), 0);
    }

    #[test]
    fn test_liquidation_pnl_long_with_loss() {
        // Long 10 @ 100M, mark 90M ± 5M → liquidation at 85M. Loss: 10 * (85 - 100) = -150M
        let p = long(10, 100_000_000);
        let pnl = p.liquidation_pnl(90_000_000, 5_000_000);
        assert_eq!(pnl, -150_000_000);
    }

    #[test]
    fn test_liquidation_pnl_long_with_no_loss() {
        // Long 10 @ 90M, mark 100M ± 5M → liquidation at 95M. Gain: 10 * (95 - 90) = +50M
        let p = long(10, 90_000_000);
        let pnl = p.liquidation_pnl(100_000_000, 5_000_000);
        assert_eq!(pnl, 50_000_000);
    }

    #[test]
    fn test_liquidation_pnl_short_with_loss() {
        // Short 10 @ 90M, mark 100M ± 5M → liquidation at 105M.
        // PnL = qty * (mark - entry) = -10 * (105 - 90) = -150M
        let p = short(10, 90_000_000);
        let pnl = p.liquidation_pnl(100_000_000, 5_000_000);
        assert_eq!(pnl, -150_000_000);
    }

    #[test]
    fn test_liquidation_pnl_short_with_no_loss() {
        // Short 10 @ 100M, mark 90M ± 5M → liquidation at 95M.
        // PnL = -10 * (95 - 100) = +50M
        let p = short(10, 100_000_000);
        let pnl = p.liquidation_pnl(90_000_000, 5_000_000);
        assert_eq!(pnl, 50_000_000);
    }

    #[test]
    fn test_liquidation_pnl_boundary_at_entry() {
        // mark == entry → zero PnL regardless of side
        let p = long(10, 100_000_000);
        assert_eq!(p.liquidation_pnl(100_000_000, 0), 0);
        let p = short(10, 100_000_000);
        assert_eq!(p.liquidation_pnl(100_000_000, 0), 0);
    }

    #[test]
    fn test_liquidation_pnl_matches_existing_inline_math() {
        // The existing liquidate_user.rs:78-97 had this math inline;
        // pin the new method against it so the refactor in 7.7.4 can
        // safely replace the inline version.
        let p = long(10, 100_000_000);
        let oracle = 90_000_000i64;
        let conf = 5_000_000i64;
        let mark = oracle.saturating_sub(conf); // long
        let delta = (mark as i128) - (p.entry_vwap as i128);
        let inline = (p.qty as i128) * delta;
        assert_eq!(p.liquidation_pnl(oracle, conf), inline);
    }

    // ----- M7 7.7 (D4) abs_notional + sort helper -----

    fn positions<const N: usize>(ps: [Position; N]) -> [Position; MAX_POSITIONS] {
        let mut out = [Position::default(); MAX_POSITIONS];
        for (i, p) in ps.into_iter().enumerate() {
            out[i] = p;
        }
        out
    }

    #[test]
    fn test_abs_notional_long() {
        let p = long(10, 50_000_000);
        // 10 * 100_000_000 = 1_000_000_000
        assert_eq!(p.abs_notional(100_000_000), 1_000_000_000);
    }

    #[test]
    fn test_abs_notional_short() {
        let p = short(10, 50_000_000);
        // |-10| * 100_000_000 = 1_000_000_000
        assert_eq!(p.abs_notional(100_000_000), 1_000_000_000);
    }

    #[test]
    fn test_abs_notional_zero_qty() {
        let p = Position {
            instrument_id: 1,
            qty: 0,
            entry_vwap: 0,
        };
        assert_eq!(p.abs_notional(100_000_000), 0);
    }

    #[test]
    fn test_sort_position_indices_empty() {
        let positions = positions([]);
        let sorted = sort_position_indices_by_abs_notional(&positions, 0, 100_000_000);
        // All sentinels when positions_len == 0
        assert!(sorted.iter().all(|&i| i == MAX_POSITIONS));
    }

    #[test]
    fn test_sort_position_indices_single() {
        let positions = positions([long(10, 50_000_000)]);
        let sorted = sort_position_indices_by_abs_notional(&positions, 1, 100_000_000);
        assert_eq!(sorted[0], 0);
        assert!(sorted[1..].iter().all(|&i| i == MAX_POSITIONS));
    }

    #[test]
    fn test_sort_position_indices_two_descending() {
        // Position 0: 10 @ 50M @ oracle 100M → notional 1B
        // Position 1: 5  @ 50M @ oracle 100M → notional 500M
        // Expect: [1, 0] (position 1 has smaller notional, position 0 larger? wait
        // descending means LARGEST first → position 0)
        let positions = positions([long(10, 50_000_000), long(5, 50_000_000)]);
        let sorted = sort_position_indices_by_abs_notional(&positions, 2, 100_000_000);
        assert_eq!(sorted[0], 0, "largest notional first");
        assert_eq!(sorted[1], 1, "smaller notional second");
    }

    #[test]
    fn test_sort_position_indices_three_unsorted_input() {
        // Order: [small, large, medium]
        // Notionals at oracle 100M:
        //   idx 0: 5  * 100M = 500M  (small)
        //   idx 1: 20 * 100M = 2B    (large)
        //   idx 2: 10 * 100M = 1B    (medium)
        let positions = positions([
            long(5, 50_000_000),
            long(20, 50_000_000),
            long(10, 50_000_000),
        ]);
        let sorted = sort_position_indices_by_abs_notional(&positions, 3, 100_000_000);
        assert_eq!(sorted[0], 1, "idx 1 has notional 2B (largest)");
        assert_eq!(sorted[1], 2, "idx 2 has notional 1B (medium)");
        assert_eq!(sorted[2], 0, "idx 0 has notional 500M (smallest)");
        assert!(sorted[3..].iter().all(|&i| i == MAX_POSITIONS));
    }

    #[test]
    fn test_sort_position_indices_mixes_long_and_short() {
        // qty sign doesn't matter for notional (we take abs)
        //   idx 0: long 10  → notional 1B
        //   idx 1: short 20 → notional 2B
        //   idx 2: long 5   → notional 500M
        let positions = positions([
            long(10, 50_000_000),
            short(20, 50_000_000),
            long(5, 50_000_000),
        ]);
        let sorted = sort_position_indices_by_abs_notional(&positions, 3, 100_000_000);
        assert_eq!(sorted[0], 1, "idx 1 (short 20) has largest notional");
        assert_eq!(sorted[1], 0);
        assert_eq!(sorted[2], 2);
    }

    #[test]
    fn test_sort_position_indices_skips_zero_qty() {
        // Even if positions_len > 0, zero-qty positions are skipped.
        let positions = positions([
            long(10, 50_000_000),  // idx 0
            Position { instrument_id: 2, qty: 0, entry_vwap: 0 }, // idx 1: zero, skipped
            long(5, 50_000_000),   // idx 2
        ]);
        let sorted = sort_position_indices_by_abs_notional(&positions, 3, 100_000_000);
        assert_eq!(sorted[0], 0, "idx 0 has notional 1B");
        assert_eq!(sorted[1], 2, "idx 2 has notional 500M");
        assert_eq!(sorted[2], MAX_POSITIONS, "skipped (sentinel)");
        assert!(sorted[3..].iter().all(|&i| i == MAX_POSITIONS));
    }

    #[test]
    fn test_sort_position_indices_all_zero_qty() {
        let positions = positions([
            Position { instrument_id: 1, qty: 0, entry_vwap: 0 },
            Position { instrument_id: 2, qty: 0, entry_vwap: 0 },
        ]);
        let sorted = sort_position_indices_by_abs_notional(&positions, 2, 100_000_000);
        // All zero-qty → all sentinels
        assert!(sorted.iter().all(|&i| i == MAX_POSITIONS));
    }

    #[test]
    fn test_sort_position_indices_uses_oracle_price() {
        // Same qtys, different oracle price → notional changes
        //   idx 0: long 10
        //   idx 1: long 5
        // At oracle 200M:
        //   idx 0: 10 * 200M = 2B
        //   idx 1: 5  * 200M = 1B
        // Order: [0, 1] (idx 0 larger)
        let positions = positions([long(10, 50_000_000), long(5, 50_000_000)]);
        let sorted = sort_position_indices_by_abs_notional(&positions, 2, 200_000_000);
        assert_eq!(sorted[0], 0);
        assert_eq!(sorted[1], 1);
    }
}
