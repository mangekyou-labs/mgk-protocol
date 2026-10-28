mod transition;

use crate::state::batch::{Batch, BatchStatus, Commitment};
use crate::state::instrument::Instrument;
use crate::state::portfolio::Portfolio;
use crate::state::registry::Registry;
use crate::state::vault::Vault;
use mgk_common::book::OrderBook;
use mgk_common::layout::{
    self, discriminator, load_account, load_account_mut, AccountLayout, LAYOUT_VERSION_1,
};
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
    _program_id: &Pubkey,
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
    let batch = unsafe { load_account_mut::<Batch>(batch_account)? };
    if batch.status != BatchStatus::Clearing {
        msg!("Error: Batch not in clearing phase");
        return Err(MgkError::InvalidInstruction.into());
    }
    let instrument = unsafe { load_account_mut::<Instrument>(instrument_account)? };
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
    let results = layout::body(&results_raw, discriminator::BATCH_RESULTS, LAYOUT_VERSION_1)?;
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
    )
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
        // Book ownership check (still required for funding premium path).
        let (expected_book_pda, _book_bump) =
            mgk_common::book::book_pda(self.matcher_program.key(), instrument_id);
        if self.book_account.key() != &expected_book_pda
            && self.book_account.owner() != self.matcher_program.key()
        {
            msg!("Error: book_account is neither expected PDA nor matcher-owned");
            return Err(MgkError::InvalidAccount.into());
        }

        let book = unsafe { load_account::<OrderBook>(self.book_account)? };
        if book.instrument_id != instrument_id {
            msg!("Error: book instrument_id does not match instrument");
            return Err(MgkError::InvalidAccount.into());
        }

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
