//! CreatePortfolio (disc 18) — DEPRECATED in favor of client-side
//! `SystemProgram.createAccount` + `InitPortfolio` (disc 1).
//!
//! Client workflow:
//!   1. derivePortfolioPda(user, programId) → [pda, bump]
//!   2. SystemProgram.createAccount(from=user, to=pda, space=size_of::<Portfolio>(), owner=programId)
//!   3. InitPortfolio(pda, user) — initializes account data
//!
//! This instruction is kept for backwards compatibility. It writes owner+bump
//! to an already-created account (created by the wallet, not via CPI).

use super::init_portfolio_for_user::{may_overwrite_portfolio_user, portfolio_pda_matches};
use crate::state::Portfolio;
use mgk_common::MgkError;
use pinocchio::{
    account_info::AccountInfo,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

pub fn process_create_portfolio(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    // Accounts:
    //  0: [writable] Portfolio PDA (pre-created by client via SystemProgram.createAccount)
    //  1: [signer]   User wallet
    //
    // Data: disc(1) + bump(1) → after strip: data[0] = bump

    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let portfolio_account = &accounts[0];
    let user_account = &accounts[1];

    if !user_account.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if !portfolio_pda_matches(portfolio_account.key(), user_account.key(), program_id) {
        msg!("Error: portfolio account is not the signer PDA");
        return Err(ProgramError::InvalidSeeds);
    }

    let data_slice = unsafe { portfolio_account.borrow_mut_data_unchecked() };
    if data_slice.is_empty() || data_slice.len() < core::mem::size_of::<Portfolio>() {
        return Err(ProgramError::InvalidAccountData);
    }

    let bump = data.first().copied().unwrap_or(0);

    let portfolio = unsafe { &mut *(data_slice.as_ptr() as *mut Portfolio) };
    if portfolio.user == *user_account.key() {
        msg!("CreatePortfolio: already initialized");
        return Ok(());
    }
    if !may_overwrite_portfolio_user(&portfolio.user) {
        msg!("Error: portfolio already initialized");
        return Err(MgkError::AlreadyInitialized.into());
    }
    portfolio.initialize_in_place(*user_account.key(), bump);

    msg!("CreatePortfolio: initialized portfolio for user");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_portfolio_must_not_overwrite_initialized_user() {
        assert!(!may_overwrite_portfolio_user(&Pubkey::from([1u8; 32])));
        assert!(may_overwrite_portfolio_user(&Pubkey::from([0u8; 32])));
    }
}
