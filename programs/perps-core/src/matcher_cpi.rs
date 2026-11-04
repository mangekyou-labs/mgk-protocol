//! Canonical matcher boundary. Every mutation uses the registry PDA signature.
use crate::state::{Registry, Vault};
use mgk_common::{book::OrderBook, layout::load_account, program_ids::PERPS_MATCHER_ID};
use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

pub fn validate_registry(
    context: mgk_common::market::MarketContext,
    registry: &AccountInfo,
) -> ProgramResult {
    if registry.key() != &mgk_common::matcher::authority_pda_in(context).0
        || registry.owner() != &mgk_common::program_ids::PERPS_CORE_ID
    {
        return Err(ProgramError::InvalidSeeds);
    }
    unsafe {
        load_account::<Registry>(registry)?;
    }
    Ok(())
}
/// The vault must be the program-owned `[b"vault"]` PDA: a look-alike vault
/// account at another address is refused.
pub fn validate_vault(
    context: mgk_common::market::MarketContext,
    program_id: &Pubkey,
    vault: &AccountInfo,
) -> ProgramResult {
    if vault.owner() != program_id
        || vault.key() != &crate::pda::derive_vault_pda_in(context, program_id).0
    {
        return Err(ProgramError::InvalidSeeds);
    }
    unsafe {
        load_account::<Vault>(vault)?;
    }
    Ok(())
}
pub fn validate_program(matcher: &AccountInfo) -> ProgramResult {
    if matcher.key() != &PERPS_MATCHER_ID || !matcher.executable() {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}
pub fn validate_book(
    context: mgk_common::market::MarketContext,
    matcher: &AccountInfo,
    book: &AccountInfo,
    instrument: Option<u16>,
) -> Result<u16, ProgramError> {
    validate_program(matcher)?;
    if book.owner() != &PERPS_MATCHER_ID {
        return Err(ProgramError::IllegalOwner);
    }
    let id = unsafe { load_account::<OrderBook>(book)? }.instrument_id;
    if instrument.is_some_and(|expected| id != expected)
        || book.key() != &mgk_common::book::book_pda_in(context, &PERPS_MATCHER_ID, id).0
    {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(id)
}
pub fn trader(
    context: mgk_common::market::MarketContext,
    registry: &AccountInfo,
    user: &AccountInfo,
    book: &AccountInfo,
    matcher: &AccountInfo,
    data: &[u8],
) -> ProgramResult {
    validate_registry(context, registry)?;
    validate_book(context, matcher, book, None)?;
    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let metas = [
        AccountMeta::readonly_signer(registry.key()),
        AccountMeta::readonly_signer(user.key()),
        AccountMeta::writable(book.key()),
    ];
    signed(
        context,
        registry,
        matcher,
        &metas,
        &[registry, user, book],
        data,
    )
}
pub fn signed<const N: usize>(
    context: mgk_common::market::MarketContext,
    registry: &AccountInfo,
    matcher: &AccountInfo,
    metas: &[AccountMeta],
    infos: &[&AccountInfo; N],
    data: &[u8],
) -> ProgramResult {
    validate_registry(context, registry)?;
    validate_program(matcher)?;
    let mut wrapped = [0u8; 1232];
    let data = match context {
        mgk_common::market::MarketContext::Legacy => data,
        mgk_common::market::MarketContext::Scoped { market_seed } => {
            if data.len() > wrapped.len() - 33 {
                return Err(ProgramError::InvalidInstructionData);
            }
            wrapped[0] = 10;
            wrapped[1..33].copy_from_slice(&market_seed);
            wrapped[33..33 + data.len()].copy_from_slice(data);
            &wrapped[..33 + data.len()]
        }
    };
    let ix = Instruction {
        program_id: &PERPS_MATCHER_ID,
        accounts: metas,
        data,
    };
    crate::pda::invoke_pda(
        context,
        b"registry",
        &[],
        &mgk_common::program_ids::PERPS_CORE_ID,
        &ix,
        infos,
    )
}
pub fn validate_batch(
    context: mgk_common::market::MarketContext,
    program_id: &Pubkey,
    account: &AccountInfo,
    id: u64,
) -> ProgramResult {
    if account.owner() != program_id
        || account.key() != &crate::pda::derive_batch_pda_in(context, id, program_id).0
    {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(())
}
