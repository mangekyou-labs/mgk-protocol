use crate::state::Vault;
use mgk_common::MgkError;
use pinocchio::{
    account_info::AccountInfo,
    ProgramResult,
};

/// Vault data may be zero-initialized only when bump, balance, and insurance
/// are still unset. Any of those fields non-zero means live funds or a prior init.
pub(crate) fn vault_already_initialized(balance: u64, insurance_fund: u128, bump: u8) -> bool {
    bump != 0 || balance != 0 || insurance_fund != 0
}

/// Initialize the Vault in-place.
///
/// Accounts:
///   0: [writable] Vault account (pre-created, keypair-owned on Solana 4.x)
///
/// Data: bump(1)
pub fn process_init_vault(vault_account: &AccountInfo, bump: u8) -> ProgramResult {
    let vault_data = unsafe {
        &mut *(vault_account.borrow_mut_data_unchecked().as_ptr() as *mut Vault)
    };
    if vault_already_initialized(
        vault_data.balance,
        vault_data.insurance_fund,
        vault_data.bump,
    ) {
        return Err(MgkError::AlreadyInitialized.into());
    }
    vault_data.initialize_in_place(bump);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uninitialized_vault_may_be_zeroed() {
        assert!(!vault_already_initialized(0, 0, 0));
    }

    #[test]
    fn vault_with_balance_must_not_be_zeroed() {
        assert!(
            vault_already_initialized(1, 0, 0),
            "InitVault must not wipe deposited collateral"
        );
    }

    #[test]
    fn vault_with_insurance_must_not_be_zeroed() {
        assert!(
            vault_already_initialized(0, 1, 0),
            "InitVault must not wipe the insurance fund"
        );
    }

    #[test]
    fn vault_with_bump_must_not_be_reinitialized() {
        assert!(
            vault_already_initialized(0, 0, 42),
            "InitVault must not re-zero a vault that Initialize already bumped"
        );
    }
}