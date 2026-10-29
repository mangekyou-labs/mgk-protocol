//! SOL-PERP risk, priced exclusively at the validated conversion price.
use crate::state::{
    portfolio::{Position, ENTRY_PRICE_SCALE},
    vault::LAMPORTS_PER_LOT,
    Instrument, Portfolio, Vault,
};
use mgk_common::{layout::load_account, validate_owner, MgkError};
use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

/// Portfolio exposure limit, market exposure limit and risk-off gate for an
/// order that may add `added_qty` lots of exposure. Callers skip
/// reduce-only orders.
pub(crate) fn check_added_exposure(
    vault: &Vault,
    portfolio: &Portfolio,
    instrument_id: u16,
    side: u8,
    added_qty: u64,
) -> Result<(), MgkError> {
    let held = portfolio.position_qty(instrument_id);
    let resting = portfolio.resting_exposure_adding(instrument_id, side);
    vault.check_exposure_order(side == 0, added_qty, held, resting)
}

pub fn conversion(
    program_id: &Pubkey,
    instrument_account: &AccountInfo,
    oracle_account: &AccountInfo,
    instrument_id: u16,
) -> Result<i64, ProgramError> {
    validate_owner(instrument_account, program_id)?;
    let instrument = unsafe { load_account::<Instrument>(instrument_account)? };
    if instrument.instrument_id != instrument_id
        || instrument_account.key()
            != &crate::pda::derive_instrument_pda(instrument_id, program_id).0
    {
        return Err(MgkError::InvalidAccount.into());
    }
    Instrument::validate_demo_fees(instrument.taker_fee_bps, instrument.maker_fee_bps)?;
    mgk_common::oracle::read_price(
        oracle_account,
        &instrument.oracle_addr,
        instrument_account.key(),
        Clock::get()?.unix_timestamp,
    )
}

/// Lamports gained (positive) or lost (negative) by closing `lots` of
/// `position` at `price`: `lots * 1e6 * (price - entry) / price`, with the
/// entry's fractional remainder honoured, flipped for shorts, and rounded down
/// so a debit never undercollects. 1_000 lots is 1 SOL, so each lot is 1e6
/// lamports at the conversion price. Settlement, `refresh` and liquidation all
/// price realized PnL through this one function.
pub(crate) fn position_pnl_lamports(
    position: &Position,
    lots: u128,
    price: i64,
) -> Result<i128, ProgramError> {
    if price <= 0 {
        return Err(MgkError::InvalidPrice.into());
    }
    let scale = ENTRY_PRICE_SCALE as i128;
    if !matches!(position.entry_denominator, 0 | ENTRY_PRICE_SCALE)
        || position.entry_remainder as i128 >= position.entry_denominator.max(1) as i128
    {
        return Err(MgkError::InvalidPortfolio.into());
    }
    let diff = (price as i128)
        .checked_sub(position.entry_vwap as i128)
        .and_then(|x| x.checked_mul(scale))
        .and_then(|x| x.checked_sub(position.entry_remainder as i128))
        .ok_or(MgkError::Overflow)?;
    let signed_diff = if position.qty < 0 { -diff } else { diff };
    floor_scaled_ratio(
        signed_diff,
        lots.checked_mul(LAMPORTS_PER_LOT).ok_or(MgkError::Overflow)?,
        (price as u128) * ENTRY_PRICE_SCALE as u128,
    )
}

