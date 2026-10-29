use crate::state::{Portfolio, Vault};
use mgk_common::MgkError;
use pinocchio::{account_info::AccountInfo, msg, ProgramResult};

pub fn process_deposit(
    _portfolio_account: &AccountInfo,
    portfolio: &mut Portfolio,
    user_account: &AccountInfo,
    system_program: &AccountInfo,
    vault_account: &AccountInfo,
    vault: &mut Vault,
    amount: u64,
) -> ProgramResult {
    if amount == 0 {
        msg!("Error: Deposit amount must be greater than zero");
        return Err(MgkError::InvalidQuantity.into());
    }

    if !user_account.is_signer() {
        msg!("Error: User must be a signer");
        return Err(MgkError::Unauthorized.into());
    }

    if portfolio.user != *user_account.key() {
        msg!("Error: Portfolio does not belong to user");
        return Err(MgkError::Unauthorized.into());
    }

    let flow = crate::collateral_flow::begin_vault_flow(vault_account, vault)?;

    crate::collateral_flow::system_transfer(user_account, vault_account, system_program, amount)?;

    // Update state
    vault.balance = vault.balance.checked_add(amount).ok_or(MgkError::Overflow)?;

    let amount_i128 = amount as i128;
    portfolio.principal = portfolio.principal
        .checked_add(amount_i128)
        .ok_or(MgkError::Overflow)?;
    portfolio.equity = portfolio.equity
        .checked_add(amount_i128)
        .ok_or(MgkError::Overflow)?;
    portfolio.recalc_margin();

    crate::collateral_flow::verify_vault_flow(vault_account, vault, &flow)?;
    msg!("Deposit successful");
    Ok(())
}
