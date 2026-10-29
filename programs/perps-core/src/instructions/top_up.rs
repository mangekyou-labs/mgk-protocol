//! TopUp (disc 26): permissionless transfer of real lamports into the fund.

use crate::state::Vault;
use mgk_common::MgkError;
use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke,
    ProgramResult,
};

/// Pure ledger rule: a top-up repays uncovered bad debt first, then grows the fund.
pub(crate) fn apply_top_up(vault: &mut Vault, amount: u64) -> Result<(), MgkError> {
    if amount == 0 {
        return Err(MgkError::InvalidAmount);
    }
    vault.inflow(amount as u128)
}

/// Transfer `amount` lamports from `payer` into the vault and credit the fund.
///
/// Accounts:
/// 0. [signer, writable] Payer (anyone)
/// 1. [writable] Vault PDA
/// 2. [] System program
///
/// Data: amount(8)
pub fn process_top_up(
    payer_account: &AccountInfo,
    vault_account: &AccountInfo,
    vault: &mut Vault,
    system_program: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    if !payer_account.is_signer() {
        msg!("Error: Payer must be a signer");
        return Err(MgkError::Unauthorized.into());
    }
    if system_program.key() != &[0u8; 32] {
        msg!("Error: Invalid system program");
        return Err(MgkError::InvalidInstruction.into());
    }
    let flow = crate::collateral_flow::begin_vault_flow(vault_account, vault)?;
    apply_top_up(vault, amount)?;

    let mut instruction_data = [0u8; 12];
    instruction_data[0..4].copy_from_slice(&2u32.to_le_bytes());
    instruction_data[4..12].copy_from_slice(&amount.to_le_bytes());
    let transfer = Instruction {
        program_id: system_program.key(),
        accounts: &[
            AccountMeta {
                pubkey: payer_account.key(),
                is_signer: true,
                is_writable: true,
            },
            AccountMeta {
                pubkey: vault_account.key(),
                is_signer: false,
                is_writable: true,
            },
        ],
        data: &instruction_data,
    };
    invoke(&transfer, &[payer_account, vault_account, system_program])?;

    crate::collateral_flow::verify_vault_flow(vault_account, vault, &flow)?;
    msg!("TopUp successful");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn top_up_grows_the_fund_and_leaves_collateral_alone() {
        let mut v = Vault::new();
        v.balance = 500;
        apply_top_up(&mut v, 1_000).unwrap();
        assert_eq!((v.insurance_fund, v.balance, v.uncovered_bad_debt), (1_000, 500, 0));
    }

    #[test]
    fn top_up_repays_debt_before_the_fund() {
        let mut v = Vault::new();
        v.uncovered_bad_debt = 700;
        apply_top_up(&mut v, 500).unwrap();
        assert_eq!((v.insurance_fund, v.uncovered_bad_debt), (0, 200));
        apply_top_up(&mut v, 500).unwrap();
        assert_eq!((v.insurance_fund, v.uncovered_bad_debt), (300, 0));
    }

    #[test]
    fn zero_top_up_is_refused() {
        let mut v = Vault::new();
        assert_eq!(apply_top_up(&mut v, 0), Err(MgkError::InvalidAmount));
    }
}
