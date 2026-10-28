mod transition;

use crate::state::batch::{Batch, BatchStatus, Commitment};
use crate::state::instrument::Instrument;
use crate::state::portfolio::Portfolio;
use crate::state::registry::Registry;
use crate::state::vault::Vault;
use mgk_common::layout::{load_account, load_account_mut, AccountLayout};
use mgk_common::MgkError;
use pinocchio::{
    account_info::AccountInfo,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

/// The adapter repeats the shared validity gate before returning a conversion
/// price. Invalid prices never reach the business transition.
fn read_oracle_price(
    oracle_account: &AccountInfo,
    instrument_account: &AccountInfo,
    expected_oracle_addr: &Pubkey,
) -> Option<(i64, i64, bool)> {
    let now = Clock::get().ok()?.unix_timestamp;
    let price = mgk_common::oracle::read_price(
        oracle_account,
        expected_oracle_addr,
        instrument_account.key(),
        now,
    )
    .ok()?;
    Some((price, now, true))
}

#[allow(clippy::too_many_arguments)]
pub fn process_settle_batch(
    program_id: &Pubkey,
    batch_account: &AccountInfo,
    registry_account: &AccountInfo,
    vault_account: &AccountInfo,
    results_account: &AccountInfo,
    instrument_account: &AccountInfo,
    book_account: &AccountInfo,
    oracle_account: &AccountInfo,
    matcher_program: &AccountInfo,
    commitment_accounts: &[AccountInfo],
    portfolio_accounts: &[AccountInfo],
    next_batch_account: &AccountInfo,
) -> ProgramResult {
    crate::matcher_cpi::validate_registry(registry_account)?;
    crate::matcher_cpi::validate_program(matcher_program)?;
    let batch = unsafe { load_account_mut::<Batch>(batch_account)? };
    if batch.status != BatchStatus::Cleared {
        msg!("Error: Batch not in clearing phase");
        return Err(MgkError::InvalidInstruction.into());
    }
    crate::matcher_cpi::validate_batch(program_id, batch_account, batch.batch_id)?;
    mgk_common::matcher::validate_results(results_account, batch.batch_id)?;
    let instrument = unsafe { load_account_mut::<Instrument>(instrument_account)? };
    crate::matcher_cpi::validate_book(
        matcher_program,
        book_account,
        Some(instrument.instrument_id),
    )?;
    if instrument_account.key()
        != &crate::pda::derive_instrument_pda(instrument.instrument_id, program_id).0
    {
        return Err(ProgramError::InvalidSeeds);
    }
    if next_batch_account.key()
        != &crate::pda::derive_batch_pda(
            batch.batch_id.checked_add(1).ok_or(MgkError::Overflow)?,
            program_id,
        )
        .0
    {
        return Err(ProgramError::InvalidSeeds);
    }
    for account in portfolio_accounts {
        mgk_common::validate_owner(account, program_id)?;
        mgk_common::validate_writable(account)?;
        let portfolio = unsafe { load_account::<Portfolio>(account)? };
        if account.key() != &crate::pda::derive_portfolio_pda(&portfolio.user, program_id).0 {
            return Err(ProgramError::InvalidSeeds);
        }
    }
    // Fail closed before any fill, fee, mark, or batch write, including when
    // funding is paused or the batch has no fills.
    mgk_common::oracle::read_price(
        oracle_account,
        &instrument.oracle_addr,
        instrument_account.key(),
        Clock::get()?.unix_timestamp,
    )?;
    let results_raw = results_account
        .try_borrow_data()
        .map_err(|_| MgkError::InvalidAccount)?;
    let batch_id = batch.batch_id;
    let results = mgk_common::matcher::unspent_results(&results_raw, batch_id)?;
    transition::settle(
        batch,
        instrument,
        results,
        &mut RuntimeStates::<Commitment>::new(commitment_accounts),
        &mut RuntimeStates::<Portfolio>::new(portfolio_accounts),
        &mut RuntimeEnvironment {
            registry_account,
            vault_account,
            instrument_account,
            book_account,
            oracle_account,
            matcher_program,
            next_batch_account,
        },
    )?;
    drop(results_raw);
    let mut data = [8u8; 9];
    data[1..].copy_from_slice(&batch_id.to_le_bytes());
    let metas = [
        pinocchio::instruction::AccountMeta::readonly_signer(registry_account.key()),
        pinocchio::instruction::AccountMeta::writable(results_account.key()),
    ];
    crate::matcher_cpi::signed(
        registry_account,
        matcher_program,
        &metas,
        &[registry_account, results_account],
        &data,
    )?;
    unsafe { load_account_mut::<Registry>(registry_account)? }.set_unsettled_batch(false);
    Ok(())
}

/// Account casts stay at the runtime boundary. Entrypoint validation and the
/// existing unchecked borrow policy are unchanged by this refactor.
struct RuntimeStates<'a, T> {
    accounts: &'a [AccountInfo],
    marker: core::marker::PhantomData<T>,
}
impl<'a, T> RuntimeStates<'a, T> {
    fn new(accounts: &'a [AccountInfo]) -> Self {
        Self {
            accounts,
            marker: core::marker::PhantomData,
        }
    }
}
impl<T: AccountLayout> transition::States<T> for RuntimeStates<'_, T> {
    fn len(&self) -> usize {
        self.accounts.len()
    }
    fn get_mut(&mut self, index: usize) -> Result<&mut T, ProgramError> {
        let account = self
            .accounts
            .get(index)
            .ok_or(ProgramError::NotEnoughAccountKeys)?;
        Ok(unsafe { load_account_mut::<T>(account)? })
    }
}

