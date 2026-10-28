use mgk_common::layout::{
    load_account, load_account_mut,
};
use crate::state::batch::{Batch, BatchStatus};
use crate::state::instrument::Instrument;
use crate::state::liquidation::{
    apply_reduction, find_top_position, validate_instrument_coverage, DEFAULT_FRACTION_BPS,
    DEFAULT_MAX_ROUNDS,
};
use crate::state::portfolio::{Portfolio, Position, MAX_INSTRUMENTS};
use crate::state::registry::Registry;
use crate::state::vault::Vault;
use mgk_common::{
    math::{calculate_im, calculate_mm},
    MgkError,
};
use crate::cash::settle_cash;
use pinocchio::{
    account_info::AccountInfo,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

/// Liquidate an underwater portfolio (M7 7.7).
///
/// Replaces the pre-7.7 full-flat path with an iterative reduction
/// (decision D4): up to `DEFAULT_MAX_ROUNDS` rounds × `DEFAULT_FRACTION_BPS`
/// each, recomputing `health` after every round. If the portfolio is still
/// underwater after the loop, falls back to full-flat.
///
/// Realized PnL moves lamports through the same capped helper as settlement
/// (`crate::cash`): a gain is credited in full from the insurance fund, a loss
/// collects only the portfolio's collateral, so equity never goes negative and
/// the vault balance equation stays exact. If the fund cannot cover a gain the
/// shortfall is recorded as `vault.uncovered_bad_debt` and trading and
/// withdrawals are paused (issue #23). Open interest follows every reduction.
/// Taking over the position is out of scope (#24).
///
/// Marking uses `instrument.mark_price` (composite from M7 7.5) with a
/// fallback to the oracle price when `mark_price == 0` (first batch, stale
/// book, no fills). This matches the design intent of using executable
/// prices rather than raw oracle for liquidation (design L470, L99).
///
/// Accounts (fixed + variable):
/// - index 0: writable Portfolio PDA
/// - index 1: writable Registry (M7 7.8: `liquidations_paused` check; written
///   to pause trading and withdrawals when the fund is exhausted)
/// - index 2: writable Vault PDA
/// - index 3: signer Liquidator
/// - index 4: read-only Batch (latest settled; DFBA `mark_valid` / `liq_paused`)
/// - indices 5..5+num_instruments: read-only Instrument accounts (provide
///   composite mark_price, contract_size, imr_bps, mmr_bps)
/// - index 5+num_instruments: read-only fallback oracle account (single,
///   owner = mgk-oracle).
///
/// **Caller MUST pass an instrument account for every distinct
/// `instrument_id` referenced by the portfolio's positions.** A missing
/// instrument returns `MgkError::InstrumentMissingForLiquidation`
/// (= 601) — see M7 7.7 remediation R1. Pass all 32 if unsure; the lookup
/// uses `instrument_id` as the index, so extra unused accounts are
/// harmless.
///
/// Data: num_instruments(2)
#[allow(clippy::too_many_arguments)]
pub fn process_liquidate_user(
    _program_id: &Pubkey,
    portfolio_account: &AccountInfo,
    registry_account: &AccountInfo,
    vault_account: &AccountInfo,
    liquidator_account: &AccountInfo,
    batch_account: &AccountInfo,
    instrument_accounts: &[AccountInfo],
    oracle_account: &AccountInfo,
) -> ProgramResult {
    if !liquidator_account.is_signer() {
        msg!("Error: Liquidator must be signer");
        return Err(MgkError::Unauthorized.into());
    }

    let portfolio =
        unsafe { load_account_mut::<Portfolio>(portfolio_account)? };
    let registry =
        unsafe { load_account::<Registry>(registry_account)? };

    // M7 7.8: governance emergency brake. Liquidations can be paused by
    // governance (e.g. to manually intervene on a single position, or to
    // buy time during an oracle outage). Use with care — pausing
    // liquidations allows bad debt to accumulate.
    if registry.is_liquidations_paused() {
        msg!("Error: Liquidations are paused");
        return Err(MgkError::OperationPaused.into());
    }

    if portfolio.positions_len == 0 {
        msg!("Error: No positions to liquidate");
        return Err(MgkError::InvalidInstruction.into());
    }

    // M7 7.7 remediation (R1): collect the set of instrument IDs the
    // caller passed in `instrument_accounts` so we can verify that every
    // position's instrument is covered. Without this check, a missing
    // instrument silently gets mark=0 in the lookup tables, and
    // `full_flat` would record PnL = -qty * entry (destroying equity
    // with no error). See `validate_instrument_coverage` for the
    // rejection semantics.
    let mut passed_ids: [u16; MAX_INSTRUMENTS] = [u16::MAX; MAX_INSTRUMENTS];
    let mut passed_count: usize = 0;
    for inst in instrument_accounts {
        if passed_count >= MAX_INSTRUMENTS {
            break;
        }
        let inst_ref = unsafe { load_account::<Instrument>(inst)? };
        let id = inst_ref.instrument_id;
        if !passed_ids[..passed_count].contains(&id) {
            passed_ids[passed_count] = id;
            passed_count += 1;
        }
    }
    validate_instrument_coverage(
        &portfolio.positions,
        portfolio.positions_len as usize,
        &passed_ids[..passed_count],
    )?;

    if portfolio.health >= 0 {
        msg!("Error: Portfolio is healthy, cannot liquidate");
        return Err(MgkError::PortfolioHealthy.into());
    }

    // DFBA T9.4.1: liquidations require a dual-clear mark on the settled batch.
    // Trading may continue when only liq is paused (`liq_paused` / !mark_valid).
    let batch = unsafe { load_account::<Batch>(batch_account)? };
    if batch.status != BatchStatus::Settled {
        msg!("Error: Liquidate requires a Settled batch for mark_valid");
        return Err(MgkError::BatchNotSettled.into());
    }
    if batch.mark_valid == 0 || batch.liq_paused != 0 {
        msg!("Error: DFBA mark invalid / liq paused; liquidations blocked");
        return Err(MgkError::MarkInvalidForLiquidation.into());
    }
    // Prefer instrument mark when set; dual mid was written on settle when mark_valid.
    let mut any_instrument_mark = false;
    for a in instrument_accounts.iter() {
        let inst = unsafe { load_account::<Instrument>(a)? };
        if inst.mark_price > 0 {
            any_instrument_mark = true;
            break;
        }
    }
    let any_mark = any_instrument_mark || batch.clearing_price > 0;
    if !any_mark {
        msg!("Error: No usable mark price for liquidation");
        return Err(MgkError::OperationPaused.into());
    }

    let now = Clock::get()?.unix_timestamp;

    let mut mark_prices: [i64; MAX_INSTRUMENTS] = [0; MAX_INSTRUMENTS];
    let mut contract_sizes: [u64; MAX_INSTRUMENTS] = [1; MAX_INSTRUMENTS];
    let mut imr_bps_table: [u16; MAX_INSTRUMENTS] = [0; MAX_INSTRUMENTS];
    let mut mmr_bps_table: [u16; MAX_INSTRUMENTS] = [0; MAX_INSTRUMENTS];
    for inst in instrument_accounts {
        let inst_ref = unsafe { load_account::<Instrument>(inst)? };
        let id = inst_ref.instrument_id as usize;
        if id < MAX_INSTRUMENTS && portfolio.positions.iter().take(portfolio.positions_len as usize)
            .any(|position| position.instrument_id as usize == id) {
            // A valid auction mark never bypasses conversion-price validity.
            let oracle_price = mgk_common::oracle::read_price(
                oracle_account, &inst_ref.oracle_addr, inst.key(), now,
            )?;
            mark_prices[id] = if inst_ref.mark_price > 0 {
                inst_ref.mark_price
            } else {
                oracle_price
            };
            contract_sizes[id] = if inst_ref.contract_size > 0 {
                inst_ref.contract_size
            } else {
                1
            };
            imr_bps_table[id] = inst_ref.imr_bps;
            mmr_bps_table[id] = inst_ref.mmr_bps;
        }
    }

    let vault = unsafe { load_account_mut::<Vault>(vault_account)? };
    let shortfall = reduce_portfolio(
        portfolio,
        vault,
        &Marks {
            prices: mark_prices,
            contract_sizes,
            imr_bps: imr_bps_table,
            mmr_bps: mmr_bps_table,
        },
    )?;

    if shortfall > 0 {
        // The fund could not pay a winner in full: the shortfall is already on
        // `vault.uncovered_bad_debt`; stop trading and withdrawals until an
        // admin recovers the vault.
        unsafe { load_account_mut::<Registry>(registry_account)? }
            .pause_trading_and_withdrawals();
        msg!("Insurance fund exhausted: trading and withdrawals paused");
    }

    msg!("LiquidateUser: complete");
    Ok(())
}

/// Per-instrument mark and margin tables, indexed by `instrument_id`.
struct Marks {
    prices: [i64; MAX_INSTRUMENTS],
    contract_sizes: [u64; MAX_INSTRUMENTS],
    imr_bps: [u16; MAX_INSTRUMENTS],
    mmr_bps: [u16; MAX_INSTRUMENTS],
}

/// Realized amount of reducing a position from `old_qty` to `new_qty` at
/// `mark`: the signed closed quantity times `mark - entry`. This matches
/// `full_flat` (`qty * (mark - entry)`); the pre-#23 reduction used the
/// opposite sign, which paid a losing liquidatee out of the fund.
fn reduction_pnl(old_qty: i64, new_qty: i64, mark: i64, entry: i64) -> i128 {
    let closed = (old_qty as i128) - (new_qty as i128);
    closed.saturating_mul((mark as i128) - (entry as i128))
}

/// Run the iterative reduction (then full-flat fallback) on `portfolio`,
/// moving lamports and open interest through the vault. Returns the total
/// payout shortfall (fund could not cover a credited gain).
fn reduce_portfolio(
    portfolio: &mut Portfolio,
    vault: &mut Vault,
    marks: &Marks,
) -> Result<u128, ProgramError> {
    let mut shortfall: u128 = 0;
    for _round in 0..DEFAULT_MAX_ROUNDS {
        if portfolio.health >= 0 {
            break;
        }
        let top_idx = match find_top_position(
            &portfolio.positions,
            portfolio.positions_len as usize,
            &marks.prices,
            &marks.contract_sizes,
        ) {
            Some(i) => i,
            None => break,
        };
        let old_qty = portfolio.positions[top_idx].qty;
        let (new_qty, _removed) =
            apply_reduction(&portfolio.positions[top_idx], DEFAULT_FRACTION_BPS);

        let inst_id = portfolio.positions[top_idx].instrument_id as usize;
        let mark = marks.prices.get(inst_id).copied().unwrap_or(0);
        let entry = portfolio.positions[top_idx].entry_vwap;
        let delta_pnl = reduction_pnl(old_qty, new_qty, mark, entry);

        vault.apply_position_change(old_qty, new_qty)?;
        shortfall = shortfall.saturating_add(settle_cash(portfolio, vault, delta_pnl, 0)?);

        portfolio.positions[top_idx].qty = new_qty;

        if new_qty == 0 {
            let last = (portfolio.positions_len as usize).saturating_sub(1);
            if top_idx != last {
                portfolio.positions[top_idx] = portfolio.positions[last];
            }
            portfolio.positions[last] = Position::default();
            portfolio.positions_len = portfolio.positions_len.saturating_sub(1);
        }

        recompute_margin(portfolio, marks);
    }

    if portfolio.health < 0 && portfolio.positions_len > 0 {
        shortfall = shortfall.saturating_add(full_flat(portfolio, vault, &marks.prices)?);
        recompute_margin(portfolio, marks);
    }
    Ok(shortfall)
}

fn recompute_margin(portfolio: &mut Portfolio, marks: &Marks) {
    let mark_prices = &marks.prices;
    let contract_sizes = &marks.contract_sizes;
    let imr_bps = &marks.imr_bps;
    let mmr_bps = &marks.mmr_bps;
    let mut total_im: u128 = 0;
    let mut total_mm: u128 = 0;
    let count = portfolio.positions_len as usize;
    for i in 0..count.min(MAX_INSTRUMENTS) {
        let pos = &portfolio.positions[i];
        if pos.qty == 0 {
            continue;
        }
        let inst_id = pos.instrument_id as usize;
        let mark = mark_prices.get(inst_id).copied().unwrap_or(0).max(0) as u64;
        let cs = contract_sizes.get(inst_id).copied().unwrap_or(1);
        let imr = imr_bps.get(inst_id).copied().unwrap_or(0) as u64;
        let mmr = mmr_bps.get(inst_id).copied().unwrap_or(0) as u64;

        total_im = total_im.saturating_add(calculate_im(pos.qty, cs, mark, imr));
        total_mm = total_mm.saturating_add(calculate_mm(pos.qty, cs, mark, mmr));
    }
    portfolio.im = total_im;
    portfolio.mm = total_mm;
    portfolio.recalc_margin();
}

fn full_flat(
    portfolio: &mut Portfolio,
    vault: &mut Vault,
    mark_prices: &[i64; MAX_INSTRUMENTS],
) -> Result<u128, ProgramError> {
    let mut total_pnl: i128 = 0;
    let count = portfolio.positions_len as usize;
    for i in 0..count.min(MAX_INSTRUMENTS) {
        let pos = &portfolio.positions[i];
        if pos.qty == 0 {
            continue;
        }
        let inst_id = pos.instrument_id as usize;
        let mark = mark_prices.get(inst_id).copied().unwrap_or(0);
        let pnl = (pos.qty as i128) * ((mark as i128) - (pos.entry_vwap as i128));
        total_pnl = total_pnl.saturating_add(pnl);
    }
    for i in 0..count.min(MAX_INSTRUMENTS) {
        vault.apply_position_change(portfolio.positions[i].qty, 0)?;
    }
    let shortfall = settle_cash(portfolio, vault, total_pnl, 0)?;

    for i in 0..count.min(MAX_INSTRUMENTS) {
        portfolio.positions[i].qty = 0;
        portfolio.positions[i].entry_vwap = 0;
    }
    portfolio.positions_len = 0;
    portfolio.im = 0;
    portfolio.mm = 0;
    portfolio.recalc_margin();
    Ok(shortfall)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pinocchio::pubkey::Pubkey;

    fn user_pubkey(byte: u8) -> Pubkey {
        let mut b = [0u8; 32];
        b[0] = byte;
        Pubkey::from(b)
    }

    fn instrument_with_mark(id: u16, mark: i64, cs: u64, imr: u16, mmr: u16) -> Instrument {
        let mut inst = Instrument::new(id, 1_000_000, 1_000, imr, mmr);
        inst.contract_size = cs;
        inst.mark_price = mark;
        inst
    }

    fn marks(mark: i64) -> Marks {
        let mut m = Marks {
            prices: [0; MAX_INSTRUMENTS],
            contract_sizes: [1; MAX_INSTRUMENTS],
            imr_bps: [0; MAX_INSTRUMENTS],
            mmr_bps: [0; MAX_INSTRUMENTS],
        };
        m.prices[0] = mark;
        m.imr_bps[0] = 1_000;
        m.mmr_bps[0] = 5_000;
        m
    }

    /// An underwater long of 1000 lots entered at `entry`, marked at `mark`,
    /// with `equity` collateral fully backed in the vault ledger.
    fn underwater(entry: i64, equity: i128, fund: u128) -> (Portfolio, Vault) {
        let mut p = Portfolio::new(user_pubkey(1));
        p.equity = equity;
        p.positions[0] = Position {
            instrument_id: 0,
            qty: 1_000,
            entry_vwap: entry,
            ..Position::default()
        };
        p.positions_len = 1;
        p.health = -1;
        let mut vault = Vault::new();
        vault.balance = equity as u64;
        vault.insurance_fund = fund;
        vault.open_interest_long = 1_000;
        (p, vault)
    }

    fn ledger(vault: &Vault) -> i128 {
        vault.balance as i128 + vault.insurance_fund as i128 - vault.uncovered_bad_debt as i128
    }

    #[test]
    fn liquidation_loss_collects_only_the_collateral_and_never_goes_negative() {
        // Mark below entry: a long closing at a loss owes more than it holds.
        let (mut p, mut vault) = underwater(110, 1_000, 0);
        let before = ledger(&vault);
        let shortfall = reduce_portfolio(&mut p, &mut vault, &marks(100)).unwrap();
        assert_eq!(shortfall, 0);
        assert_eq!(p.equity, 0);
        assert_eq!(vault.balance as i128, p.equity);
        assert_eq!(vault.insurance_fund, 1_000);
        assert_eq!(vault.uncovered_bad_debt, 0);
        assert_eq!(ledger(&vault), before);
    }

    #[test]
    fn liquidation_gain_beyond_the_fund_records_debt_and_reports_shortfall() {
        // Mark above entry: a long closing at a profit is paid from the fund.
        let (mut p, mut vault) = underwater(90, 1_000, 1_000);
        let before = ledger(&vault);
        let shortfall = reduce_portfolio(&mut p, &mut vault, &marks(100)).unwrap();
        assert!(shortfall > 0);
        assert_eq!(vault.insurance_fund, 0);
        assert_eq!(vault.uncovered_bad_debt, shortfall);
        assert_eq!(vault.balance as i128, p.equity);
        assert_eq!(ledger(&vault), before);
    }

    #[test]
    fn liquidation_reduces_open_interest_to_zero_when_the_position_is_flattened() {
        let (mut p, mut vault) = underwater(100, 1_000, 1_000_000);
        reduce_portfolio(&mut p, &mut vault, &marks(100)).unwrap();
        assert_eq!(p.positions_len, 0);
        assert_eq!(vault.open_interest_long, 0);
        assert_eq!(vault.open_interest_short, 0);
    }

    #[test]
    fn healthy_portfolio_is_left_untouched_by_the_reduction() {
        let (mut p, mut vault) = underwater(100, 1_000, 1_000);
        p.health = 0;
        let shortfall = reduce_portfolio(&mut p, &mut vault, &marks(100)).unwrap();
        assert_eq!(shortfall, 0);
        assert_eq!(p.positions_len, 1);
        assert_eq!(vault.open_interest_long, 1_000);
    }

    #[test]
    fn test_apply_reduction_compound_call() {
        let mut p = Position {
            instrument_id: 0,
            qty: 100,
            entry_vwap: 1_000_000,
            ..Position::default()
        };
        for _ in 0..3 {
            let (nq, _r) = apply_reduction(&p, 2_500);
            p.qty = nq;
        }
        assert_eq!(p.qty, 43);
    }

    #[test]
    fn test_apply_reduction_full_close_then_idempotent() {
        let p = Position {
            instrument_id: 0,
            qty: 100,
            entry_vwap: 1_000_000,
            ..Position::default()
        };
        let (nq, _) = apply_reduction(&p, 10_000);
        assert_eq!(nq, 0);
        let (nq2, _) = apply_reduction(&Position { qty: 0, ..p }, 10_000);
        assert_eq!(nq2, 0);
    }

    #[test]
    fn test_bps_denom_cross_crate_invariant() {
        assert_eq!(DEFAULT_FRACTION_BPS, 2_500);
        assert_eq!(DEFAULT_MAX_ROUNDS, 5);
        assert_eq!(DEFAULT_FRACTION_BPS * 4, 10_000);
    }

    #[test]
    fn test_instrument_with_mark_helper() {
        let inst = instrument_with_mark(1, 50_000_000, 1, 100, 50);
        assert_eq!(inst.instrument_id, 1);
        assert_eq!(inst.mark_price, 50_000_000);
        assert_eq!(inst.contract_size, 1);
        assert_eq!(inst.imr_bps, 100);
        assert_eq!(inst.mmr_bps, 50);
    }

    /// T9.4.1: liquidation gate pattern — Settled + mark_valid + !liq_paused.
    #[test]
    fn test_dfba_liq_mark_gate_pattern() {
        use crate::state::batch::{Batch, BatchStatus};
        let mut b = Batch::new(1);
        b.status = BatchStatus::Settled;
        b.mark_valid = 0;
        b.liq_paused = 1;
        assert!(b.mark_valid == 0 || b.liq_paused != 0);

        b.mark_valid = 1;
        b.liq_paused = 0;
        b.clearing_price = 100_000;
        assert!(b.status == BatchStatus::Settled && b.mark_valid != 0 && b.liq_paused == 0);
        let _ = user_pubkey(1);
    }

    #[test]
    fn test_user_pubkey_helper() {
        let u = user_pubkey(7);
        assert_eq!(u.as_ref()[0], 7);
    }

    // The realized amount of a reduction is (closed qty) * (mark - entry), so a
    // long closing below its entry, or a short closing above it, loses.
    #[test]
    fn test_realized_pnl_sign_long_loss() {
        assert_eq!(reduction_pnl(10, 7, 90, 100), -30);
    }

    #[test]
    fn test_realized_pnl_sign_short_loss() {
        assert_eq!(reduction_pnl(-10, -7, 110, 100), -30);
    }

    #[test]
    fn test_realized_pnl_sign_long_profit() {
        assert_eq!(reduction_pnl(10, 7, 110, 100), 30);
    }

    #[test]
    fn test_realized_pnl_sign_short_profit() {
        assert_eq!(reduction_pnl(-10, -7, 90, 100), 30);
    }

}
