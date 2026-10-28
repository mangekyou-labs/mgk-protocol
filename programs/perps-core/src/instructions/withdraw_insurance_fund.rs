//! WithdrawInsuranceFund (disc 27): admin removes fund surplus above the reserve.

use crate::state::{Registry, Vault};
use mgk_common::MgkError;
use pinocchio::{account_info::AccountInfo, msg, ProgramResult};

/// Pure ledger rule: the fund may shrink only by `amount <= fund_surplus()`.
pub(crate) fn apply_fund_withdrawal(vault: &mut Vault, amount: u64) -> Result<(), MgkError> {
    if amount == 0 {
        return Err(MgkError::InvalidAmount);
    }
    let amount = amount as u128;
    if amount > vault.fund_surplus() {
        return Err(MgkError::FundWithdrawalExceedsSurplus);
    }
    vault.insurance_fund -= amount;
    Ok(())
}

/// Move `amount` surplus lamports from the vault to governance.
///
/// Accounts:
/// 0. [writable] Vault PDA
/// 1. [] Registry PDA
/// 2. [signer, writable] Governance (receives the lamports)
///
/// Data: amount(8)
pub fn process_withdraw_insurance_fund(
    vault_account: &AccountInfo,
    vault: &mut Vault,
    registry: &Registry,
    governance_account: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    crate::instructions::unpause::require_governance(registry, governance_account)?;
    apply_fund_withdrawal(vault, amount)?;

    let vault_lamports = vault_account
        .lamports()
        .checked_sub(amount)
        .ok_or(MgkError::Underflow)?;
    let governance_lamports = governance_account
        .lamports()
        .checked_add(amount)
        .ok_or(MgkError::Overflow)?;
    unsafe {
        *vault_account.borrow_mut_lamports_unchecked() = vault_lamports;
        *governance_account.borrow_mut_lamports_unchecked() = governance_lamports;
    }

    crate::cash::assert_vault_invariant(vault_account, vault)?;
    msg!("WithdrawInsuranceFund successful");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault_with_surplus() -> Vault {
        let mut v = Vault::new();
        v.open_interest_long = 20_000; // reserve 8_000_000_000
        v.insurance_fund = 10_000_000_000;
        v
    }

    #[test]
    fn withdrawal_up_to_the_surplus_succeeds() {
        let mut v = vault_with_surplus();
        apply_fund_withdrawal(&mut v, 2_000_000_000).unwrap();
        assert_eq!(v.insurance_fund, 8_000_000_000);
        assert_eq!(v.fund_surplus(), 0);
    }

    #[test]
    fn withdrawal_above_the_surplus_is_refused_and_changes_nothing() {
        let mut v = vault_with_surplus();
        assert_eq!(
            apply_fund_withdrawal(&mut v, 2_000_000_001),
            Err(MgkError::FundWithdrawalExceedsSurplus)
        );
        assert_eq!(v.insurance_fund, 10_000_000_000);
    }

    #[test]
    fn withdrawal_is_refused_while_bad_debt_is_outstanding() {
        let mut v = vault_with_surplus();
        v.uncovered_bad_debt = 1;
        assert_eq!(
            apply_fund_withdrawal(&mut v, 1),
            Err(MgkError::FundWithdrawalExceedsSurplus)
        );
    }

    #[test]
    fn zero_withdrawal_is_refused() {
        let mut v = vault_with_surplus();
        assert_eq!(apply_fund_withdrawal(&mut v, 0), Err(MgkError::InvalidAmount));
    }

    #[test]
    fn the_fund_never_goes_below_the_reserve() {
        let mut v = vault_with_surplus();
        v.open_interest_short = 25_000; // reserve 10_000_000_000
        assert_eq!(
            apply_fund_withdrawal(&mut v, 1),
            Err(MgkError::FundWithdrawalExceedsSurplus)
        );
    }
}
