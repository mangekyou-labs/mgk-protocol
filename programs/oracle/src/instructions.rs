//! Oracle instruction handlers

use crate::state::{PriceOracle, PRICE_ORACLE_SIZE};
use mgk_common::{
    layout::{discriminator, init_mut, load_mut},
    MgkError,
};
use pinocchio::{
    account_info::AccountInfo,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

/// Initialize a new price oracle
///
/// Accounts:
/// 0. `[writable]` Oracle account (PDA)
/// 1. `[signer]` Authority
/// 2. `[]` Instrument account
///
/// Instruction data:
/// - initial_price: i64 (8 bytes)
/// - bump: u8 (1 byte)
pub fn process_initialize(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 3 {
        msg!("Error: Initialize requires 3 accounts");
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    if data.len() < 9 {
        msg!("Error: Initialize requires 9 bytes of data");
        return Err(ProgramError::InvalidInstructionData);
    }

    let oracle_account = &accounts[0];
    let authority_account = &accounts[1];
    let instrument_account = &accounts[2];

    if !authority_account.is_signer() {
        msg!("Error: Authority must be signer");
        return Err(ProgramError::MissingRequiredSignature);
    }

    if !oracle_account.is_writable() {
        msg!("Error: Oracle account must be writable");
        return Err(ProgramError::InvalidAccountData);
    }

    // Parse instruction data
    let initial_price = i64::from_le_bytes([
        data[0], data[1], data[2], data[3], data[4], data[5], data[6], data[7],
    ]);
    let bump = data[8];

    // Initialize oracle
    let mut oracle_data = oracle_account.try_borrow_mut_data()?;
    if oracle_data.len() < PRICE_ORACLE_SIZE {
        msg!("Error: Oracle account too small");
        return Err(ProgramError::AccountDataTooSmall);
    }

    // Only a never-initialised (zeroed) account may be initialised. Without
    // this, any signer could re-run Initialize on a live oracle and take over
    // its authority.
    if oracle_data[0] != discriminator::UNINITIALIZED {
        msg!("Error: Oracle account already initialized");
        return Err(MgkError::AlreadyInitialized.into());
    }

    // Stamps the PRICE_ORACLE discriminator and layout version, then the
    // whole struct (header included) is written.
    let oracle = init_mut::<PriceOracle>(&mut oracle_data).map_err(ProgramError::from)?;
    *oracle = PriceOracle::new(
        *authority_account.key(),
        *instrument_account.key(),
        initial_price,
        bump,
    );

    msg!("Oracle initialized");
    Ok(())
}

/// Update oracle price
///
/// Accounts:
/// 0. `[writable]` Oracle account
/// 1. `[signer]` Authority
/// 2. `[]` Clock sysvar
///
/// Instruction data:
/// - price: i64 (8 bytes)
/// - confidence: i64 (8 bytes)
pub fn process_update_price(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 2 {
        msg!("Error: UpdatePrice requires 2 accounts");
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    if data.len() < 16 {
        msg!("Error: UpdatePrice requires 16 bytes of data");
        return Err(ProgramError::InvalidInstructionData);
    }

    let oracle_account = &accounts[0];
    let authority_account = &accounts[1];

    if !authority_account.is_signer() {
        msg!("Error: Authority must be signer");
        return Err(ProgramError::MissingRequiredSignature);
    }

    if !oracle_account.is_writable() {
        msg!("Error: Oracle account must be writable");
        return Err(ProgramError::InvalidAccountData);
    }

    // Parse instruction data
    let price = i64::from_le_bytes([
        data[0], data[1], data[2], data[3], data[4], data[5], data[6], data[7],
    ]);
    let confidence = i64::from_le_bytes([
        data[8], data[9], data[10], data[11], data[12], data[13], data[14], data[15],
    ]);

    // Get current timestamp
    let clock = Clock::get()?;
    let timestamp = clock.unix_timestamp;

    // Update oracle
    let mut oracle_data = oracle_account.try_borrow_mut_data()?;
    let oracle = load_mut::<PriceOracle>(&mut oracle_data).map_err(|e| {
        msg!("Error: Invalid oracle account (header)");
        ProgramError::from(e)
    })?;

    if oracle.authority != *authority_account.key() {
        msg!("Error: Invalid authority");
        return Err(ProgramError::InvalidAccountData);
    }

    oracle.update_price(price, timestamp, confidence);

    msg!("Price updated");
    Ok(())
}

/// Set the authority of an oracle
///
/// Accounts:
/// 0. `[writable]` Oracle account
/// 1. `[signer]` Authority (current authority)
///
/// Instruction data:
/// - new_authority: Pubkey (32 bytes)
pub fn process_set_authority(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 2 {
        msg!("Error: SetAuthority requires 2 accounts");
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    if data.len() < 32 {
        msg!("Error: SetAuthority requires 32 bytes of data");
        return Err(ProgramError::InvalidInstructionData);
    }

    let oracle_account = &accounts[0];
    let authority_account = &accounts[1];

    if !authority_account.is_signer() {
        msg!("Error: Authority must be signer");
        return Err(ProgramError::MissingRequiredSignature);
    }

    if !oracle_account.is_writable() {
        msg!("Error: Oracle account must be writable");
        return Err(ProgramError::InvalidAccountData);
    }

    let new_authority_bytes: [u8; 32] = data[0..32]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let new_authority = Pubkey::from(new_authority_bytes);

    let mut oracle_data = oracle_account.try_borrow_mut_data()?;
    let oracle = load_mut::<PriceOracle>(&mut oracle_data).map_err(|e| {
        msg!("Error: Invalid oracle account (header)");
        ProgramError::from(e)
    })?;

    if oracle.authority != *authority_account.key() {
        msg!("Error: Invalid authority");
        return Err(ProgramError::InvalidAccountData);
    }

    oracle.set_authority(new_authority);

    msg!("Authority updated");
    Ok(())
}

/// Activate the oracle (enable price reads)
///
/// Accounts:
/// 0. `[writable]` Oracle account
/// 1. `[signer]` Authority
pub fn process_activate(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    if accounts.len() < 2 {
        msg!("Error: Activate requires 2 accounts");
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let oracle_account = &accounts[0];
    let authority_account = &accounts[1];

    if !authority_account.is_signer() {
        msg!("Error: Authority must be signer");
        return Err(ProgramError::MissingRequiredSignature);
    }

    if !oracle_account.is_writable() {
        msg!("Error: Oracle account must be writable");
        return Err(ProgramError::InvalidAccountData);
    }

    let mut oracle_data = oracle_account.try_borrow_mut_data()?;
    let oracle = load_mut::<PriceOracle>(&mut oracle_data).map_err(|e| {
        msg!("Error: Invalid oracle account (header)");
        ProgramError::from(e)
    })?;

    if oracle.authority != *authority_account.key() {
        msg!("Error: Invalid authority");
        return Err(ProgramError::InvalidAccountData);
    }

    oracle.activate();

    msg!("Oracle activated");
    Ok(())
}

/// Deactivate the oracle (disable price reads)
///
/// Accounts:
/// 0. `[writable]` Oracle account
/// 1. `[signer]` Authority
pub fn process_deactivate(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    if accounts.len() < 2 {
        msg!("Error: Deactivate requires 2 accounts");
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let oracle_account = &accounts[0];
    let authority_account = &accounts[1];

    if !authority_account.is_signer() {
        msg!("Error: Authority must be signer");
        return Err(ProgramError::MissingRequiredSignature);
    }

    if !oracle_account.is_writable() {
        msg!("Error: Oracle account must be writable");
        return Err(ProgramError::InvalidAccountData);
    }

    let mut oracle_data = oracle_account.try_borrow_mut_data()?;
    let oracle = load_mut::<PriceOracle>(&mut oracle_data).map_err(|e| {
        msg!("Error: Invalid oracle account (header)");
        ProgramError::from(e)
    })?;

    if oracle.authority != *authority_account.key() {
        msg!("Error: Invalid authority");
        return Err(ProgramError::InvalidAccountData);
    }

    oracle.deactivate();

    msg!("Oracle deactivated");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mgk_common::{layout::load, MgkError};

    /// Size of pinocchio's private `Account` runtime header that precedes
    /// account data in the input buffer.
    const RAW_HEADER: usize = 88;

    /// A runtime-shaped account buffer: `Account` header followed by data.
    struct FakeAccount {
        buf: std::vec::Vec<u64>,
    }

    impl FakeAccount {
        fn new(key: [u8; 32], is_signer: bool, is_writable: bool, data_len: usize) -> Self {
            let words = (RAW_HEADER + data_len).div_ceil(8);
            let mut buf = std::vec![0u64; words];
            let bytes = unsafe {
                core::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut u8, words * 8)
            };
            bytes[0] = 0xFF; // borrow_state: nothing borrowed
            bytes[1] = is_signer as u8;
            bytes[2] = is_writable as u8;
            bytes[8..40].copy_from_slice(&key);
            bytes[80..88].copy_from_slice(&(data_len as u64).to_le_bytes());
            Self { buf }
        }

        fn info(&mut self) -> AccountInfo {
            // `AccountInfo` is `repr(C) { raw: *mut Account }`.
            unsafe { core::mem::transmute::<*mut u8, AccountInfo>(self.buf.as_mut_ptr() as *mut u8) }
        }
    }

    fn init_data(price: i64, bump: u8) -> [u8; 9] {
        let mut d = [0u8; 9];
        d[..8].copy_from_slice(&price.to_le_bytes());
        d[8] = bump;
        d
    }

    #[test]
    fn initialize_stamps_a_fresh_oracle() {
        let mut oracle = FakeAccount::new([1; 32], false, true, PRICE_ORACLE_SIZE);
        let mut auth = FakeAccount::new([2; 32], true, false, 0);
        let mut instr = FakeAccount::new([3; 32], false, false, 0);
        let accounts = [oracle.info(), auth.info(), instr.info()];

        process_initialize(&[0; 32], &accounts, &init_data(100, 7)).unwrap();

        let data = accounts[0].try_borrow_data().unwrap();
        let o = load::<PriceOracle>(&data).unwrap();
        assert_eq!(o.authority, [2; 32]);
        assert_eq!(o.price, 100);
    }

    #[test]
    fn initialize_rejects_an_already_initialized_oracle_and_keeps_its_authority() {
        let mut oracle = FakeAccount::new([1; 32], false, true, PRICE_ORACLE_SIZE);
        let mut owner = FakeAccount::new([2; 32], true, false, 0);
        let mut attacker = FakeAccount::new([9; 32], true, false, 0);
        let mut instr = FakeAccount::new([3; 32], false, false, 0);
        let oracle_info = oracle.info();

        process_initialize(
            &[0; 32],
            &[oracle_info, owner.info(), instr.info()],
            &init_data(100, 7),
        )
        .unwrap();

        let err = process_initialize(
            &[0; 32],
            &[oracle_info, attacker.info(), instr.info()],
            &init_data(1, 8),
        )
        .unwrap_err();
        assert_eq!(err, ProgramError::from(MgkError::AlreadyInitialized));

        let data = oracle_info.try_borrow_data().unwrap();
        let o = load::<PriceOracle>(&data).unwrap();
        assert_eq!(o.authority, [2; 32], "authority must not change");
        assert_eq!(o.price, 100);
    }
}
