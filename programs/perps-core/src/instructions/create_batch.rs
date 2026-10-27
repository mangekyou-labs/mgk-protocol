use crate::state::{Batch, Registry};
use mgk_common::layout::{discriminator, init_account_mut, load_account, load_account_mut};
use mgk_common::{validate_owner, validate_writable, MgkError};
use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction, Signer},
    msg,
    program::invoke_signed,
    pubkey::{find_program_address, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

/// System Program ID (all zeros).
const SYSTEM_PROGRAM_ID: [u8; 32] = [0u8; 32];

/// Batch account size (header + body, derived from the struct).
const BATCH_SPACE: usize = core::mem::size_of::<Batch>();

/// Create the first batch in Committing state.
///
/// Accounts:
///   0: [writable] Batch PDA (created here via invoke_signed if not yet existing)
///   1: [writable] Registry
///   2: [signer, writable] Payer (governance; funds PDA creation rent)
///
/// Data: bump(1)
pub fn process_create_batch(
    program_id: &Pubkey,
    batch_account: &AccountInfo,
    registry_account: &AccountInfo,
    payer_account: Option<&AccountInfo>,
    bump: u8,
) -> ProgramResult {
    validate_writable(batch_account)?;
    validate_writable(registry_account)?;

    // ── Create batch PDA if needed ──────────────────────────────────────────
    if batch_account.data_len() < BATCH_SPACE {
        let payer = payer_account.ok_or_else(|| {
            msg!("Error: payer required to create batch PDA");
            MgkError::InvalidAccount
        })?;
        if !payer.is_signer() {
            msg!("Error: payer must sign");
            return Err(MgkError::Unauthorized.into());
        }

        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(BATCH_SPACE);

        // Read batch_id from registry counter to derive the correct PDA.
        let batch_id = { unsafe { *load_account::<Registry>(registry_account)? } }.batch_id_counter;
        let batch_id_le = batch_id.to_le_bytes();
        let (batch_pda, _) = find_program_address(&[b"batch", &batch_id_le], program_id);

        // Build SystemProgram::CreateAccount instruction.
        let mut ix_data = [0u8; 52];
        ix_data[0..4].copy_from_slice(&0u32.to_le_bytes());
        ix_data[4..12].copy_from_slice(&lamports.to_le_bytes());
        ix_data[12..20].copy_from_slice(&(BATCH_SPACE as u64).to_le_bytes());
        ix_data[20..52].copy_from_slice(program_id.as_ref());

        let sys_id = Pubkey::from(SYSTEM_PROGRAM_ID);
        let metas = [
            AccountMeta::writable_signer(payer.key()),
            AccountMeta::writable_signer(&batch_pda),
        ];
        let ix = Instruction {
            program_id: &sys_id,
            accounts: &metas,
            data: &ix_data,
        };

        let bump_seed = [bump];
        let signer_seeds = pinocchio::seeds!(b"batch", batch_id_le.as_slice(), &bump_seed);
        let signer = Signer::from(&signer_seeds);
        invoke_signed::<2>(&ix, &[payer, batch_account], &[signer])?;
        msg!("Batch PDA created");
    }

    // Verify batch is not already initialized: a stamped header (any
    // non-zero discriminator) or a non-zero batch_id means it is in use.
    {
        let data = unsafe { batch_account.borrow_data_unchecked() };
        if data.len() < BATCH_SPACE {
            return Err(MgkError::InvalidAccount.into());
        }
        if data[0] != discriminator::UNINITIALIZED {
            return Err(MgkError::AlreadyInitialized.into());
        }
    }

    let current_slot = Clock::get()?.slot;
    // batch_id equals the current registry counter value (0 for the first batch).
    // After this, counter is incremented so it equals total batches created.
    // The registry header is checked by `load_account`.
    let registry = { unsafe { *load_account::<Registry>(registry_account)? } };
    let batch_id = registry.batch_id_counter;
    let t_max_slots = registry.t_max_slots;

    // Raw byte stores for the counter keep the SBF packed-field workaround.
    // After this, counter = total batches created = batch_id + 1.
    Registry::write_batch_id_counter(
        unsafe { registry_account.borrow_mut_data_unchecked() },
        batch_id.saturating_add(1),
    );

    // Typed init stamps the batch header and writes each field at its
    // `repr(C)` offset; `reveal_deadline` stays 0 until CloseCommitting.
    let batch = unsafe { init_account_mut::<Batch>(batch_account)? };
    batch.initialize_in_place(batch_id, current_slot.saturating_add(t_max_slots), 0, bump);

    Ok(())
}

/// Reset `batch_id_counter` to 0 so `CreateBatch` can bootstrap batch 0.
///
/// Accounts:
///   0: [writable] Registry
///   1: [signer]   Governance (must equal registry.governance)
pub fn process_set_batch_counter(
    registry_account: &AccountInfo,
    governance_account: &AccountInfo,
) -> ProgramResult {
    let program_id = registry_account.owner();
    validate_owner(registry_account, program_id)?;
    validate_writable(registry_account)?;

    // Header check (discriminator + layout version) before any access.
    let registry = unsafe { load_account_mut::<Registry>(registry_account)? };
    let stored_governance = registry.governance;

    let caller = governance_account.key();
    if caller.as_ref() != stored_governance {
        return Err(MgkError::Unauthorized.into());
    }

    Registry::write_batch_id_counter(
        unsafe { registry_account.borrow_mut_data_unchecked() },
        0,
    );

    Ok(())
}
