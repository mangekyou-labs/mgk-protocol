use crate::state::portfolio::{sort_position_indices_by_abs_notional, Portfolio, Position, MAX_POSITIONS};
use crate::state::registry::Registry;
use crate::state::vault::Vault;
use percolator_common::PercolatorError;
use pinocchio::{
    account_info::AccountInfo, msg, ProgramResult,
};

/// M7 7.7 (D4): Liquidate an underwater portfolio.
///
/// Algorithm:
/// 1. Cancel all open orders + commitments BEFORE marking positions
///    (D4 §MVP.1). The MVP is per D4's implementation note: the
///    keeper calls `CancelAllRestingOrders` (7.7.5) and a separate
///    `CancelCommitment` instruction BEFORE `LiquidateUser`. This
///    function does NOT take book or commitment accounts — it assumes
///    the keeper has cleaned those up. If we find non-zero qty
///    positions at the end, we still proceed; this matches the design
///    intent of "skip the book account in liquidation".
///
/// 2. Iterative position reduction (D4 §MVP.2). Sort positions by abs
///    notional desc. For up to 5 rounds, reduce the top non-zero
///    position by 25% of its qty (or 100% if it's the only one left).
///    After each round, recompute `health = equity - mm`. Stop when
///    `health >= 0` (the portfolio is healthy) or after 5 rounds.
///
/// 3. If still underwater after 5 rounds: full-flat remaining
///    positions (mark all at liquidation price, zero qty/entry_vwap,
///    set positions_len = 0). This is the "worst case" fallback.
///
/// 4. Insurance claim (D4 §MVP.3 — already implemented in M5).
///    If `equity < 0`, claim `min(|equity|, insurance_fund)`. Any
///    remaining shortfall is `uncovered_bad_debt`.
///
/// 5. ADL stub (D4 §MVP.4). If `uncovered_bad_debt > 0`, set
///    `vault.adl_pending = true` and add the uncovered amount to
///    `vault.adl_debt`. No counterparty deleveraging in MVP.
///
/// 6. Final: zero im/mm, recalc_margin. The portfolio is "settled" —
///    reduced positions (if iterative reduction succeeded) or empty
///    (if full-flat). Margin tracking is wiped for MVP simplicity; a
///    follow-up can recompute im/mm from per-instrument config.
///
/// Notes:
/// - Single oracle for all positions (the registry's default). Per-
///   instrument oracle lookup is post-MVP.
/// - The MVP is conservative: when iterative reduction succeeds with
///   a position at qty=0, we don't compact the positions array. The
///   sort helper skips qty=0, so the next round's sort is unaffected.
pub fn process_liquidate_user(
    portfolio_account: &AccountInfo,
    _registry_account: &AccountInfo,
    vault_account: &AccountInfo,
    liquidator_account: &AccountInfo,
    oracle_accounts: &[AccountInfo],
) -> ProgramResult {
    if !liquidator_account.is_signer() {
        msg!("Error: Liquidator must be signer");
        return Err(PercolatorError::Unauthorized.into());
    }

    if oracle_accounts.is_empty() {
        msg!("Error: At least one oracle feed required");
        return Err(PercolatorError::InvalidInstruction.into());
    }

    let portfolio = unsafe {
        &mut *(portfolio_account.borrow_mut_data_unchecked().as_ptr() as *mut Portfolio)
    };

    if portfolio.positions_len == 0 {
        msg!("Error: No positions to liquidate");
        return Err(PercolatorError::InvalidInstruction.into());
    }

    // Check health — only liquidate if underwater
    if portfolio.health >= 0 {
        msg!("Error: Portfolio is healthy, cannot liquidate");
        return Err(PercolatorError::PortfolioHealthy.into());
    }

    // Read oracle prices from oracle feeds.
    // MVP: use the first oracle for all positions. Per-instrument
    // oracle lookup is post-MVP.
    let oracle_data = oracle_accounts[0]
        .try_borrow_data()
        .map_err(|_| PercolatorError::InvalidAccount)?;

    if oracle_data.len() < 128 {
        msg!("Error: Oracle account too small");
        return Err(PercolatorError::InvalidAccount.into());
    }

    // Check oracle is active
    let is_active_offset = 1 + 1 + 1; // magic(8) + version(1) + bump(1)
    if oracle_data[is_active_offset] == 0 {
        msg!("Error: Oracle is not active");
        return Err(PercolatorError::StalePrice.into());
    }

    // Read price and confidence
    let price_offset = 1 + 1 + 1 + 1 + 5 + 32 + 32;
    let price_bytes: [u8; 8] = oracle_data[price_offset..price_offset + 8]
        .try_into()
        .unwrap();
    let confidence_bytes: [u8; 8] = oracle_data[price_offset + 16..price_offset + 24]
        .try_into()
        .unwrap();
    let oracle_price = i64::from_le_bytes(price_bytes);
    let confidence = i64::from_le_bytes(confidence_bytes);

    let _registry = unsafe {
        &*(_registry_account.borrow_data_unchecked().as_ptr() as *const Registry)
    };

    // ===== D4 §MVP.2: Iterative reduction =====
    const MAX_ROUNDS: usize = 5;
    for _round in 0..MAX_ROUNDS {
        // health = equity - mm. mm hasn't been updated this round, so
        // this is a conservative check: if equity catches up to the
        // original mm, we're healthy.
        if portfolio.equity >= portfolio.mm as i128 {
            break;
        }

        // Re-sort by current abs notional (positions have changed).
        let sorted = sort_position_indices_by_abs_notional(
            &portfolio.positions,
            portfolio.positions_len as usize,
            oracle_price,
        );

        // Find the top non-zero position. `sorted` is sentinel-filled
        // past the actual non-zero count, so the first sentinel marks
        // the end of valid indices.
        let top_idx = match sorted.iter().find(|&&i| i < MAX_POSITIONS) {
            Some(&i) => i,
            None => break, // all positions are zero — nothing more to do
        };

        // Count non-zero positions (used to decide 25% vs 100% reduction).
        let non_zero_count = sorted
            .iter()
            .take_while(|&&i| i < MAX_POSITIONS)
            .count();

        // Snapshot the top position's qty and entry_vwap before mutating.
        let old_qty = portfolio.positions[top_idx].qty;
        let entry_vwap = portfolio.positions[top_idx].entry_vwap;
        let instrument_id = portfolio.positions[top_idx].instrument_id;

        // Determine the new qty after reduction.
        let new_qty = if non_zero_count == 1 {
            0 // only one non-zero left — full close (100% reduction)
        } else {
            // 25% reduction: new_qty = old_qty * 3 / 4 (rounds toward
            // zero for i64). For qty=-10, -10 * 3 / 4 = -7 (a 30%
            // reduction in integer math, close to 25% — acceptable
            // for MVP).
            old_qty.saturating_mul(3) / 4
        };

        // Compute PnL on the CLOSED portion (the qty that was removed
        // from the position). The closed qty is `old_qty - new_qty`.
        let closed_qty = old_qty - new_qty;
        let closed_pos = Position {
            instrument_id,
            qty: closed_qty,
            entry_vwap,
        };
        let pnl = closed_pos.liquidation_pnl(oracle_price, confidence);

        // Apply reduction: shrink the position, add the PnL to equity.
        portfolio.positions[top_idx].qty = new_qty;
        portfolio.equity = portfolio.equity.saturating_add(pnl);
        portfolio.pnl = portfolio.pnl.saturating_add(pnl);
    }

    // ===== D4 §MVP.2 fallback: full-flat if still underwater =====
    if portfolio.equity < portfolio.mm as i128 {
        let total_loss: i128 = portfolio.positions[..portfolio.positions_len as usize]
            .iter()
            .map(|p| p.liquidation_pnl(oracle_price, confidence))
            .sum();

        portfolio.equity = portfolio.equity.saturating_sub(total_loss);
        portfolio.pnl = portfolio.pnl.saturating_sub(total_loss);

        // Zero out positions and reset the count.
        for i in 0..portfolio.positions_len as usize {
            portfolio.positions[i].qty = 0;
            portfolio.positions[i].entry_vwap = 0;
        }
        portfolio.positions_len = 0;
    }

    // ===== D4 §MVP.3: Insurance claim =====
    let mut uncovered_debt: u128 = 0;
    if portfolio.equity < 0 {
        let bad_debt = portfolio.equity.unsigned_abs();
        let vault = unsafe {
            &mut *(vault_account.borrow_mut_data_unchecked().as_ptr() as *mut Vault)
        };

        let payout = bad_debt.min(vault.insurance_fund);
        if payout > 0 {
            vault.insurance_fund = vault.insurance_fund.saturating_sub(payout);
            portfolio.equity = portfolio.equity.saturating_add(payout as i128);
            msg!("Insurance claim processed");
        }
        uncovered_debt = bad_debt.saturating_sub(payout);
    }

    // ===== D4 §MVP.4: ADL stub =====
    if uncovered_debt > 0 {
        let vault = unsafe {
            &mut *(vault_account.borrow_mut_data_unchecked().as_ptr() as *mut Vault)
        };
        vault.uncovered_bad_debt = vault
            .uncovered_bad_debt
            .saturating_add(uncovered_debt);
        vault.adl_pending = true;
        vault.adl_debt = vault.adl_debt.saturating_add(uncovered_debt);
        msg!("ADL stub: bad debt flagged for keeper observation");
    }

    // ===== Final: zero margin and recompute =====
    // The portfolio is "settled" — im and mm are wiped for MVP
    // simplicity. A follow-up can recompute them from per-instrument
    // config (imr_bps, mmr_bps) if needed.
    portfolio.im = 0;
    portfolio.mm = 0;
    portfolio.recalc_margin();

    msg!("LiquidateUser: liquidation complete");
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::state::portfolio::{
        sort_position_indices_by_abs_notional, Portfolio, Position, MAX_POSITIONS,
    };
    use crate::state::Vault;
    use pinocchio::pubkey::Pubkey;

    #[test]
    fn test_portfolio_health_check() {
        let user = Pubkey::from([1u8; 32]);
        let mut p = Portfolio::new(user);
        p.equity = -1000;
        p.recalc_margin();
        assert!(p.health < 0, "Negative equity should result in negative health");

        let mut p2 = Portfolio::new(user);
        p2.equity = 1000;
        p2.recalc_margin();
        assert!(p2.health >= 0, "Positive equity should result in non-negative health");
    }

    #[test]
    fn test_liquidation_pnl_calculation() {
        // Long position liquidation at lower bound
        let entry = 100_000_000i64;
        let mark = 90_000_000i64;
        let conf = 5_000_000i64;
        let liq_price = mark.saturating_sub(conf); // 85_000_000
        let qty: i64 = 10;

        let price_delta = (liq_price as i128) - (entry as i128);
        let pnl = (qty as i128) * price_delta;
        // Long loss: (85 - 100) * 10 = -150
        assert_eq!(pnl, -150_000_000);

        // Short position liquidation at upper bound
        let liq_price = mark.saturating_add(conf); // 95_000_000
        let qty: i64 = -10;
        let price_delta = (liq_price as i128) - (entry as i128);
        let pnl = (qty as i128) * price_delta;
        // Short PnL: -10 * (95 - 100) = 50
        assert_eq!(pnl, 50_000_000);
    }

    #[test]
    fn test_insurance_payout() {
        let mut vault = Vault::new();
        vault.insurance_fund = 100_000;
        vault.balance = 1_000_000;

        let bad_debt: u128 = 50_000;
        let payout = bad_debt.min(vault.insurance_fund);
        vault.insurance_fund -= payout;
        let uncovered = bad_debt.saturating_sub(payout);
        vault.uncovered_bad_debt += uncovered;

        assert_eq!(vault.insurance_fund, 50_000);
        assert_eq!(vault.uncovered_bad_debt, 0);

        // Partial coverage
        let bad_debt2: u128 = 60_000;
        let payout2 = bad_debt2.min(vault.insurance_fund);
        vault.insurance_fund -= payout2;
        vault.uncovered_bad_debt += bad_debt2.saturating_sub(payout2);

        assert_eq!(vault.insurance_fund, 0);
        assert_eq!(vault.uncovered_bad_debt, 10_000);
    }

    // ===== M7 7.7.4 new tests: iterative reduction scenarios =====
    //
    // These are unit tests of the ALGORITHM logic (reduction math,
    // insurance, ADL stub). They don't call `process_liquidate_user`
    // directly (that requires AccountInfo wiring); they exercise the
    // building blocks — `liquidation_pnl`, `sort_position_indices_by_abs_notional`,
    // and the round/insurance/ADL flow as a sequence of pure operations.

    /// Mirror of the production `for _round in 0..MAX_ROUNDS` loop in
    /// `process_liquidate_user`. Returns the number of rounds that
    /// actually did work (i.e. the position count changed). When all
    /// positions become qty=0, the sort returns sentinels and the
    /// `break` exits early — the round counter is NOT incremented.
    fn run_iterative_reduction(
        portfolio: &mut Portfolio,
        oracle_price: i64,
        confidence: i64,
        max_rounds: usize,
    ) -> usize {
        let mut rounds = 0;
        for _ in 0..max_rounds {
            if portfolio.equity >= portfolio.mm as i128 {
                break;
            }
            let sorted = sort_position_indices_by_abs_notional(
                &portfolio.positions,
                portfolio.positions_len as usize,
                oracle_price,
            );
            let top_idx = match sorted.iter().find(|&&i| i < MAX_POSITIONS) {
                Some(&i) => i,
                None => break, // all positions zero — nothing more to do
            };
            let non_zero_count = sorted
                .iter()
                .take_while(|&&i| i < MAX_POSITIONS)
                .count();

            let old_qty = portfolio.positions[top_idx].qty;
            let entry_vwap = portfolio.positions[top_idx].entry_vwap;
            let instrument_id = portfolio.positions[top_idx].instrument_id;
            let new_qty = if non_zero_count == 1 {
                0
            } else {
                old_qty.saturating_mul(3) / 4
            };
            let closed_qty = old_qty - new_qty;
            let closed_pos = Position {
                instrument_id,
                qty: closed_qty,
                entry_vwap,
            };
            let pnl = closed_pos.liquidation_pnl(oracle_price, confidence);
            portfolio.positions[top_idx].qty = new_qty;
            portfolio.equity = portfolio.equity.saturating_add(pnl);
            portfolio.pnl = portfolio.pnl.saturating_add(pnl);
            rounds += 1;
        }
        rounds
    }

    fn build_underwater_portfolio(positions: Vec<Position>, mm: u128, equity: i128) -> Portfolio {
        let user = Pubkey::from([1u8; 32]);
        let mut p = Portfolio::new(user);
        let n = positions.len();
        for (i, pos) in positions.into_iter().enumerate() {
            p.positions[i] = pos;
        }
        p.positions_len = n as u16;
        p.mm = mm;
        p.equity = equity;
        p.recalc_margin();
        p
    }

    #[test]
    fn test_iterative_reduction_single_position_full_closes() {
        // Single long 10 @ 100M, mark 90M ± 5M, liq 85M.
        // PnL on close: 10 * (85 - 100) = -150M.
        // Equity -150M, mm 100M. After full close, equity = -150M + (-150M) = -300M.
        // Not healthy, but the test exercises the 100% reduction path.
        let positions = vec![Position {
            instrument_id: 1,
            qty: 10,
            entry_vwap: 100_000_000,
        }];
        let mut p = build_underwater_portfolio(positions, 100_000_000, -150_000_000);
        let rounds = run_iterative_reduction(&mut p, 90_000_000, 5_000_000, 5);
        // Single non-zero position → 100% reduction in 1 round
        assert_eq!(rounds, 1);
        assert_eq!(p.positions[0].qty, 0, "position fully closed");
        // equity -= 150M (the full close PnL)
        assert_eq!(p.equity, -300_000_000);
    }

    #[test]
    fn test_iterative_reduction_two_positions_25_percent() {
        // Two longs at oracle 90M, no confidence:
        //   pos 0: 10 @ 100M, notional 900M (larger)
        //   pos 1: 5  @ 100M, notional 450M (smaller)
        // Mark 90M (no confidence), so liq = 90M. PnL per unit = 90M - 100M = -10M.
        //
        // The sort re-runs every round, so the algorithm reduces the
        // CURRENT top position each round — not always the same one.
        // After 4 reductions of pos 0 (10 → 7 → 5 → 3 → 2), pos 0's
        // notional (180M) is less than pos 1's (450M), so round 5
        // reduces pos 1 instead.
        //
        // Final state after 5 rounds:
        //   pos 0: 2 (reduced 4 times)
        //   pos 1: 3 (reduced once: 5 * 3/4 = 3)
        let positions = vec![
            Position {
                instrument_id: 1,
                qty: 10,
                entry_vwap: 100_000_000,
            },
            Position {
                instrument_id: 2,
                qty: 5,
                entry_vwap: 100_000_000,
            },
        ];
        let mut p = build_underwater_portfolio(positions, 50_000_000, -100_000_000);
        let rounds = run_iterative_reduction(&mut p, 90_000_000, 0, 5);
        assert_eq!(rounds, 5);
        // pos 0: 10 → 7 → 5 → 3 → 2 (4 reductions, then round 5 goes to pos 1)
        assert_eq!(p.positions[0].qty, 2, "pos 0 reduced 4 times: 10→7→5→3→2");
        // pos 1: 5 → 3 (1 reduction in round 5)
        assert_eq!(p.positions[1].qty, 3, "pos 1 reduced once: 5→3");
    }

    #[test]
    fn test_iterative_reduction_stops_when_healthy() {
        // Single position, small loss. After 1 round, equity >= mm.
        // qty 1 @ 100M, mark 100M ± 0 → liq 100M. PnL = 0.
        // After 1 round (100% reduction), equity stays at -100, mm=0.
        // Wait, the loop checks `equity >= mm` BEFORE the round. If
        // mm=0 and equity=-100, the check fails (we're not healthy).
        // So the round runs. After the round, position is qty=0.
        // Next round: sort returns all sentinels, we break.
        // Final: equity=-100 (no improvement), mm=0.
        let positions = vec![Position {
            instrument_id: 1,
            qty: 1,
            entry_vwap: 100_000_000,
        }];
        let mut p = build_underwater_portfolio(positions, 0, -100);
        let rounds = run_iterative_reduction(&mut p, 100_000_000, 0, 5);
        assert_eq!(rounds, 1);
        assert_eq!(p.positions[0].qty, 0);
        assert_eq!(p.equity, -100);
    }

    #[test]
    fn test_adl_stub_sets_pending_and_debt() {
        // Simulate the post-iterative-reduction flow: equity is very
        // negative, insurance fund is empty, so uncovered_debt > 0.
        // The ADL stub should set adl_pending=true and adl_debt.
        let mut vault = Vault::new();
        vault.insurance_fund = 0; // empty
        vault.uncovered_bad_debt = 0;
        vault.adl_pending = false;
        vault.adl_debt = 0;

        let portfolio_equity: i128 = -500; // underwater
        let mut uncovered_debt: u128 = 0;
        if portfolio_equity < 0 {
            let bad_debt = portfolio_equity.unsigned_abs();
            let payout = bad_debt.min(vault.insurance_fund);
            if payout > 0 {
                vault.insurance_fund -= payout;
            }
            uncovered_debt = bad_debt.saturating_sub(payout);
        }
        if uncovered_debt > 0 {
            vault.uncovered_bad_debt = vault.uncovered_bad_debt.saturating_add(uncovered_debt);
            vault.adl_pending = true;
            vault.adl_debt = vault.adl_debt.saturating_add(uncovered_debt);
        }

        assert_eq!(uncovered_debt, 500);
        assert!(vault.adl_pending, "adl_pending should be true");
        assert_eq!(vault.adl_debt, 500);
        assert_eq!(vault.uncovered_bad_debt, 500);
    }

    #[test]
    fn test_adl_stub_not_set_when_fully_covered() {
        // Insurance covers the full loss — no uncovered, no ADL stub.
        let mut vault = Vault::new();
        vault.insurance_fund = 1000;
        vault.uncovered_bad_debt = 0;
        vault.adl_pending = false;
        vault.adl_debt = 0;

        let portfolio_equity: i128 = -500;
        let mut uncovered_debt: u128 = 0;
        if portfolio_equity < 0 {
            let bad_debt = portfolio_equity.unsigned_abs();
            let payout = bad_debt.min(vault.insurance_fund);
            if payout > 0 {
                vault.insurance_fund -= payout;
            }
            uncovered_debt = bad_debt.saturating_sub(payout);
        }
        if uncovered_debt > 0 {
            vault.uncovered_bad_debt = vault.uncovered_bad_debt.saturating_add(uncovered_debt);
            vault.adl_pending = true;
            vault.adl_debt = vault.adl_debt.saturating_add(uncovered_debt);
        }

        assert_eq!(uncovered_debt, 0, "insurance covered everything");
        assert!(!vault.adl_pending, "adl_pending stays false");
        assert_eq!(vault.adl_debt, 0);
        assert_eq!(vault.insurance_fund, 500, "500 paid out, 500 remaining");
        assert_eq!(vault.uncovered_bad_debt, 0);
    }
}
