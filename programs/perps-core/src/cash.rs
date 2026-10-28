//! Capped lamport movement between portfolio collateral and the vault.
//!
//! Shared by settlement and liquidation so both keep the vault balance
//! equation `lamports - rent = sum(collateral) + fund - uncovered_bad_debt`
//! exact (ADR 0003, issue #23).

use crate::state::portfolio::Portfolio;
use crate::state::vault::Vault;
use mgk_common::MgkError;
use pinocchio::program_error::ProgramError;

fn add(a: i128, b: i128) -> Result<i128, ProgramError> {
    a.checked_add(b).ok_or_else(|| MgkError::Overflow.into())
}

/// Move the lamports for one realized PnL and fee.
///
/// A gain is credited in full from the insurance fund; whatever the fund
/// cannot cover becomes uncovered bad debt. A loss or fee collects only what
/// the portfolio holds, so an uncollected remainder moves no lamports and the
/// vault balance equation stays exact. Returns the payout shortfall so the
/// caller can pause trading and withdrawals.
pub(crate) fn settle_cash(
    p: &mut Portfolio,
    vault: &mut Vault,
    realized: i128,
    fee: i128,
) -> Result<u128, ProgramError> {
    let mut shortfall = 0u128;
    if realized >= 0 {
        let gain = realized as u128;
        let balance = vault
            .balance
            .checked_add(u64::try_from(gain).map_err(|_| MgkError::Overflow)?)
            .ok_or(MgkError::Overflow)?;
        let equity = add(p.equity, realized)?;
        let realized_lamports = add(p.realized_lamports, realized)?;
        shortfall = vault.outflow(gain)?;
        vault.balance = balance;
        p.equity = equity;
        p.realized_lamports = realized_lamports;
    } else {
        let collected = collect(p, vault, realized.unsigned_abs())?;
        p.realized_lamports = add(p.realized_lamports, -(collected as i128))?;
    }
    let collected = collect(p, vault, u128::try_from(fee).map_err(|_| MgkError::Overflow)?)?;
    p.fees_paid = add(p.fees_paid, collected as i128)?;
    Ok(shortfall)
}

/// Collect up to `owed` lamports from the portfolio's collateral into the fund
/// (repaying debt first). Returns the amount actually collected.
pub(crate) fn collect(
    p: &mut Portfolio,
    vault: &mut Vault,
    owed: u128,
) -> Result<u128, ProgramError> {
    let available = u128::try_from(p.equity.max(0)).map_err(|_| MgkError::Overflow)?;
    let collected = owed.min(available);
    if collected == 0 {
        return Ok(0);
    }
    let balance = vault
        .balance
        .checked_sub(u64::try_from(collected).map_err(|_| MgkError::Overflow)?)
        .ok_or(MgkError::Underflow)?;
    vault.inflow(collected)?;
    vault.balance = balance;
    p.equity = add(p.equity, -(collected as i128))?;
    Ok(collected)
}
