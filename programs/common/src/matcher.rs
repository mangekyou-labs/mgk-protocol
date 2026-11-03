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
pub fn unspent_results(raw: &[u8], batch_id: u64) -> Result<&[u8], ProgramError> {
    let body = layout::body(
        raw,
        layout::discriminator::BATCH_RESULTS,
        layout::LAYOUT_VERSION_1,
    )?;
    if body.len() < RESULTS_ENVELOPE_LEN || body[..8] != batch_id.to_le_bytes() || body[8] != 0 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(&body[RESULTS_ENVELOPE_LEN..])
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
        assert!(unspent_results(&raw, 7).is_ok());
        assert!(unspent_results(&raw, 8).is_err());
        raw[layout::ACCOUNT_HEADER_LEN + 8] = 1;
        assert!(unspent_results(&raw, 7).is_err());
    }
}
