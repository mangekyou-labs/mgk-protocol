use mgk_common::market::MarketContext;
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
    CancelSettledOrders,
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let (context, instruction_data) = mgk_common::market::decode(instruction_data, 10)?;
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
        9 => MatcherInstruction::CancelSettledOrders,
        _ => {
            msg!("Error: Unknown instruction");
            return Err(ProgramError::InvalidInstructionData);
        }
    };

    match instruction {
        MatcherInstruction::CancelResting => {
            msg!("Instruction: CancelResting");
            instructions::process_cancel_resting_in(
                context,
                program_id,
                accounts,
                &instruction_data[1..],
            )
        }
        MatcherInstruction::ModifyResting => {
            msg!("Instruction: ModifyResting");
            instructions::process_modify_resting_in(
                context,
                program_id,
                accounts,
                &instruction_data[1..],
            )
        }

        MatcherInstruction::CancelAll => {
            msg!("Instruction: CancelAll");
            instructions::process_cancel_all_in(
                context,
                program_id,
                accounts,
                &instruction_data[1..],
            )
        }
        MatcherInstruction::DfbaClear => {
            msg!("Instruction: DfbaClear");
            instructions::process_dfba_clear_in(
                context,
                program_id,
                accounts,
                &instruction_data[1..],
            )
        }
        MatcherInstruction::PlaceResting => {
            msg!("Instruction: PlaceResting");
            instructions::process_place_resting_in(
                context,
                program_id,
                accounts,
                &instruction_data[1..],
            )
        }
        MatcherInstruction::ConsumeResults => {
            process_consume_results(context, accounts, &instruction_data[1..])
        }
        MatcherInstruction::CancelSettledOrders => {
            process_cancel_settled_orders(context, program_id, accounts, &instruction_data[1..])
        }
        MatcherInstruction::InitializeBook => {
            msg!("Instruction: InitializeBook");
            instructions::process_initialize_book_in(
                context,
                program_id,
                accounts,
                &instruction_data[1..],
            )
        }
    }
}

/// Authenticate the permissionless settlement CPI and decode its bounded IDs.
fn process_cancel_settled_orders(
    context: MarketContext,
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let authority = accounts.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
    mgk_common::matcher::validate_authority_in(context, authority)?;
    let book = accounts.get(1).ok_or(ProgramError::NotEnoughAccountKeys)?;
    mgk_common::validate_writable(book)?;
    mgk_common::validate_owner(book, program_id)?;
    let count = *data.first().ok_or(ProgramError::InvalidInstructionData)? as usize;
    if count > mgk_common::matcher::MAX_SETTLEMENT_ORDERS || data.len() != 1 + count * 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut order_ids = [0u64; mgk_common::matcher::MAX_SETTLEMENT_ORDERS];
    for (index, id) in order_ids.iter_mut().enumerate().take(count) {
        let start = 1 + index * 8;
        *id = u64::from_le_bytes(data[start..start + 8].try_into().unwrap());
    }
    {
        let raw = book.try_borrow_data()?;
        let header = mgk_common::layout::load::<mgk_common::book::OrderBook>(&raw)?;
        if book.key() != &mgk_common::book::book_pda_in(context, program_id, header.instrument_id).0
        {
            return Err(ProgramError::InvalidSeeds);
        }
    }
    let mut raw = book.try_borrow_mut_data()?;
    let state = crate::state::book_state_from_bytes_mut(&mut raw)?;
    instructions::cancel_settled_orders(state, &order_ids[..count])
}

/// Authenticate and decode the runtime boundary before consuming matcher output.
fn process_consume_results(
    context: MarketContext,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let authority = accounts.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
    mgk_common::matcher::validate_authority_in(context, authority)?;
    let results = accounts.get(1).ok_or(ProgramError::NotEnoughAccountKeys)?;
    if data.len() != 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let batch_id = u64::from_le_bytes(data.try_into().unwrap());
    mgk_common::matcher::validate_results_in(context, results, batch_id)?;
    let mut raw = results.try_borrow_mut_data()?;
    instructions::consume_results(&mut raw, batch_id)
}

#[cfg(test)]
mod settlement_cancel_tests {
    use super::*;

    #[test]
    fn scoped_dispatch_preserves_authority_requirement() {
        let mut wire = [4; 35];
        wire[0] = 10;
        wire[33] = 9;
        wire[34] = 0;
        assert_eq!(
            process_instruction(&mgk_common::program_ids::PERPS_MATCHER_ID, &[], &wire),
            Err(ProgramError::NotEnoughAccountKeys)
        );
    }

    #[test]
    fn malformed_scoped_envelopes_and_retired_instructions_are_rejected() {
        let program = &mgk_common::program_ids::PERPS_MATCHER_ID;
        let mut wire = [4; 34];
        wire[0] = 10;
        for len in 0..34 {
            assert_eq!(
                process_instruction(program, &[], &wire[..len]),
                Err(ProgramError::InvalidInstructionData)
            );
        }
        for inner in [0, 3, 10, 255] {
            wire[33] = inner;
            assert_eq!(
                process_instruction(program, &[], &wire),
                Err(ProgramError::InvalidInstructionData)
            );
        }
        wire[33] = 8;
        assert_eq!(
            process_instruction(program, &[], &wire),
            Err(ProgramError::NotEnoughAccountKeys)
        );
    }

    #[test]
    fn settlement_cannot_cancel_orders_without_the_core_authority() {
        assert_eq!(
            process_instruction(&mgk_common::program_ids::PERPS_MATCHER_ID, &[], &[9, 0]),
            Err(ProgramError::NotEnoughAccountKeys)
        );
    }
}
