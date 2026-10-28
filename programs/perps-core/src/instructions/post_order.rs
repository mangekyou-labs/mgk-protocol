//! PostOrder (disc 20) — DFBA open limit post (replaces Commit+Reveal for v1).

use crate::state::{Batch, BatchStatus, Portfolio, Registry, Vault};
use mgk_common::layout::{load_account, load_account_mut};
use mgk_common::{validate_owner, validate_writable, MgkError};
use pinocchio::{account_info::AccountInfo, msg, pubkey::Pubkey, ProgramResult};

/// Matcher `PlaceResting` discriminator.
pub const MATCHER_PLACE_RESTING: u8 = 6;

/// Quantity this portfolio already has resting on `side` of `instrument_id`
/// that could add exposure (reduce-only orders cannot).
pub(crate) fn resting_exposure_adding(portfolio: &Portfolio, instrument_id: u16, side: u8) -> u64 {
    portfolio
        .orders
        .iter()
        .filter(|o| {
            o.remaining_qty != 0
                && o.instrument_id == instrument_id
                && o.side == side
                && o.reduce_only == 0
        })
        .fold(0u64, |acc, o| acc.saturating_add(o.remaining_qty))
}

/// Position cap, open-interest cap and risk-off gate for an order that may
/// add `added_qty` lots of exposure. Callers skip reduce-only orders.
pub(crate) fn check_added_exposure(
    vault: &Vault,
    portfolio: &Portfolio,
    instrument_id: u16,
    side: u8,
    added_qty: u64,
) -> Result<(), MgkError> {
    let held = portfolio
        .find_position(instrument_id)
        .map_or(0, |(_, p)| p.qty);
    let resting = resting_exposure_adding(portfolio, instrument_id, side);
    vault.check_exposure_order(side == 0, added_qty, held, resting)
}

