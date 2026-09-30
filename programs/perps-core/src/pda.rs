use mgk_common::MgkError;
use pinocchio::pubkey::{find_program_address, try_find_program_address, Pubkey};

pub const PORTFOLIO_SEED: &[u8] = b"portfolio";
pub const INSTRUMENT_SEED: &[u8] = b"instrument";
pub const VAULT_SEED: &[u8] = b"vault";
pub const REGISTRY_SEED: &[u8] = b"registry";
pub const BATCH_SEED: &[u8] = b"batch";
pub const COMMITMENT_SEED: &[u8] = b"commitment";

pub fn derive_portfolio_pda(user: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    find_program_address(&[PORTFOLIO_SEED, user.as_ref()], program_id)
}

pub fn derive_instrument_pda(instrument_id: u16, program_id: &Pubkey) -> (Pubkey, u8) {
    find_program_address(&[INSTRUMENT_SEED, &instrument_id.to_le_bytes()], program_id)
}

pub fn derive_vault_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    find_program_address(&[VAULT_SEED], program_id)
}

pub fn derive_registry_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    find_program_address(&[REGISTRY_SEED], program_id)
}

pub fn derive_batch_pda(batch_id: u64, program_id: &Pubkey) -> (Pubkey, u8) {
    find_program_address(&[BATCH_SEED, &batch_id.to_le_bytes()], program_id)
}

pub fn derive_commitment_pda(
    batch_id: u64,
    user: &Pubkey,
    nonce: u64,
    program_id: &Pubkey,
) -> (Pubkey, u8) {
    find_program_address(
        &[
            COMMITMENT_SEED,
            &batch_id.to_le_bytes(),
            user.as_ref(),
            &nonce.to_le_bytes(),
        ],
        program_id,
    )
}

/// True iff `account` is the unique vault PDA for `program_id`.
///
/// Host (non-Solana) builds cannot service the PDA syscall and fail closed.
pub fn is_canonical_vault(account: &Pubkey, program_id: &Pubkey) -> bool {
    match try_find_program_address(&[VAULT_SEED], program_id) {
        Some((expected, _)) => account == &expected,
        None => false,
    }
}

/// True iff `account` is the unique registry PDA for `program_id`.
///
/// Host (non-Solana) builds cannot service the PDA syscall and fail closed.
pub fn is_canonical_registry(account: &Pubkey, program_id: &Pubkey) -> bool {
    match try_find_program_address(&[REGISTRY_SEED], program_id) {
        Some((expected, _)) => account == &expected,
        None => false,
    }
}

/// Reject any account that is not the unique vault PDA.
pub fn require_canonical_vault(account: &Pubkey, program_id: &Pubkey) -> Result<(), MgkError> {
    if is_canonical_vault(account, program_id) {
        Ok(())
    } else {
        Err(MgkError::InvalidAccount)
    }
}

/// Reject any account that is not the unique registry PDA.
pub fn require_canonical_registry(account: &Pubkey, program_id: &Pubkey) -> Result<(), MgkError> {
    if is_canonical_registry(account, program_id) {
        Ok(())
    } else {
        Err(MgkError::InvalidAccount)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_vault_account_as_canonical_vault() {
        let program_id = Pubkey::from([7u8; 32]);
        let impostor = Pubkey::from([1u8; 32]);
        // Host PDA syscalls are stubs; the gate must fail closed rather than
        // treat an arbitrary core-owned account as the vault.
        assert!(!is_canonical_vault(&impostor, &program_id));
        assert!(require_canonical_vault(&impostor, &program_id).is_err());
        assert!(!is_canonical_registry(&impostor, &program_id));
        assert!(require_canonical_registry(&impostor, &program_id).is_err());
    }

    #[test]
    fn impostor_core_owned_account_cannot_be_vault() {
        let program_id = Pubkey::from([9u8; 32]);
        let portfolio_shaped = Pubkey::from([2u8; 32]);
        assert!(require_canonical_vault(&portfolio_shaped, &program_id).is_err());
    }
}
