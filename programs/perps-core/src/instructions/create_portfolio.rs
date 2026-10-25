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

use crate::state::Portfolio;
use mgk_common::layout::init_account_mut;
use pinocchio::{
    account_info::AccountInfo,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

pub fn process_create_portfolio(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    // Accounts:
    //  0: [writable] Portfolio PDA (pre-created by client via SystemProgram.createAccount)
    //  1: [signer]   User wallet
    //
    // Data: disc(1) + bump(1) → after strip: data[0] = bump

    let portfolio_account = &accounts[0];
    let user_account = &accounts[1];

    if !user_account.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if portfolio_account.data_len() < core::mem::size_of::<Portfolio>() {
        return Err(ProgramError::InvalidAccountData);
    }

    let bump = data.first().copied().unwrap_or(0);

    let portfolio = unsafe { init_account_mut::<Portfolio>(portfolio_account)? };
    portfolio.initialize_in_place(*user_account.key(), bump);

    msg!("CreatePortfolio: initialized portfolio for user");
    Ok(())
}
