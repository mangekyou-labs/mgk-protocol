use crate::state::Portfolio;
use mgk_common::layout::load_account_mut;
use mgk_common::{validate_owner, validate_writable, MgkError};
use pinocchio::{account_info::AccountInfo, msg, pubkey::Pubkey, ProgramResult};

/// Matcher `CancelResting` discriminator.
pub const MATCHER_CANCEL_RESTING: u8 = 1;

/// Cancel a single resting order by `order_id`.
///
/// Accounts:
/// 0. [writable] Portfolio PDA
/// 1. [signer, writable] User wallet
/// 2. [writable] Book account (PDA: `["book", instrument_id_le]`, matcher-owned)
/// 3. [] Matcher program
///
/// Data: order_id(8)
pub fn process_cancel_resting_order(
    program_id: &Pubkey,
    portfolio_account: &AccountInfo,
    user_account: &AccountInfo,
    book_account: &AccountInfo,
    matcher_program: &AccountInfo,
    registry_account: &AccountInfo,
    order_id: u64,
) -> ProgramResult {
    if !user_account.is_signer() {
        msg!("Error: User must be signer");
        return Err(MgkError::Unauthorized.into());
    }

    validate_owner(portfolio_account, program_id)?;
    validate_writable(portfolio_account)?;
    validate_writable(book_account)?;

    let portfolio = unsafe { load_account_mut::<Portfolio>(portfolio_account)? };
    if portfolio.user != *user_account.key() {
        msg!("Error: Portfolio does not belong to user");
        return Err(MgkError::Unauthorized.into());
    }

    crate::risk::unlocked(registry_account)?;
    let index = portfolio.orders.iter().position(|o| o.remaining_qty != 0 && o.order_id == order_id)
        .ok_or(MgkError::InvalidOrder)?;
    crate::matcher_cpi::validate_book(matcher_program, book_account, Some(portfolio.orders[index].instrument_id))?;

    // Build CPI to matcher's CancelResting (disc 1).
    // Wire: discriminator(1) + user(32) + order_id(8) = 41 bytes
    let mut cpi_data = [0u8; 1 + 32 + 8];
    cpi_data[0] = MATCHER_CANCEL_RESTING;
    cpi_data[1..33].copy_from_slice(user_account.key().as_ref());
    cpi_data[33..41].copy_from_slice(&order_id.to_le_bytes());

    crate::matcher_cpi::trader(
        registry_account,
        user_account,
        book_account,
        matcher_program,
        &cpi_data,
    )?;

    crate::risk::release(portfolio, index, portfolio.orders[index].remaining_qty)?;

    msg!("CancelRestingOrder: CPI to matcher complete");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pinocchio::pubkey::Pubkey;

    #[test]
    fn test_matcher_cancel_discriminator_is_one() {
        // Keep the matcher disc in sync with entrypoint.rs.
        assert_eq!(MATCHER_CANCEL_RESTING, 1);
    }

    #[test]
    fn test_cpi_data_layout_is_stable() {
        // 1 (disc) + 32 (user) + 8 (order_id) = 41
        let mut buf = [0u8; 1 + 32 + 8];
        assert_eq!(buf.len(), 41);
        buf[0] = MATCHER_CANCEL_RESTING;
        let user = Pubkey::from([7u8; 32]);
        buf[1..33].copy_from_slice(user.as_ref());
        buf[33..41].copy_from_slice(&12345u64.to_le_bytes());
        assert_eq!(buf[0], 1);
        assert_eq!(buf[1], 7);
        assert_eq!(u64::from_le_bytes(buf[33..41].try_into().unwrap()), 12345);
    }
}
