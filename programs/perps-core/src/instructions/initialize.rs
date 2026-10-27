use crate::state::{Instrument, Registry, Vault};
use mgk_common::layout::init_account_mut;
use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction, Signer},
    msg,
    program::invoke_signed,
    pubkey::{find_program_address, Pubkey},
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};

/// System Program ID (all zeros).
const SYSTEM_PROGRAM_ID_BYTES: [u8; 32] = [0u8; 32];

/// Account sizes derive from the structs (each starts with an `AccountHeader`).
const REGISTRY_SPACE: usize = core::mem::size_of::<Registry>();
const INSTRUMENT_SPACE: usize = core::mem::size_of::<Instrument>();
const VAULT_SPACE: usize = core::mem::size_of::<Vault>();

/// Build a SystemProgram::CreateAccount instruction (52 bytes).
fn build_create_account_ix<'a>(
    payer: &'a Pubkey,
    new_account: &'a Pubkey,
    lamports: u64,
    space: usize,
    owner: &'a Pubkey,
) -> ([u8; 52], [AccountMeta<'a>; 2]) {
    let mut data = [0u8; 52];
    data[0..4].copy_from_slice(&0u32.to_le_bytes());
    data[4..12].copy_from_slice(&lamports.to_le_bytes());
    data[12..20].copy_from_slice(&(space as u64).to_le_bytes());
    data[20..52].copy_from_slice(owner.as_ref());
    let metas = [
        AccountMeta::writable_signer(payer),
        AccountMeta::writable_signer(new_account),
    ];
    (data, metas)
}

#[allow(clippy::too_many_arguments)]
pub fn process_initialize(
    program_id: &Pubkey,
    registry_account: &AccountInfo,
    governance_account: &AccountInfo,
    governance: &Pubkey,
    instrument_count: u16,
    volatility_multiplier: u16,
    base_deposit: u64,
    n_min: u32,
    t_min_slots: u64,
    t_max_slots: u64,
    t_reveal_slots: u64,
    registry_bump: u8,
    instrument_account: &AccountInfo,
    instrument_id: u16,
    tick_size: u64,
    lot_size: u64,
    imr_bps: u16,
    mmr_bps: u16,
    taker_fee_bps: u16,
    maker_fee_bps: i16,
    oracle_addr: Pubkey,
    instrument_bump: u8,
    _system_program: &AccountInfo,
    vault_account: &AccountInfo,
    vault_bump: u8,
) -> ProgramResult {
    if taker_fee_bps != 5 || maker_fee_bps != 0 {
        return Err(mgk_common::MgkError::InvalidRiskParams.into());
    }
    msg!("INIT_RUST_V3");

    // ── Create registry PDA if needed ────────────────────────────────────────
    if registry_account.data_len() < REGISTRY_SPACE {
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(REGISTRY_SPACE);
        let (reg_pda, _) = find_program_address(&[b"registry"], program_id);
        let (ix_data, metas) = build_create_account_ix(
            governance_account.key(),
            &reg_pda,
            lamports,
            REGISTRY_SPACE,
            program_id,
        );
        let sys_id = Pubkey::from(SYSTEM_PROGRAM_ID_BYTES);
        let ix = Instruction {
            program_id: &sys_id,
            accounts: &metas,
            data: &ix_data,
        };
        let bump_seed = [registry_bump];
        let signer_seeds = pinocchio::seeds!(b"registry", &bump_seed);
        let signer = Signer::from(&signer_seeds);
        invoke_signed::<2>(&ix, &[governance_account, registry_account], &[signer])?;
        msg!("Registry PDA created");
    }

    // ── Create instrument PDA if needed ──────────────────────────────────────
    if instrument_account.data_len() < INSTRUMENT_SPACE {
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(INSTRUMENT_SPACE);
        let id_le = instrument_id.to_le_bytes();
        let (inst_pda, _) = find_program_address(&[b"instrument", &id_le], program_id);
        let (ix_data, metas) = build_create_account_ix(
            governance_account.key(),
            &inst_pda,
            lamports,
            INSTRUMENT_SPACE,
            program_id,
        );
        let sys_id = Pubkey::from(SYSTEM_PROGRAM_ID_BYTES);
        let ix = Instruction {
            program_id: &sys_id,
            accounts: &metas,
            data: &ix_data,
        };
        let bump_seed = [instrument_bump];
        let signer_seeds = pinocchio::seeds!(b"instrument", id_le.as_slice(), &bump_seed);
        let signer = Signer::from(&signer_seeds);
        invoke_signed::<2>(&ix, &[governance_account, instrument_account], &[signer])?;
        msg!("Instrument PDA created");
    }

    // ── Create vault PDA if needed ──────────────────────────────────────────
    if vault_account.data_len() < VAULT_SPACE {
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(VAULT_SPACE);
        let (vault_pda, _) = find_program_address(&[b"vault"], program_id);
        let (ix_data, metas) = build_create_account_ix(
            governance_account.key(),
            &vault_pda,
            lamports,
            VAULT_SPACE,
            program_id,
        );
        let sys_id = Pubkey::from(SYSTEM_PROGRAM_ID_BYTES);
        let ix = Instruction {
            program_id: &sys_id,
            accounts: &metas,
            data: &ix_data,
        };
        let bump_seed = [vault_bump];
        let signer_seeds = pinocchio::seeds!(b"vault", &bump_seed);
        let signer = Signer::from(&signer_seeds);
        invoke_signed::<2>(&ix, &[governance_account, vault_account], &[signer])?;
        msg!("Vault PDA created");
    }

    // ── Initialize vault state (header + defaults, bump) ────────────────────
    if vault_account.data_len() >= VAULT_SPACE {
        let vault = unsafe { init_account_mut::<Vault>(vault_account)? };
        vault.initialize_in_place(vault_bump);
        msg!("Vault state initialized");
    }

    // ── Initialize Registry state ───────────────────────────────────────────
    // Typed init stamps the account header (discriminator + layout version)
    // and writes every field at its `repr(C)` offset.
    {
        let registry = unsafe { init_account_mut::<Registry>(registry_account)? };
        registry.initialize_in_place(
            *governance,
            instrument_count,
            volatility_multiplier,
            base_deposit,
            n_min,
            t_min_slots,
            t_max_slots,
            t_reveal_slots,
            registry_bump,
        );
    }
    msg!("Registry initialized");

    // ── Initialize default instrument ───────────────────────────────────────
    let mut sym = [0u8; 16];
    sym[..4].copy_from_slice(b"SOLP");
    {
        let instrument = unsafe { init_account_mut::<Instrument>(instrument_account)? };
        instrument.initialize_in_place(
            instrument_id,
            sym,
            1,    // contract_size
            tick_size,
            lot_size,
            imr_bps,
            mmr_bps,
            taker_fee_bps,
            maker_fee_bps,
            10,   // max_leverage
            oracle_addr,
            100,  // funding_interval_slots
            1_000, // mark_reference_qty
            150,  // mark_decay_window_slots
            instrument_bump,
            10_000, // funding_coefficient_bps (D7: 1x)
            0,    // _reserved_deviation_cap
            50,   // max_funding_rate_bps (D7: 50 bps cap)
            0,    // _reserved_sample_qty
            0,    // _reserved_sma_window
        );
    }
    msg!("Default instrument initialized");

    Ok(())
}
