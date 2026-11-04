use pinocchio::pubkey::{find_program_address, Pubkey};

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

use mgk_common::market::MarketContext;
use pinocchio::{account_info::AccountInfo, program_error::ProgramError, ProgramResult};

pub fn derive_registry_pda_in(context: MarketContext, program_id: &Pubkey) -> (Pubkey, u8) {
    context.registry_pda(program_id)
}
pub fn derive_portfolio_pda_in(
    context: MarketContext,
    user: &Pubkey,
    program_id: &Pubkey,
) -> (Pubkey, u8) {
    context.child_pda(PORTFOLIO_SEED, &[user], program_id)
}
pub fn derive_instrument_pda_in(
    context: MarketContext,
    id: u16,
    program_id: &Pubkey,
) -> (Pubkey, u8) {
    context.child_pda(INSTRUMENT_SEED, &[&id.to_le_bytes()], program_id)
}
pub fn derive_vault_pda_in(context: MarketContext, program_id: &Pubkey) -> (Pubkey, u8) {
    context.child_pda(VAULT_SEED, &[], program_id)
}
pub fn derive_batch_pda_in(context: MarketContext, id: u64, program_id: &Pubkey) -> (Pubkey, u8) {
    context.child_pda(BATCH_SEED, &[&id.to_le_bytes()], program_id)
}

/// Authenticate all stamped core state before dispatch can borrow it mutably.
/// Account layouts remain unchanged: canonical addresses bind their market.
pub fn validate_context_accounts(
    context: MarketContext,
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    validate_instruction_roles(program_id, accounts, instruction_data)?;
    use crate::state::{Registry, Vault, Instrument, Portfolio, Batch};
    use mgk_common::layout::{discriminator as d, load_account};
    for account in accounts {
        if account.owner() != program_id {
            continue;
        }
        let discriminator = account.try_borrow_data()?.first().copied().unwrap_or(0);
        let expected = match discriminator {
            0 => continue,
            d::REGISTRY => {
                unsafe {
                    load_account::<Registry>(account)?;
                }
                derive_registry_pda_in(context, program_id).0
            }
            d::VAULT => {
                unsafe {
                    load_account::<Vault>(account)?;
                }
                derive_vault_pda_in(context, program_id).0
            }
            d::INSTRUMENT => {
                derive_instrument_pda_in(
                    context,
                    unsafe { load_account::<Instrument>(account)? }.instrument_id,
                    program_id,
                )
                .0
            }
            d::PORTFOLIO => {
                derive_portfolio_pda_in(
                    context,
                    &unsafe { load_account::<Portfolio>(account)? }.user,
                    program_id,
                )
                .0
            }
            d::BATCH => {
                derive_batch_pda_in(
                    context,
                    unsafe { load_account::<Batch>(account)? }.batch_id,
                    program_id,
                )
                .0
            }
            _ => return Err(ProgramError::InvalidAccountData),
        };
        if account.key() != &expected {
            return Err(ProgramError::InvalidSeeds);
        }
    }
    Ok(())
}

