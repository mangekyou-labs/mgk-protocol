use mgk_common::layout::init_account_mut;
use crate::state::Vault;
use pinocchio::{
    account_info::AccountInfo,
    ProgramResult,
};

/// Initialize the Vault in-place.
///
/// Accounts:
///   0: [writable] Vault account (pre-created, keypair-owned on Solana 4.x)
///
/// Data: bump(1)
pub fn process_init_vault(vault_account: &AccountInfo, bump: u8) -> ProgramResult {
    let vault_data = unsafe {
        init_account_mut::<Vault>(vault_account)?
    };
    vault_data.initialize_in_place(bump);
    Ok(())
}