//! Capped collateral movement between portfolios and the vault ledger, plus
//! the vault lamport guard shared by every instruction that touches it.
//!
//! The vault ledger stays backed by real lamports (ADR 0003, issue #23):
//! `vault lamports - rent >= sum(collateral) + fund - uncovered_bad_debt`,
//! and each instruction moves lamports by exactly its ledger delta. Anyone can
//! credit the vault PDA, so surplus is tolerated rather than treated as a
//! mismatch.

use crate::state::portfolio::Portfolio;
use crate::state::vault::{Vault, VaultSnapshot};
use mgk_common::MgkError;
use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke,
    program_error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};

/// System program instruction index for `Transfer`.
const SYSTEM_TRANSFER_DISCRIMINANT: u32 = 2;
/// Wire size of a system `Transfer`: discriminant(4) + lamports(8).
const SYSTEM_TRANSFER_DATA_LEN: usize = 4 + 8;

/// CPI to the system program moving `amount` lamports from the signing
/// `from` account into `to` (the vault).
pub(crate) fn system_transfer(
    from: &AccountInfo,
    to: &AccountInfo,
    system_program: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    let mut data = [0u8; SYSTEM_TRANSFER_DATA_LEN];
    data[0..4].copy_from_slice(&SYSTEM_TRANSFER_DISCRIMINANT.to_le_bytes());
    data[4..SYSTEM_TRANSFER_DATA_LEN].copy_from_slice(&amount.to_le_bytes());
    let transfer = Instruction {
        program_id: system_program.key(),
        accounts: &[
            AccountMeta {
                pubkey: from.key(),
                is_signer: true,
                is_writable: true,
            },
            AccountMeta {
                pubkey: to.key(),
                is_signer: false,
                is_writable: true,
            },
        ],
        data: &data,
    };
    invoke(&transfer, &[from, to, system_program])
}

/// Record the vault's lamports and ledger backing before an instruction moves
/// either. Pair with `verify_vault_flow`.
pub(crate) fn begin_vault_flow(
    vault_account: &AccountInfo,
    vault: &Vault,
) -> Result<VaultSnapshot, ProgramError> {
    Ok(vault.snapshot(vault_account.lamports())?)
}

/// Revert with `VaultInvariantViolated` unless the vault is fully backed and
/// its lamport delta since `before` equals its ledger-backing delta. Call at
/// the end of every instruction that moves vault lamports; call it with no
/// lamport movement after settlement and liquidation, which must keep the
/// backing unchanged.
pub(crate) fn verify_vault_flow(
    vault_account: &AccountInfo,
    vault: &Vault,
    before: &VaultSnapshot,
) -> ProgramResult {
    let rent = Rent::get()?.minimum_balance(vault_account.data_len());
    before
        .check_flow(vault, vault_account.lamports(), rent)
        .map_err(|e| {
            msg!("Error: vault balance invariant violated");
            e.into()
        })
}

fn checked_signed_add(a: i128, b: i128) -> Result<i128, ProgramError> {
    a.checked_add(b).ok_or_else(|| MgkError::Overflow.into())
}

/// Apply one realized PnL and fee to a portfolio and the vault ledger. No
/// lamports move: collateral and fund are both vault lamports.
///
/// A gain is credited in full from the insurance fund; whatever the fund
/// cannot cover becomes uncovered bad debt. A loss or fee collects only what
/// the portfolio holds, so an uncollected remainder moves nothing and the
/// ledger backing stays constant. Returns the unpaid payout (the part of a
/// gain the fund could not cover) so the caller can pause trading and
/// withdrawals.
pub(crate) fn apply_realized_pnl_and_fee(
    p: &mut Portfolio,
    vault: &mut Vault,
    realized: i128,
    fee: i128,
) -> Result<u128, ProgramError> {
    let mut unpaid_payout = 0u128;
    if realized >= 0 {
        let gain = realized as u128;
        let balance = vault
            .balance
            .checked_add(u64::try_from(gain).map_err(|_| MgkError::Overflow)?)
            .ok_or(MgkError::Overflow)?;
        let equity = checked_signed_add(p.equity, realized)?;
        let realized_lamports = checked_signed_add(p.realized_lamports, realized)?;
        unpaid_payout = vault.outflow(gain)?;
        vault.balance = balance;
        p.equity = equity;
        p.realized_lamports = realized_lamports;
    } else {
        let collected = collect_into_fund(p, vault, realized.unsigned_abs())?;
        p.realized_lamports = checked_signed_add(p.realized_lamports, -(collected as i128))?;
    }
    let collected = collect_into_fund(p, vault, u128::try_from(fee).map_err(|_| MgkError::Overflow)?)?;
    p.fees_paid = checked_signed_add(p.fees_paid, collected as i128)?;
    Ok(unpaid_payout)
}

/// Move up to `owed` lamports of the portfolio's collateral into the fund
/// (repaying uncovered bad debt first). Returns the amount actually moved.
pub(crate) fn collect_into_fund(
    p: &mut Portfolio,
    vault: &mut Vault,
    owed: u128,
) -> Result<u128, ProgramError> {
    let available = u128::try_from(p.equity.max(0)).map_err(|_| MgkError::Overflow)?;
    let collected = owed.min(available);
    if collected == 0 {
        return Ok(0);
    }
    let balance = vault
        .balance
        .checked_sub(u64::try_from(collected).map_err(|_| MgkError::Overflow)?)
        .ok_or(MgkError::Underflow)?;
    vault.inflow(collected)?;
    vault.balance = balance;
    p.equity = checked_signed_add(p.equity, -(collected as i128))?;
    Ok(collected)
}
