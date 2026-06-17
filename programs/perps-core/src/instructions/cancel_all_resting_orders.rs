use crate::state::Portfolio;
use percolator_common::{PercolatorError, validate_owner, validate_writable};
use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke,
    pubkey::Pubkey,
    ProgramResult,
};

/// Matcher `CancelAllResting` discriminator (M7 7.7.5).
pub const MATCHER_CANCEL_ALL_RESTING: u8 = 4;

/// Cancel ALL resting orders for a user across all price levels.
///
/// M7 7.7.5 (D4 §MVP.1): called by the keeper BEFORE
/// `LiquidateUser` to clear exposure. Iterates the matcher's
/// resting-order array and removes every order owned by the user.
///
/// Accounts:
/// 0. [writable] Portfolio PDA
/// 1. [signer, writable] User wallet
/// 2. [writable] Book account (PDA: `["book", instrument_id_le]`, matcher-owned)
/// 3. [] Matcher program
///
/// Data: none (M7 7.7.5)
pub fn process_cancel_all_resting_orders(
    program_id: &Pubkey,
    portfolio_account: &AccountInfo,
    user_account: &AccountInfo,
    book_account: &AccountInfo,
    matcher_program: &AccountInfo,
) -> ProgramResult {
    if !user_account.is_signer() {
        msg!("Error: User must be signer");
        return Err(PercolatorError::Unauthorized.into());
    }

    validate_owner(portfolio_account, program_id)?;
    validate_writable(portfolio_account)?;
    validate_writable(book_account)?;

    let portfolio = unsafe { &*(portfolio_account.borrow_data_unchecked().as_ptr() as *const Portfolio) };
    if portfolio.user != *user_account.key() {
        msg!("Error: Portfolio does not belong to user");
        return Err(PercolatorError::Unauthorized.into());
    }

    // Build CPI to matcher's CancelAllResting (disc 4).
    // Wire: discriminator(1) + user(32) = 33 bytes
    let mut cpi_data = [0u8; 1 + 32];
    cpi_data[0] = MATCHER_CANCEL_ALL_RESTING;
    cpi_data[1..33].copy_from_slice(user_account.key().as_ref());

    let cpi_instruction = Instruction {
        program_id: matcher_program.key(),
        accounts: &[AccountMeta {
            pubkey: book_account.key(),
            is_signer: false,
            is_writable: true,
        }],
        data: &cpi_data,
    };

    invoke(
        &cpi_instruction,
        &[book_account, matcher_program],
    )?;

    msg!("CancelAllRestingOrders: CPI to matcher complete");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_matcher_cancel_all_discriminator_is_four() {
        // Keep the matcher disc in sync with entrypoint.rs.
        assert_eq!(MATCHER_CANCEL_ALL_RESTING, 4);
    }

    #[test]
    fn test_cpi_data_layout_is_stable() {
        // 1 (disc) + 32 (user) = 33
        let mut buf = [0u8; 1 + 32];
        assert_eq!(buf.len(), 33);
        buf[0] = MATCHER_CANCEL_ALL_RESTING;
        let user = Pubkey::from([9u8; 32]);
        buf[1..33].copy_from_slice(user.as_ref());
        assert_eq!(buf[0], 4);
        assert_eq!(buf[1], 9);
    }
}
