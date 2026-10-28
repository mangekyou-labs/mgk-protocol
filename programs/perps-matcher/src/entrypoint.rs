use pinocchio::{
    account_info::AccountInfo, msg, program_error::ProgramError, pubkey::Pubkey, ProgramResult,
};

use crate::instructions;

#[cfg(all(target_os = "solana", not(test)))]
pinocchio::entrypoint!(process_instruction);

enum MatcherInstruction {
    CancelResting,
    ModifyResting,
    CancelAll,
    /// Dual Flow Batch Auction clear (disc 5).
    DfbaClear,
    /// Place a resting order with DFBA role flag (disc 6).
    PlaceResting,
    /// Create book PDA for an instrument (disc 7).
    InitializeBook,
    ConsumeResults,
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.is_empty() {
        msg!("Error: Instruction data is empty");
        return Err(ProgramError::InvalidInstructionData);
    }

    let discriminator = instruction_data[0];
    let instruction = match discriminator {
        0 | 3 => return Err(ProgramError::InvalidInstructionData),
        1 => MatcherInstruction::CancelResting,
        2 => MatcherInstruction::ModifyResting,
        4 => MatcherInstruction::CancelAll,
        5 => MatcherInstruction::DfbaClear,
        6 => MatcherInstruction::PlaceResting,
        7 => MatcherInstruction::InitializeBook,
        8 => MatcherInstruction::ConsumeResults,
        _ => {
            msg!("Error: Unknown instruction");
            return Err(ProgramError::InvalidInstructionData);
        }
    };

    match instruction {
        MatcherInstruction::CancelResting => {
            msg!("Instruction: CancelResting");
            instructions::process_cancel_resting(program_id, accounts, &instruction_data[1..])
        }
        MatcherInstruction::ModifyResting => {
            msg!("Instruction: ModifyResting");
            instructions::process_modify_resting(program_id, accounts, &instruction_data[1..])
        }

        MatcherInstruction::CancelAll => {
            msg!("Instruction: CancelAll");
            instructions::process_cancel_all(program_id, accounts, &instruction_data[1..])
        }
        MatcherInstruction::DfbaClear => {
            msg!("Instruction: DfbaClear");
            instructions::process_dfba_clear(program_id, accounts, &instruction_data[1..])
        }
        MatcherInstruction::PlaceResting => {
            msg!("Instruction: PlaceResting");
            instructions::process_place_resting(program_id, accounts, &instruction_data[1..])
        }
        MatcherInstruction::ConsumeResults => {
            process_consume_results(accounts, &instruction_data[1..])
        }
        MatcherInstruction::InitializeBook => {
            msg!("Instruction: InitializeBook");
            instructions::process_initialize_book(program_id, accounts, &instruction_data[1..])
        }
    }
}

/// Authenticate and decode the runtime boundary before consuming matcher output.
fn process_consume_results(accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let authority = accounts.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
    mgk_common::matcher::validate_authority(authority)?;
    let results = accounts.get(1).ok_or(ProgramError::NotEnoughAccountKeys)?;
    if data.len() != 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let batch_id = u64::from_le_bytes(data.try_into().unwrap());
    mgk_common::matcher::validate_results(results, batch_id)?;
    let mut raw = results.try_borrow_mut_data()?;
    instructions::consume_results(&mut raw, batch_id)
}
