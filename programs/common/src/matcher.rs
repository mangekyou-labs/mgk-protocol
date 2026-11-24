//! Authenticated matcher CPI and batch-results envelope shared by both programs.
use crate::market::MarketContext;
use crate::{
    layout,
    program_ids::{PERPS_CORE_ID, PERPS_MATCHER_ID},
};
use pinocchio::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, ProgramResult};

pub const RESULTS_ENVELOPE_LEN: usize = 9;
/// At most twelve distinct portfolios plus the fixed settlement accounts.
pub const MAX_SETTLEMENT_ORDERS: usize = 12;

pub fn authority_pda() -> (Pubkey, u8) {
    authority_pda_in(MarketContext::Legacy)
}
pub fn results_pda(batch_id: u64) -> (Pubkey, u8) {
    results_pda_in(MarketContext::Legacy, batch_id)
}
pub fn validate_authority(authority: &AccountInfo) -> ProgramResult {
    validate_authority_in(MarketContext::Legacy, authority)
}
pub fn authority_pda_in(context: MarketContext) -> (Pubkey, u8) {
    context.registry_pda(&PERPS_CORE_ID)
}
pub fn results_pda_in(context: MarketContext, batch_id: u64) -> (Pubkey, u8) {
    context.child_pda(b"results", &[&batch_id.to_le_bytes()], &PERPS_MATCHER_ID)
}
pub fn validate_authority_in(context: MarketContext, authority: &AccountInfo) -> ProgramResult {
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if authority.key() != &authority_pda_in(context).0 || authority.owner() != &PERPS_CORE_ID {
        return Err(ProgramError::InvalidSeeds);
    }
    layout::check_header(
        &authority.try_borrow_data()?,
        layout::discriminator::REGISTRY,
        layout::LAYOUT_VERSION_1,
    )?;
    Ok(())
}
pub fn validate_results(account: &AccountInfo, batch_id: u64) -> ProgramResult {
    validate_results_in(MarketContext::Legacy, account, batch_id)
}
pub fn validate_results_in(
    context: MarketContext,
    account: &AccountInfo,
    batch_id: u64,
) -> ProgramResult {
    if account.owner() != &PERPS_MATCHER_ID {
        return Err(ProgramError::IllegalOwner);
    }
    if account.key() != &results_pda_in(context, batch_id).0 {
        return Err(ProgramError::InvalidSeeds);
    }
    if !account.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}
/// Results payload for `batch_id` whose spent flag equals `spent`.
///
/// Settlement reads unspent output (`spent == false`); issue 74's close
/// path requires output core has already consumed (`spent == true`).
pub fn results_with_spent(raw: &[u8], batch_id: u64, spent: bool) -> Result<&[u8], ProgramError> {
    let body = layout::body(
        raw,
        layout::discriminator::BATCH_RESULTS,
        layout::LAYOUT_VERSION_1,
    )?;
    if body.len() < RESULTS_ENVELOPE_LEN
        || body[..8] != batch_id.to_le_bytes()
        || body[8] != u8::from(spent)
    {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(&body[RESULTS_ENVELOPE_LEN..])
}

/// Close a program-owned account: move every lamport to `recipient`, then
/// zero its length, lamports and owner (pinocchio `close`). The caller must
/// own `account` and have validated both accounts. Any CPI that needs the
/// account's data must run before this, since the runtime zeroes the data
/// at the next CPI.
pub fn close_account(account: &AccountInfo, recipient: &AccountInfo) -> ProgramResult {
    let lamports = account.lamports();
    let credited = recipient
        .lamports()
        .checked_add(lamports)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    *recipient.try_borrow_mut_lamports()? = credited;
    *account.try_borrow_mut_lamports()? = 0;
    account.close()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wrong_batch_and_spent_results_are_rejected() {
        let mut raw = [0u8; layout::ACCOUNT_HEADER_LEN + RESULTS_ENVELOPE_LEN + 34];
        let body = layout::stamp_body_mut(
            &mut raw,
            layout::discriminator::BATCH_RESULTS,
            layout::LAYOUT_VERSION_1,
        )
        .unwrap();
        body[..8].copy_from_slice(&7u64.to_le_bytes());
        assert!(results_with_spent(&raw, 7, false).is_ok());
        assert!(results_with_spent(&raw, 8, false).is_err());
        raw[layout::ACCOUNT_HEADER_LEN + 8] = 1;
        assert!(results_with_spent(&raw, 7, false).is_err());
    }

    #[test]
    fn only_spent_results_for_the_batch_are_closable() {
        let mut raw = [0u8; layout::ACCOUNT_HEADER_LEN + RESULTS_ENVELOPE_LEN + 34];
        let body = layout::stamp_body_mut(
            &mut raw,
            layout::discriminator::BATCH_RESULTS,
            layout::LAYOUT_VERSION_1,
        )
        .unwrap();
        body[..8].copy_from_slice(&7u64.to_le_bytes());
        assert_eq!(
            results_with_spent(&raw, 7, true),
            Err(ProgramError::InvalidAccountData)
        );
        raw[layout::ACCOUNT_HEADER_LEN + 8] = 1;
        assert!(results_with_spent(&raw, 7, true).is_ok());
        assert_eq!(
            results_with_spent(&raw, 8, true),
            Err(ProgramError::InvalidAccountData)
        );
        assert!(results_with_spent(&[0u8; 4], 7, true).is_err());
    }
}
