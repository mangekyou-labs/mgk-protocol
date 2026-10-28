//! Canonical matcher boundary. Every mutation uses the registry PDA signature.
use crate::state::Registry;
use mgk_common::{book::OrderBook, layout::load_account, program_ids::PERPS_MATCHER_ID};
use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction, Signer},
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

pub fn validate_registry(registry: &AccountInfo) -> ProgramResult {
    if registry.key() != &mgk_common::matcher::authority_pda().0
        || registry.owner() != &mgk_common::program_ids::PERPS_CORE_ID
    {
        return Err(ProgramError::InvalidSeeds);
    }
    unsafe {
        load_account::<Registry>(registry)?;
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
        || book.key() != &mgk_common::book::book_pda(&PERPS_MATCHER_ID, id).0
    {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(id)
}
pub fn trader(
    registry: &AccountInfo,
    user: &AccountInfo,
    book: &AccountInfo,
    matcher: &AccountInfo,
    data: &[u8],
) -> ProgramResult {
    validate_registry(registry)?;
    validate_book(matcher, book, None)?;
    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let metas = [
        AccountMeta::readonly_signer(registry.key()),
        AccountMeta::readonly_signer(user.key()),
        AccountMeta::writable(book.key()),
    ];
    signed(registry, matcher, &metas, &[registry, user, book], data)
}
pub fn signed<const N: usize>(
    registry: &AccountInfo,
    matcher: &AccountInfo,
    metas: &[AccountMeta],
    infos: &[&AccountInfo; N],
    data: &[u8],
) -> ProgramResult {
    validate_registry(registry)?;
    validate_program(matcher)?;
    let bump = [mgk_common::matcher::authority_pda().1];
    let seeds = pinocchio::seeds!(b"registry", &bump);
    let signer = Signer::from(&seeds);
    let ix = Instruction {
        program_id: &PERPS_MATCHER_ID,
        accounts: metas,
        data,
    };
    invoke_signed::<N>(&ix, infos, &[signer])
}
pub fn validate_batch(program_id: &Pubkey, account: &AccountInfo, id: u64) -> ProgramResult {
    if account.owner() != program_id
        || account.key() != &crate::pda::derive_batch_pda(id, program_id).0
    {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(())
}