/// Validate the layout required by each instruction account position before
/// interpreting account-provided discriminators for canonical address checks.
/// This preserves typed layout errors for substituted or malformed state.
fn validate_instruction_roles(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    use crate::state::{Batch, Instrument, Portfolio, Registry, Vault};
    use mgk_common::layout::{self, AccountLayout};

    fn typed<T: AccountLayout>(
        accounts: &[AccountInfo],
        index: usize,
        owner: &Pubkey,
        creation: bool,
    ) -> ProgramResult {
        let Some(account) = accounts.get(index) else {
            return Ok(());
        };
        let raw = account.try_borrow_data()?;
        // Creation accepts only genuinely blank targets; populated accounts
        // must identify the expected type even when the handler rejects reinit.
        if creation && raw.iter().all(|byte| *byte == 0) {
            return Ok(());
        }
        mgk_common::validate_owner(account, owner)?;
        layout::load::<T>(&raw)?;
        Ok(())
    }
    fn results(accounts: &[AccountInfo], index: usize, creation: bool) -> ProgramResult {
        let Some(account) = accounts.get(index) else {
            return Ok(());
        };
        let raw = account.try_borrow_data()?;
        if creation && raw.iter().all(|byte| *byte == 0) {
            return Ok(());
        }
        mgk_common::validate_owner(account, &mgk_common::program_ids::PERPS_MATCHER_ID)?;
        layout::check_header(
            &raw,
            layout::discriminator::BATCH_RESULTS,
            layout::LAYOUT_VERSION_1,
        )?;
        Ok(())
    }
    fn count(data: &[u8], start: usize) -> Option<usize> {
        let bytes: [u8; 2] = data.get(start..start + 2)?.try_into().ok()?;
        Some(u16::from_le_bytes(bytes) as usize)
    }
    let Some((&instruction, data)) = instruction_data.split_first() else {
        return Ok(());
    };
    let registry = |index| typed::<Registry>(accounts, index, program_id, false);
    let vault = |index| typed::<Vault>(accounts, index, program_id, false);
    let portfolio = |index| typed::<Portfolio>(accounts, index, program_id, false);
    let instrument = |index| typed::<Instrument>(accounts, index, program_id, false);
    let batch = |index| typed::<Batch>(accounts, index, program_id, false);
    let book = |index, creation| {
        typed::<mgk_common::book::OrderBook>(
            accounts,
            index,
            &mgk_common::program_ids::PERPS_MATCHER_ID,
            creation,
        )
    };
    match instruction {
        0 => {
            typed::<Registry>(accounts, 0, program_id, true)?;
            typed::<Instrument>(accounts, 2, program_id, true)?;
            typed::<Vault>(accounts, 4, program_id, true)?;
        }
        1 | 18 => typed::<Portfolio>(accounts, 0, program_id, true)?,
        2 => {
            portfolio(0)?;
            vault(3)?;
        }
        3 => {
            portfolio(0)?;
            vault(2)?;
            registry(3)?;
            instrument(4)?;
        }
        6 => {
            batch(0)?;
            registry(1)?;
        }
        7 => {
            batch(0)?;
            book(1, false)?;
            results(accounts, 2, true)?;
            registry(4)?;
            if let (Some(commitments), Some(instruments), Some(portfolios)) =
                (count(data, 0), count(data, 2), count(data, 4))
            {
                for index in 5..accounts.len().min(5 + instruments) {
                    instrument(index)?;
                }
                let start = 5 + instruments + commitments;
                for index in start..accounts.len().min(start + portfolios) {
                    portfolio(index)?;
                }
            }
        }
        8 => {
            batch(0)?;
            registry(1)?;
            vault(2)?;
            results(accounts, 3, false)?;
            instrument(4)?;
            book(5, false)?;
            if let (Some(commitments), Some(portfolios)) = (count(data, 0), count(data, 2)) {
                let start = 8 + commitments;
                for index in start..accounts.len().min(start + portfolios) {
                    portfolio(index)?;
                }
                typed::<Batch>(accounts, start + portfolios, program_id, true)?;
            }
        }
        9 => {
            portfolio(0)?;
            registry(1)?;
            vault(2)?;
            portfolio(4)?;
            instrument(5)?;
            book(7, false)?;
        }
        10 => {
            registry(0)?;
            typed::<Instrument>(accounts, 2, program_id, true)?;
        }
        11 => {
            portfolio(0)?;
            book(2, false)?;
            registry(4)?;
        }
        12 => {
            portfolio(0)?;
            book(2, false)?;
            registry(4)?;
            instrument(5)?;
            vault(7)?;
        }
        13 => {
            portfolio(0)?;
            if let Some(books) = count(data, 0) {
                for index in 3..accounts.len().min(3 + books) {
                    book(index, false)?;
                }
                registry(3 + books)?;
            }
        }
        14 | 17 | 21 => registry(0)?,
        15 => typed::<Vault>(accounts, 0, program_id, true)?,
        16 => {
            typed::<Batch>(accounts, 0, program_id, true)?;
            registry(1)?;
        }
        19 => typed::<Portfolio>(accounts, 1, program_id, true)?,
        20 => {
            portfolio(0)?;
            batch(2)?;
            registry(3)?;
            book(4, false)?;
            instrument(6)?;
            vault(8)?;
        }
        22..=24 => {
            instrument(0)?;
            registry(1)?;
        }
        25 => {
            registry(0)?;
            book(1, true)?;
        }
        26 => vault(1)?,
        27 => {
            vault(0)?;
            registry(1)?;
        }
        28 => {
            registry(0)?;
            vault(1)?;
        }
        // Retired and unknown instructions remain rejected by dispatch.
        _ => {}
    }
    Ok(())
}

/// Materialize signer seeds in a fixed-size array, keeping all storage local.
/// Scoped children include the authenticated registry; registry uses market seed.
pub fn signer_seeds<'a>(
    context: &'a MarketContext,
    tag: &'a [u8],
    registry: &'a Pubkey,
    extra: &'a [&'a [u8]],
    bump: &'a [u8],
    storage: &mut [pinocchio::instruction::Seed<'a>; 8],
) -> usize {
    let mut count = 0;
    storage[count] = tag.into();
    count += 1;
    if let MarketContext::Scoped { market_seed } = context {
        storage[count] = if tag == REGISTRY_SEED {
            market_seed.as_slice().into()
        } else {
            registry.as_slice().into()
        };
        count += 1;
    }
    for seed in extra {
        storage[count] = (*seed).into();
        count += 1;
    }
    storage[count] = bump.into();
    count + 1
}

pub fn invoke_pda<const N: usize>(
    context: MarketContext,
    tag: &[u8],
    extra: &[&[u8]],
    program_id: &Pubkey,
    ix: &pinocchio::instruction::Instruction,
    infos: &[&AccountInfo; N],
) -> ProgramResult {
    let registry = context.registry_pda(program_id).0;
    let bump = [if tag == REGISTRY_SEED {
        context.registry_pda(program_id).1
    } else {
        context.child_pda(tag, extra, program_id).1
    }];
    let mut storage = core::array::from_fn(|_| pinocchio::instruction::Seed::from(&[][..]));
    let count = signer_seeds(&context, tag, &registry, extra, &bump, &mut storage);
    let signer = pinocchio::instruction::Signer::from(&storage[..count]);
    pinocchio::program::invoke_signed::<N>(ix, infos, &[signer])
}

pub fn require_uninitialized(account: &AccountInfo) -> ProgramResult {
    if account.try_borrow_data()?.iter().any(|byte| *byte != 0) {
        return Err(mgk_common::MgkError::AlreadyInitialized.into());
    }
    Ok(())
}

pub fn validate_current_batch(
    batch: &crate::state::Batch,
    registry: &crate::state::Registry,
) -> ProgramResult {
    if batch.batch_id.checked_add(1) != Some(registry.batch_id_counter) {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}