pub fn refresh(p: &mut Portfolio, instrument_id: u16, conversion: i64) -> ProgramResult {
    if conversion <= 0 {
        return Err(MgkError::InvalidPrice.into());
    }
    if p.positions_len as usize > p.positions.len() {
        return Err(MgkError::InvalidPortfolio.into());
    }
    let mut qty = 0u128;
    let mut pnl = 0i128;
    for position in &p.positions[..p.positions_len as usize] {
        if position.instrument_id != instrument_id || position.qty == i64::MIN {
            return Err(MgkError::InvalidPortfolio.into());
        }
        qty = qty
            .checked_add(position.qty.unsigned_abs() as u128)
            .ok_or(MgkError::Overflow)?;
        let value = position_pnl_lamports(position, position.qty.unsigned_abs() as u128, conversion)?;
        pnl = pnl.checked_add(value).ok_or(MgkError::Overflow)?;
    }
    p.im = qty.checked_mul(200_000).ok_or(MgkError::Overflow)?;
    p.mm = qty.checked_mul(100_000).ok_or(MgkError::Overflow)?;
    p.risk_pnl = pnl;
    p.recalc_margin();
    Ok(())
}

/// Floor `numerator * multiplier / denominator` without materializing the
/// potentially wider product. The fractional long division takes at most 84
/// steps for an i64 lot quantity scaled to lamports. Remainders stay below the
/// oracle-price/entry-scale denominator, so their doubles fit u128.
fn floor_scaled_ratio(
    numerator: i128,
    multiplier: u128,
    denominator: u128,
) -> Result<i128, ProgramError> {
    let magnitude = numerator.unsigned_abs();
    let whole = (magnitude / denominator)
        .checked_mul(multiplier)
        .ok_or(MgkError::Overflow)?;
    let fraction = magnitude % denominator;
    let (quotient, remainder) = if let Some(product) = fraction.checked_mul(multiplier) {
        (product / denominator, product % denominator)
    } else {
        let mut quotient = 0u128;
        let mut remainder = 0u128;
        for bit in (0..(u128::BITS - multiplier.leading_zeros())).rev() {
            remainder = remainder
                .checked_mul(2)
                .and_then(|x| {
                    x.checked_add(if (multiplier >> bit) & 1 != 0 {
                        fraction
                    } else {
                        0
                    })
                })
                .ok_or(MgkError::Overflow)?;
            quotient = quotient
                .checked_mul(2)
                .and_then(|x| x.checked_add(remainder / denominator))
                .ok_or(MgkError::Overflow)?;
            remainder %= denominator;
        }
        (quotient, remainder)
    };
    let rounded = whole
        .checked_add(quotient)
        .and_then(|x| x.checked_add(u128::from(numerator < 0 && remainder != 0)))
        .ok_or(MgkError::Overflow)?;
    if numerator < 0 && rounded == 1u128 << 127 {
        return Ok(i128::MIN);
    }
    let value = i128::try_from(rounded).map_err(|_| MgkError::Overflow)?;
    Ok(if numerator < 0 { -value } else { value })
}

pub fn reservation(
    qty: u64,
    limit: i64,
    conversion: i64,
    reduce_only: bool,
) -> Result<u128, ProgramError> {
    if qty == 0 || qty > i64::MAX as u64 {
        return Err(MgkError::InvalidQuantity.into());
    }
    if limit <= 0 || conversion <= 0 {
        return Err(MgkError::InvalidPrice.into());
    }
    let notional = (qty as u128)
        .checked_mul(limit.max(conversion) as u128)
        .and_then(|x| x.checked_mul(1_000_000))
        .ok_or(MgkError::Overflow)?;
    let divisor = conversion as u128;
    // Reserve independently rounded-up initial margin and worst-case 5 bps fee.
    let fee = notional.div_ceil(divisor.checked_mul(2000).ok_or(MgkError::Overflow)?);
    if reduce_only {
        Ok(fee)
    } else {
        notional
            .div_ceil(divisor.checked_mul(5).ok_or(MgkError::Overflow)?)
            .checked_add(fee)
            .ok_or_else(|| MgkError::Overflow.into())
    }
}

