//! Permissionless SOL-PERP takeover liquidation at the validated conversion price.
use crate::{
    collateral_flow::{apply_realized_pnl_and_fee, collect_into_fund},
    instructions::settle_batch::transition::apply_fill,
    state::{Portfolio, Vault},
};
use mgk_common::MgkError;
use pinocchio::program_error::ProgramError;

/// Transfer the same signed quantity from the victim to a funded counterparty.
/// Each step closes floor(25% of the remaining lots), at least one lot. There
/// is no synthetic full-flat fallback and no dependence on the auction mark.
/// Inputs must be validated, distinct portfolios with reservations already cancelled.
/// Returns whether any payout exhausted the fund; the caller must latch a pause.
pub fn takeover(
    victim: &mut Portfolio,
    liquidator: &mut Portfolio,
    vault: &mut Vault,
    instrument_id: u16,
    price: i64,
) -> Result<bool, ProgramError> {
    crate::risk::refresh(victim, instrument_id, price)?;
    crate::risk::refresh(liquidator, instrument_id, price)?;
    if victim.health >= 0 {
        return Err(MgkError::PortfolioHealthy.into());
    }
    let mut exhausted = false;
    while victim.health < 0 && victim.positions_len != 0 {
        let qty = victim.position_qty(instrument_id);
        let step = (qty.unsigned_abs() / 4).max(1) as i64 * qty.signum();
        let old_liquidator = liquidator.position_qty(instrument_id);
        let (realized, _) = apply_fill(victim, instrument_id, -step, price, true, price)?;
        exhausted |= apply_realized_pnl_and_fee(victim, vault, realized, 0)? != 0;
        let (realized, _) = apply_fill(liquidator, instrument_id, step, price, true, price)?;
        exhausted |= apply_realized_pnl_and_fee(liquidator, vault, realized, 0)? != 0;
        vault.apply_position_change(qty, victim.position_qty(instrument_id))?;
        vault.apply_position_change(old_liquidator, liquidator.position_qty(instrument_id))?;
        // 1% of oracle notional converted at that same oracle is 10,000
        // lamports per lot. The fund covers the guaranteed liquidator share
        // when the victim's remaining collateral cannot pay it.
        let penalty = step.unsigned_abs() as u128 * 10_000;
        collect_into_fund(victim, vault, penalty * 2)?;
        exhausted |= vault.outflow(penalty)? != 0;
        liquidator.equity = liquidator
            .equity
            .checked_add(penalty as i128)
            .ok_or(MgkError::Overflow)?;
        vault.balance = vault
            .balance
            .checked_add(u64::try_from(penalty).map_err(|_| MgkError::Overflow)?)
            .ok_or(MgkError::Overflow)?;
        crate::risk::refresh(victim, instrument_id, price)?;
        crate::risk::refresh(liquidator, instrument_id, price)?;
        if liquidator.free_collateral < 0 {
            return Err(MgkError::InsufficientFunds.into());
        }
        let held = liquidator.position_qty(instrument_id).unsigned_abs();
        let side = u8::from(liquidator.position_qty(instrument_id) < 0);
        if held.saturating_add(liquidator.resting_exposure_adding(instrument_id, side))
            > crate::state::vault::PORTFOLIO_EXPOSURE_LIMIT_LOTS
        {
            return Err(MgkError::PortfolioExposureLimitExceeded.into());
        }
    }
    Ok(exhausted)
}
#[cfg(test)]
mod takeover_tests {
    use super::*;
    use crate::state::Position;
    #[test]
    fn takeover_preserves_base_exposure_and_stops_when_healthy() {
        let mut victim = Portfolio::new([1; 32]);
        victim.equity = 80_000_000;
        victim.positions_len = 1;
        victim.positions[0] = Position {
            instrument_id: 0,
            qty: 1000,
            entry_vwap: 100_000_000,
            ..Position::default()
        };
        let mut liquidator = Portfolio::new([2; 32]);
        liquidator.equity = 1_000_000_000;
        let mut vault = Vault::new();
        vault.balance = 1_080_000_000;
        vault.insurance_fund = 20_000_000_000;
        vault.open_interest_long = 1000;
        takeover(&mut victim, &mut liquidator, &mut vault, 0, 100_000_000).unwrap();
        assert_eq!(victim.position_qty(0), 750);
        assert_eq!(liquidator.position_qty(0), 250);
        assert_eq!(victim.equity, 75_000_000);
        assert_eq!(liquidator.equity, 1_002_500_000);
        assert_eq!(vault.insurance_fund, 20_002_500_000);
        assert_eq!(victim.health, 0);
        assert_eq!(vault.open_interest_long, 1000);
    }
}
