use crate::state::{Portfolio, Vault};
use mgk_common::layout::{load_account, load_account_mut};
use mgk_common::{validate_owner, validate_writable, MgkError};
use pinocchio::{account_info::AccountInfo, msg, pubkey::Pubkey, ProgramResult};

/// Matcher `ModifyResting` discriminator.
pub const MATCHER_MODIFY_RESTING: u8 = 2;

/// Modify a single resting order's qty by `order_id`.
///
/// Accounts:
/// 0. [writable] Portfolio PDA
/// 1. [signer, writable] User wallet
/// 2. [writable] Book account (PDA: `["book", instrument_id_le]`, matcher-owned)
/// 3. [] Matcher program
/// 4. [] Registry
/// 5. [] Instrument PDA
/// 6. [] Conversion oracle
/// 7. [] Vault PDA (exposure limits and risk-off gate for quantity increases)
///
/// Data: order_id(8) + new_qty(8)
#[allow(clippy::too_many_arguments)]
pub fn process_modify_resting_order(
    program_id: &Pubkey,
    portfolio_account: &AccountInfo,
    user_account: &AccountInfo,
    book_account: &AccountInfo,
    matcher_program: &AccountInfo,
    registry_account: &AccountInfo,
    instrument_account: &AccountInfo,
    oracle_account: &AccountInfo,
    vault_account: &AccountInfo,
    order_id: u64,
    new_qty: u64,
) -> ProgramResult {
    if new_qty == 0 {
        msg!("Error: new_qty must be > 0");
        return Err(MgkError::InvalidAmount.into());
    }

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
    let mut order = portfolio.orders[index];
    crate::matcher_cpi::validate_book(matcher_program, book_account, Some(order.instrument_id))?;
    let conversion = crate::risk::conversion(program_id, instrument_account, oracle_account, order.instrument_id)?;
    crate::risk::refresh(portfolio, order.instrument_id, conversion)?;
    let registry = unsafe { load_account::<crate::state::Registry>(registry_account)? };
    if order.reduce_only == 0 && (registry.is_trading_paused() || registry.is_posts_paused()) {
        return Err(MgkError::OperationPaused.into());
    }
    if order.reduce_only != 0 {
        let qty = portfolio.position_qty(order.instrument_id);
        if qty == 0 || (qty > 0) == (order.side == 0) { return Err(MgkError::ReduceOnlyViolation.into()); }
    }
    validate_owner(vault_account, program_id)?;
    if order.reduce_only == 0 && new_qty > order.remaining_qty {
        let vault = unsafe { load_account::<Vault>(vault_account)? };
        crate::risk::check_added_exposure(
            vault,
            portfolio,
            order.instrument_id,
            order.side,
            new_qty - order.remaining_qty,
        )
        .inspect_err(|_| {
            msg!("Error: exposure limit or risk-off reserve exceeded");
        })?;
    }
    crate::risk::release(portfolio, index, order.remaining_qty)?;
    order.original_qty = new_qty;
    order.remaining_qty = new_qty;
    order.initial_reserve = crate::risk::reservation(new_qty, order.price, conversion, order.reduce_only != 0)?;
    crate::risk::open(portfolio, order)?;

    // Build CPI to matcher's ModifyResting (disc 2).
    // Wire: discriminator(1) + user(32) + order_id(8) + new_qty(8) = 49 bytes
    let mut cpi_data = [0u8; 1 + 32 + 8 + 8];
    cpi_data[0] = MATCHER_MODIFY_RESTING;
    cpi_data[1..33].copy_from_slice(user_account.key().as_ref());
    cpi_data[33..41].copy_from_slice(&order_id.to_le_bytes());
    cpi_data[41..49].copy_from_slice(&new_qty.to_le_bytes());

    crate::matcher_cpi::trader(
        registry_account,
        user_account,
        book_account,
        matcher_program,
        &cpi_data,
    )?;

    msg!("ModifyRestingOrder: CPI to matcher complete");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pinocchio::pubkey::Pubkey;

    #[test]
    fn test_matcher_modify_discriminator_is_two() {
        assert_eq!(MATCHER_MODIFY_RESTING, 2);
    }

    #[test]
    fn test_cpi_data_layout_is_stable() {
        // 1 (disc) + 32 (user) + 8 (order_id) + 8 (new_qty) = 49
        let mut buf = [0u8; 1 + 32 + 8 + 8];
        assert_eq!(buf.len(), 49);
        buf[0] = MATCHER_MODIFY_RESTING;
        let user = Pubkey::from([9u8; 32]);
        buf[1..33].copy_from_slice(user.as_ref());
        buf[33..41].copy_from_slice(&42u64.to_le_bytes());
        buf[41..49].copy_from_slice(&7u64.to_le_bytes());
        assert_eq!(buf[0], 2);
        assert_eq!(u64::from_le_bytes(buf[33..41].try_into().unwrap()), 42);
        assert_eq!(u64::from_le_bytes(buf[41..49].try_into().unwrap()), 7);
    }
}