pub fn release(p: &mut Portfolio, index: usize, quantity: u64) -> ProgramResult {
    let record = &mut p.orders[index];
    let before = record.reserved();
    record.remaining_qty = record
        .remaining_qty
        .checked_sub(quantity)
        .ok_or(MgkError::InvalidOrder)?;
    let after = record.reserved();
    if record.remaining_qty == 0 {
        *record = Default::default();
    }
    p.reserved_collateral = p
        .reserved_collateral
        .checked_sub(before - after)
        .ok_or(MgkError::Underflow)?;
    p.recalc_margin();
    Ok(())
}

pub fn open(p: &mut Portfolio, order: crate::state::portfolio::OrderReservation) -> ProgramResult {
    let reserve = order.reserved();
    if reserve > i128::MAX as u128 || p.free_collateral < reserve as i128 {
        return Err(MgkError::InsufficientFunds.into());
    }
    let slot = p
        .orders
        .iter()
        .position(|o| o.remaining_qty == 0)
        .ok_or(MgkError::PoolFull)?;
    p.orders[slot] = order;
    p.reserved_collateral = p
        .reserved_collateral
        .checked_add(reserve)
        .ok_or(MgkError::Overflow)?;
    p.recalc_margin();
    Ok(())
}

pub fn unlocked(registry_account: &AccountInfo) -> ProgramResult {
    crate::matcher_cpi::validate_registry(registry_account)?;
    let registry = unsafe { load_account::<crate::state::Registry>(registry_account)? };
    if registry.has_unsettled_batch() {
        return Err(MgkError::OperationPaused.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::portfolio::OrderReservation;

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
        let mut p = Portfolio::new([1; 32]);
        p.positions[0] = Position { instrument_id: 0, qty: 9_000, ..Position::default() };
        p.positions_len = 1;
        p.orders[0] = resting(1, 0, 400, 0);
        // 9_000 held + 400 resting + 600 new = 10_000: at the limit.
        assert_eq!(check_added_exposure(&vault, &p, 0, 0, 600), Ok(()));
        assert_eq!(
            check_added_exposure(&vault, &p, 0, 0, 601),
            Err(MgkError::PortfolioExposureLimitExceeded)
        );
        // The opposite side reduces the long and is not limited by the resting buy.
        assert_eq!(check_added_exposure(&vault, &p, 0, 1, 5_000), Ok(()));
    }

    #[test]
    fn exposure_gate_applies_market_exposure_limit_and_risk_off() {
        let mut vault = flush_vault();
        vault.open_interest_long = 49_999;
        let p = Portfolio::new([1; 32]);
        assert_eq!(
            check_added_exposure(&vault, &p, 0, 0, 2),
            Err(MgkError::MarketExposureLimitExceeded)
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
    fn wide_reservation_and_partial_release_preserve_exact_rounding() {
        let qty = i64::MAX as u64;
        let reserve = reservation(qty, 1_000_000, 1, false).unwrap();
        assert!(reserve.checked_mul(qty as u128).is_none());
        let mut order = OrderReservation {
            original_qty: qty,
            remaining_qty: qty,
            initial_reserve: reserve,
            ..Default::default()
        };
        assert_eq!(order.reserved(), reserve);
        order.remaining_qty = 1;
        assert_eq!(order.reserved(), reserve.div_ceil(qty as u128));
    }

    #[test]
    fn reserve_rounds_up_and_partial_release_keeps_fraction_until_final_fill() {
        let mut p = Portfolio::new([1; 32]);
        p.equity = 1_000_000;
        p.recalc_margin();
        let reserve = reservation(3, 101, 100, false).unwrap();
        assert_eq!(reserve, 607_515);
        open(
            &mut p,
            OrderReservation {
                original_qty: 3,
                remaining_qty: 3,
                initial_reserve: reserve,
                ..Default::default()
            },
        )
        .unwrap();
        release(&mut p, 0, 1).unwrap();
        assert_eq!(p.reserved_collateral, 405_010);
        release(&mut p, 0, 2).unwrap();
        assert_eq!(p.reserved_collateral, 0);
        assert_eq!(p.free_collateral, p.equity);
    }
}