struct RuntimeEnvironment<'a> {
    registry_account: &'a AccountInfo,
    vault_account: &'a AccountInfo,
    instrument_account: &'a AccountInfo,
    book_account: &'a AccountInfo,
    oracle_account: &'a AccountInfo,
    matcher_program: &'a AccountInfo,
    next_batch_account: &'a AccountInfo,
}
impl transition::Environment for RuntimeEnvironment<'_> {
    fn registry(&self) -> Result<Registry, ProgramError> {
        Ok(unsafe { *load_account::<Registry>(self.registry_account)? })
    }
    fn vault(&mut self) -> Result<&mut Vault, ProgramError> {
        Ok(unsafe { load_account_mut::<Vault>(self.vault_account)? })
    }
    fn validate_book(&self, instrument_id: u16) -> ProgramResult {
        crate::matcher_cpi::validate_book(
            self.matcher_program,
            self.book_account,
            Some(instrument_id),
        )?;

        Ok(())
    }
    fn clock(&self) -> Result<Clock, ProgramError> {
        Clock::get()
    }
    fn oracle(&self, expected_addr: &Pubkey) -> Option<(i64, i64, bool)> {
        read_oracle_price(self.oracle_account, self.instrument_account, expected_addr)
    }
    fn set_batch_counter(&mut self, value: u64) -> ProgramResult {
        // Header check first, then raw byte writes (SBF packed-field workaround).
        unsafe { load_account::<Registry>(self.registry_account)? };
        let data = unsafe { self.registry_account.borrow_mut_data_unchecked() };
        Registry::write_batch_id_counter(data, value);
        Ok(())
    }
    fn next_batch_size(&self) -> usize {
        self.next_batch_account.data_len()
    }
    /// Unchecked on purpose: the next batch is a zeroed account that
    /// `initialize_in_place` stamps; `settle` rejects an already-stamped one.
    fn next_batch(&mut self) -> &mut Batch {
        unsafe {
            &mut *(self
                .next_batch_account
                .borrow_mut_data_unchecked()
                .as_mut_ptr() as *mut Batch)
        }
    }
}