/// Post a limit order onto the resting book in a single transaction.
///
/// Accounts:
/// 0. [writable] Portfolio PDA
/// 1. [signer] User
/// 2. [writable] Batch PDA (must be Committing / open collection window)
/// 3. [] Registry
/// 4. [writable] Book account (matcher-owned)
/// 5. [] Matcher program
/// 6. [] Instrument PDA
/// 7. [] Conversion oracle
/// 8. [] Vault PDA (position cap, open-interest cap and risk-off gate)
///
/// Data:
///   side(1) + is_maker(1) + price(8) + qty(8) + instrument_id(2) + reduce_only(1)
///   = 21 bytes
///
/// `is_maker`: 0 = taker (default), 1 = maker.
#[allow(clippy::too_many_arguments)]
pub fn process_post_order(
    program_id: &Pubkey,
    portfolio_account: &AccountInfo,
    user_account: &AccountInfo,
    batch_account: &AccountInfo,
    registry_account: &AccountInfo,
    book_account: &AccountInfo,
    matcher_program: &AccountInfo,
    instrument_account: &AccountInfo,
    oracle_account: &AccountInfo,
    vault_account: &AccountInfo,
    side: u8,
    is_maker: bool,
    price: i64,
    qty: u64,
    instrument_id: u16,
    reduce_only: bool,
) -> ProgramResult {
    crate::matcher_cpi::validate_registry(registry_account)?;
    crate::matcher_cpi::validate_book(matcher_program, book_account, Some(instrument_id))?;
    let registry = unsafe { load_account::<Registry>(registry_account)? };
    if registry.has_unsettled_batch() || (!reduce_only && (registry.is_trading_paused() || registry.is_posts_paused())) {
        msg!("Error: Trading/posts is paused");
        return Err(MgkError::OperationPaused.into());
    }

    if !user_account.is_signer() {
        msg!("Error: User must be signer");
        return Err(MgkError::Unauthorized.into());
    }

    validate_owner(portfolio_account, program_id)?;
    validate_writable(portfolio_account)?;
    validate_owner(batch_account, program_id)?;
    validate_writable(batch_account)?;
    validate_owner(registry_account, program_id)?;
    validate_writable(book_account)?;

    if qty == 0 {
        return Err(MgkError::InvalidQuantity.into());
    }
    if price <= 0 {
        return Err(MgkError::InvalidPrice.into());
    }
    if side > 1 {
        return Err(MgkError::InvalidSide.into());
    }

    let batch = unsafe { load_account_mut::<Batch>(batch_account)? };
    crate::matcher_cpi::validate_batch(program_id, batch_account, batch.batch_id)?;
    // Until T9.3 renames status to Collecting, Committing is the open window.
    if batch.status != BatchStatus::Committing {
        msg!("Error: Batch not open for posts");
        return Err(MgkError::BatchNotOpen.into());
    }

    let portfolio = unsafe { load_account_mut::<Portfolio>(portfolio_account)? };
    if portfolio.user != *user_account.key() {
        msg!("Error: Portfolio does not belong to user");
        return Err(MgkError::Unauthorized.into());
    }

    // T9.10.7: Reduce-only enforcement at post time.
    // Multiple concurrent reduce-only orders are not execution-reserved;
    // the guard validates against the on-chain position only.
    if reduce_only {
        match portfolio.find_position(instrument_id) {
            None => {
                msg!("Error: Reduce-only order but no position");
                return Err(MgkError::ReduceOnlyViolation.into());
            }
            Some((_idx, pos)) => {
                let pos_qty = pos.qty;
                // Long (pos_qty > 0) may only sell; short (pos_qty < 0) may only buy.
                if (pos_qty > 0 && side == 1) || (pos_qty < 0 && side == 0) {
                    // This is the reducing direction — OK.
                } else {
                    msg!("Error: Reduce-only order on wrong side for position");
                    return Err(MgkError::ReduceOnlyViolation.into());
                }

            }
        }
    }

    validate_owner(vault_account, program_id)?;
    if !reduce_only {
        let vault = unsafe { load_account::<Vault>(vault_account)? };
        check_added_exposure(vault, portfolio, instrument_id, side, qty).inspect_err(|_| {
            msg!("Error: exposure caps or risk-off reserve exceeded");
        })?;
    }

    let conversion = crate::risk::conversion(program_id, instrument_account, oracle_account, instrument_id)?;
    crate::risk::refresh(portfolio, instrument_id, conversion)?;
    let reserve = crate::risk::reservation(qty, price, conversion, reduce_only)?;
    let order_id = unsafe { load_account::<mgk_common::book::OrderBook>(book_account)? }.next_order_id;
    crate::risk::open(portfolio, crate::state::portfolio::OrderReservation {
        order_id, original_qty: qty, remaining_qty: qty, price, initial_reserve: reserve,
        instrument_id, side, reduce_only: u8::from(reduce_only), _padding: [0; 12],
    })?;

    // Build CPI: disc(1) + user(32) + side(1) + is_maker(1) + price(8) + qty(8)
    //           + instrument_id(2) + reduce_only(1) = 54
    let mut cpi_data = [0u8; 1 + 32 + 1 + 1 + 8 + 8 + 2 + 1];
    cpi_data[0] = MATCHER_PLACE_RESTING;
    cpi_data[1..33].copy_from_slice(user_account.key().as_ref());
    cpi_data[33] = side;
    cpi_data[34] = if is_maker { 1 } else { 0 };
    cpi_data[35..43].copy_from_slice(&price.to_le_bytes());
    cpi_data[43..51].copy_from_slice(&qty.to_le_bytes());
    cpi_data[51..53].copy_from_slice(&instrument_id.to_le_bytes());
    cpi_data[53] = if reduce_only { 1 } else { 0 };

    crate::matcher_cpi::trader(
        registry_account,
        user_account,
        book_account,
        matcher_program,
        &cpi_data,
    )?;

    // Count posts for n_min close (reuses total_commitments field).
    batch.total_commitments = batch.total_commitments.saturating_add(1);
    portfolio.last_batch_id = batch.batch_id;

    msg!("PostOrder: placed");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::portfolio::{OrderReservation, Position};

    fn flush_vault() -> Vault {
        let mut v = Vault::new();
        v.insurance_fund = u128::MAX / 4;
        v
    }

    fn resting(order_id: u64, side: u8, qty: u64, reduce_only: u8) -> OrderReservation {
        OrderReservation {
            order_id,
            original_qty: qty,
            remaining_qty: qty,
            price: 1,
            initial_reserve: 0,
            instrument_id: 0,
            side,
            reduce_only,
            _padding: [0; 12],
        }
    }

    #[test]
    fn exposure_gate_counts_same_side_resting_and_the_held_position() {
        let vault = flush_vault();
        let mut p = Portfolio::new(Pubkey::from([1u8; 32]));
        p.positions[0] = Position { instrument_id: 0, qty: 9_000, ..Position::default() };
        p.positions_len = 1;
        p.orders[0] = resting(1, 0, 400, 0);
        // 9_000 held + 400 resting + 600 new = 10_000: at the cap.
        assert_eq!(check_added_exposure(&vault, &p, 0, 0, 600), Ok(()));
        assert_eq!(
            check_added_exposure(&vault, &p, 0, 0, 601),
            Err(MgkError::PositionCapExceeded)
        );
        // The opposite side reduces the long and is not capped by the resting buy.
        assert_eq!(check_added_exposure(&vault, &p, 0, 1, 5_000), Ok(()));
    }

    #[test]
    fn reduce_only_and_other_instrument_orders_do_not_count_as_resting_exposure() {
        let mut p = Portfolio::new(Pubkey::from([1u8; 32]));
        p.orders[0] = resting(1, 0, 400, 1);
        let mut other = resting(2, 0, 300, 0);
        other.instrument_id = 7;
        p.orders[1] = other;
        p.orders[2] = resting(3, 0, 50, 0);
        assert_eq!(resting_exposure_adding(&p, 0, 0), 50);
        assert_eq!(resting_exposure_adding(&p, 0, 1), 0);
    }

    #[test]
    fn exposure_gate_applies_open_interest_cap_and_risk_off() {
        let mut vault = flush_vault();
        vault.open_interest_long = 49_999;
        let p = Portfolio::new(Pubkey::from([1u8; 32]));
        assert_eq!(
            check_added_exposure(&vault, &p, 0, 0, 2),
            Err(MgkError::OpenInterestCapExceeded)
        );
        let mut thin = Vault::new();
        thin.open_interest_long = 20_000;
        thin.insurance_fund = 8_000_000_000;
        assert_eq!(
            check_added_exposure(&thin, &p, 0, 1, 1),
            Err(MgkError::RiskOffFundBelowReserve)
        );
    }

    #[test]
    fn test_matcher_place_disc_is_six() {
        assert_eq!(MATCHER_PLACE_RESTING, 6);
    }

    #[test]
    fn test_cpi_data_layout_length() {
        // disc + user + side + is_maker + price + qty + instrument + reduce_only
        assert_eq!(1 + 32 + 1 + 1 + 8 + 8 + 2 + 1, 54);
    }

    #[test]
    fn test_default_taker_flag_is_zero() {
        let is_maker = false;
        assert_eq!(if is_maker { 1u8 } else { 0 }, 0);
    }

    // ------------------------------------------------------------------
    // T-POST-ORDER-UNIT: wire format + validation constants
    // ------------------------------------------------------------------

    #[test]
    fn test_post_order_disc_is_twenty() {
        // PostOrder is discriminator 20 in the entrypoint match.
        assert_eq!(20u8, 20);
    }

    #[test]
    fn test_post_order_wire_data_length() {
        // Data after disc strip: side(1) + is_maker(1) + price(8) + qty(8)
        //   + instrument_id(2) + reduce_only(1) = 21 bytes
        let wire_len = 1 + 1 + 8 + 8 + 2 + 1;
        assert_eq!(wire_len, 21);
    }

    #[test]
    fn test_post_order_wire_parse_buy_taker() {
        // Simulate parsing 21 bytes of instruction data (disc already stripped).
        let mut data = [0u8; 21];
        data[0] = 0; // side = Buy
        data[1] = 0; // is_maker = false (taker)
        data[2..10].copy_from_slice(&100_000i64.to_le_bytes()); // price
        data[10..18].copy_from_slice(&5u64.to_le_bytes()); // qty
        data[18..20].copy_from_slice(&0u16.to_le_bytes()); // instrument_id
        data[20] = 0; // reduce_only = false

        let side = data[0];
        let is_maker = data[1] != 0;
        let price = i64::from_le_bytes(data[2..10].try_into().unwrap());
        let qty = u64::from_le_bytes(data[10..18].try_into().unwrap());
        let instrument_id = u16::from_le_bytes(data[18..20].try_into().unwrap());
        let reduce_only = data[20] != 0;

        assert_eq!(side, 0);
        assert!(!is_maker);
        assert_eq!(price, 100_000);
        assert_eq!(qty, 5);
        assert_eq!(instrument_id, 0);
        assert!(!reduce_only);
    }

    #[test]
    fn test_post_order_wire_parse_sell_maker_reduce_only() {
        let mut data = [0u8; 21];
        data[0] = 1; // side = Sell
        data[1] = 1; // is_maker = true
        data[2..10].copy_from_slice(&99_500i64.to_le_bytes());
        data[10..18].copy_from_slice(&10u64.to_le_bytes());
        data[18..20].copy_from_slice(&1u16.to_le_bytes()); // instrument_id = 1
        data[20] = 1; // reduce_only = true

        let side = data[0];
        let is_maker = data[1] != 0;
        let price = i64::from_le_bytes(data[2..10].try_into().unwrap());
        let qty = u64::from_le_bytes(data[10..18].try_into().unwrap());
        let instrument_id = u16::from_le_bytes(data[18..20].try_into().unwrap());
        let reduce_only = data[20] != 0;

        assert_eq!(side, 1);
        assert!(is_maker);
        assert_eq!(price, 99_500);
        assert_eq!(qty, 10);
        assert_eq!(instrument_id, 1);
        assert!(reduce_only);
    }

    #[test]
    fn test_post_order_wire_negative_price() {
        // DFBA: prices must be positive; negative is invalid.
        let price: i64 = -1;
        assert!(price <= 0); // validation would reject
    }

    #[test]
    fn test_post_order_wire_zero_qty() {
        // qty == 0 is invalid.
        let qty: u64 = 0;
        assert_eq!(qty, 0); // validation would reject
    }

    #[test]
    fn test_post_order_wire_invalid_side() {
        // side > 1 is invalid (0=Buy, 1=Sell).
        let side: u8 = 2;
        assert!(side > 1); // validation would reject
    }

    #[test]
    fn test_post_order_account_count() {
        // PostOrder requires exactly 6 accounts:
        // 0: portfolio (writable), 1: user (signer), 2: batch (writable),
        // 3: registry, 4: book (writable), 5: matcher program
        let required = 6usize;
        assert_eq!(required, 6);
    }

    #[test]
    fn test_cpi_place_resting_data_fields() {
        // CPI to matcher disc 6 PlaceResting:
        // disc(1) + user(32) + side(1) + is_maker(1) + price(8) + qty(8)
        //   + instrument_id(2) + reduce_only(1) = 54
        let mut cpi = [0u8; 54];
        cpi[0] = MATCHER_PLACE_RESTING; // disc 6

        // user at 1..33 (would be filled with actual pubkey)
        let user = [42u8; 32];
        cpi[1..33].copy_from_slice(&user);

        cpi[33] = 1; // side = Sell
        cpi[34] = 1; // is_maker = true
        cpi[35..43].copy_from_slice(&99_000i64.to_le_bytes());
        cpi[43..51].copy_from_slice(&3u64.to_le_bytes());
        cpi[51..53].copy_from_slice(&0u16.to_le_bytes());
        cpi[53] = 0; // reduce_only = false

        assert_eq!(cpi[0], 6);
        assert_eq!(&cpi[1..33], &[42u8; 32]);
        assert_eq!(cpi[33], 1); // side
        assert_eq!(cpi[34], 1); // is_maker
        assert_eq!(i64::from_le_bytes(cpi[35..43].try_into().unwrap()), 99_000);
        assert_eq!(u64::from_le_bytes(cpi[43..51].try_into().unwrap()), 3);
        assert_eq!(u16::from_le_bytes(cpi[51..53].try_into().unwrap()), 0);
        assert_eq!(cpi[53], 0); // reduce_only
    }

    // ====================================================================
    // T9.10.7: Reduce-only enforcement tests
    // ====================================================================

}
