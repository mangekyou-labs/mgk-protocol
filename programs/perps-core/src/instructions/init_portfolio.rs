use crate::state::Portfolio;
use pinocchio::{
    account_info::AccountInfo,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};
use mgk_common::layout::{discriminator, init_account_mut, load_account};
use mgk_common::MgkError;

pub fn process_init_portfolio(
    portfolio_account: &AccountInfo,
    user: &Pubkey,
    _bump: u8,
) -> ProgramResult {
    // Portfolio size follows the actual repr(C) layout.
    const PORTFOLIO_SIZE: usize = core::mem::size_of::<Portfolio>();

    // The portfolio account MUST already exist (created by the keeper via
    // InitPortfolioForUser disc 19). We do NOT create accounts here —
    // writing to a 0-byte buffer is a BPF memory access violation.
        if portfolio_account.data_len() < PORTFOLIO_SIZE {
        msg!("Error: Portfolio account does not exist or is too small");
        return Err(ProgramError::InvalidAccountData);
    }

    // Uninitialised (discriminator 0) accounts get a fresh header; anything
    // already stamped must pass the header check and is then idempotent.
    let stamped = unsafe { portfolio_account.borrow_data_unchecked()[0] }
        != discriminator::UNINITIALIZED;
    if stamped {
        let portfolio_data = unsafe { load_account::<Portfolio>(portfolio_account)? };
        // Idempotent: if already initialized for this user, succeed silently.
        if portfolio_data.user == *user {
            msg!("Portfolio already initialized for user");
            return Ok(());
        }
        msg!("Error: Portfolio already initialized for different user");
        return Err(MgkError::Unauthorized.into());
    }

    let portfolio_data = unsafe { init_account_mut::<Portfolio>(portfolio_account)? };
    portfolio_data.initialize_in_place(*user, 0);
    msg!("Portfolio initialized");
    Ok(())
}
