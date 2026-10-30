//! Independent instruction vectors. Every copied parser statement is checked against the
//! actual Rust handler before it is executed here. A changed read, type, optional default,
//! length guard, or dispatch fails check-layouts instead of silently changing the wire table.
//! Regenerate with cargo run -p mgk-perps-core --example export_instruction_fixtures.
use mgk_perps_matcher::state::order::Side;
use pinocchio::{program_error::ProgramError, pubkey::Pubkey};
use serde_json::{json, Value};

fn compact(text: &str) -> String {
    text.split_whitespace().collect()
}
fn check(source: &str, expected: &str) {
    assert!(
        compact(source).contains(&compact(expected)),
        "Program parser drift: {expected}"
    );
}
fn handler<'a>(source: &'a str, name: &str) -> &'a str {
    let start = source.find(&format!("fn {name}(")).expect("handler exists");
    let body_start = start + source[start..].find('{').unwrap();
    let mut depth = 0;
    for (index, byte) in source.as_bytes().iter().enumerate().skip(body_start) {
        if *byte == b'{' {
            depth += 1;
        }
        if *byte == b'}' {
            depth -= 1;
        }
        if depth == 0 {
            return &source[body_start..=index];
        }
    }
    panic!("unterminated handler {name}");
}
fn check_dispatch_count(source: &str, expected: usize) {
    let dispatch = source
        .split_once("match discriminator {")
        .expect("discriminator match")
        .1;
    let arms = dispatch
        .split_once("_ =>")
        .expect("invalid discriminator fallback")
        .0;
    let actual: usize = arms
        .split(',')
        .filter_map(|arm| arm.split_once("=>"))
        .map(|(patterns, _)| patterns.split('|').count())
        .sum();
    assert_eq!(actual, expected, "Program dispatch coverage drift");
}
fn check_dispatch(source: &str, disc: u8, variant: &str) {
    let expected = format!("{disc}=>{variant},");
    assert!(
        source.lines().any(|line| compact(line) == expected),
        "Program dispatch drift: {expected}"
    );
}
macro_rules! read {
    ($source:expr, $statement:stmt;) => {
        check($source, stringify!($statement));
        $statement
    };
}
fn main() -> Result<(), ProgramError> {
    check_dispatch_count(
        include_str!("../../../programs/perps-core/src/entrypoint.rs"),
        29,
    );
    check_dispatch_count(
        include_str!("../../../programs/perps-matcher/src/entrypoint.rs"),
        10,
    );
    check_dispatch_count(
        include_str!("../../../programs/oracle/src/entrypoint.rs"),
        5,
    );
    let mut fixtures: Vec<Value> = Vec::new();
    // core::Initialize
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 0, "CoreInstruction::Initialize");
        check(dispatch, "CoreInstruction::Initialize => {\n            msg!(\"Instruction: Initialize\");\n            process_initialize_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_initialize_inner",
        );
        let _ = source;
        check(source, "if data.len() < 140 {");
        check(source, "if data.len() > 140 {");
        {
            let data: &[u8] = &[
                19, 56, 93, 130, 167, 204, 241, 22, 59, 96, 133, 170, 207, 244, 25, 62, 99, 136,
                173, 210, 247, 28, 65, 102, 139, 176, 213, 250, 31, 68, 105, 142, 179, 216, 253,
                34, 71, 108, 145, 182, 219, 0, 37, 74, 111, 148, 185, 222, 3, 40, 77, 114, 151,
                188, 225, 6, 43, 80, 117, 154, 191, 228, 9, 46, 83, 120, 157, 194, 231, 12, 49, 86,
                123, 160, 197, 234, 15, 52, 89, 126, 163, 200, 237, 18, 55, 92, 129, 166, 203, 240,
                21, 58, 95, 132, 169, 206, 243, 24, 61, 98, 135, 172, 209, 246, 27, 64, 101, 138,
                175, 212, 249, 30, 67, 104, 141, 178, 215, 252, 33, 70, 107, 144, 181, 218, 255,
                36, 73, 110, 147, 184, 221, 2, 39, 76, 113, 150, 187, 224, 5, 42, 79,
            ];
            read!(source, let governance = Pubkey::from(<[u8; 32]>::try_from(&data[0..32]).unwrap()););
            read!(source, let instrument_count = u16::from_le_bytes(data[32..34].try_into().unwrap()););
            read!(source, let volatility_multiplier = u16::from_le_bytes(data[34..36].try_into().unwrap()););
            read!(source, let _batch_id_counter = u64::from_le_bytes(data[36..44].try_into().unwrap()););
            read!(source, let base_deposit = u64::from_le_bytes(data[44..52].try_into().unwrap()););
            read!(source, let n_min = u32::from_le_bytes(data[52..56].try_into().unwrap()););
            read!(source, let t_min_slots = u64::from_le_bytes(data[56..64].try_into().unwrap()););
            read!(source, let t_max_slots = u64::from_le_bytes(data[64..72].try_into().unwrap()););
            read!(source, let t_reveal_slots = u64::from_le_bytes(data[72..80].try_into().unwrap()););
            read!(source, let instrument_id = u16::from_le_bytes(data[80..82].try_into().unwrap()););
            read!(source, let tick_size = u64::from_le_bytes(data[82..90].try_into().unwrap()););
            read!(source, let lot_size = u64::from_le_bytes(data[90..98].try_into().unwrap()););
            read!(source, let imr_bps = u16::from_le_bytes(data[98..100].try_into().unwrap()););
            read!(source, let mmr_bps = u16::from_le_bytes(data[100..102].try_into().unwrap()););
            read!(source, let taker_fee_bps = u16::from_le_bytes(data[102..104].try_into().unwrap()););
            read!(source, let maker_fee_bps = i16::from_le_bytes(data[104..106].try_into().unwrap()););
            read!(source, let oracle_addr = Pubkey::from(<[u8; 32]>::try_from(&data[106..138]).unwrap()););
            read!(source, let registry_bump = data[138];);
            read!(source, let instrument_bump = data[139];);
            read!(source, let vault_bump = if data.len() > 140 { data[140] } else { 255 };);
            fixtures.push(json!({"program":"core","name":"Initialize","enabled":true,"bytes": ([&[0u8][..], data].concat()),"params":{"governance": governance.to_vec(),"instrumentCount": instrument_count.to_string(),"volatilityMultiplier": volatility_multiplier.to_string(),"batchIdCounter": _batch_id_counter.to_string(),"baseDeposit": base_deposit.to_string(),"nMin": n_min.to_string(),"tMinSlots": t_min_slots.to_string(),"tMaxSlots": t_max_slots.to_string(),"tRevealSlots": t_reveal_slots.to_string(),"instrumentId": instrument_id.to_string(),"tickSize": tick_size.to_string(),"lotSize": lot_size.to_string(),"imrBps": imr_bps.to_string(),"mmrBps": mmr_bps.to_string(),"takerFeeBps": taker_fee_bps.to_string(),"makerFeeBps": maker_fee_bps.to_string(),"oracleAddr": oracle_addr.to_vec(),"registryBump": registry_bump.to_string(),"instrumentBump": instrument_bump.to_string(),"vaultBump": vault_bump.to_string()}}));
        }
        {
            let data: &[u8] = &[
                19, 56, 93, 130, 167, 204, 241, 22, 59, 96, 133, 170, 207, 244, 25, 62, 99, 136,
                173, 210, 247, 28, 65, 102, 139, 176, 213, 250, 31, 68, 105, 142, 179, 216, 253,
                34, 71, 108, 145, 182, 219, 0, 37, 74, 111, 148, 185, 222, 3, 40, 77, 114, 151,
                188, 225, 6, 43, 80, 117, 154, 191, 228, 9, 46, 83, 120, 157, 194, 231, 12, 49, 86,
                123, 160, 197, 234, 15, 52, 89, 126, 163, 200, 237, 18, 55, 92, 129, 166, 203, 240,
                21, 58, 95, 132, 169, 206, 243, 24, 61, 98, 135, 172, 209, 246, 27, 64, 101, 138,
                175, 212, 249, 30, 67, 104, 141, 178, 215, 252, 33, 70, 107, 144, 181, 218, 255,
                36, 73, 110, 147, 184, 221, 2, 39, 76, 113, 150, 187, 224, 5, 42,
            ];
            read!(source, let governance = Pubkey::from(<[u8; 32]>::try_from(&data[0..32]).unwrap()););
            read!(source, let instrument_count = u16::from_le_bytes(data[32..34].try_into().unwrap()););
            read!(source, let volatility_multiplier = u16::from_le_bytes(data[34..36].try_into().unwrap()););
            read!(source, let _batch_id_counter = u64::from_le_bytes(data[36..44].try_into().unwrap()););
            read!(source, let base_deposit = u64::from_le_bytes(data[44..52].try_into().unwrap()););
            read!(source, let n_min = u32::from_le_bytes(data[52..56].try_into().unwrap()););
            read!(source, let t_min_slots = u64::from_le_bytes(data[56..64].try_into().unwrap()););
            read!(source, let t_max_slots = u64::from_le_bytes(data[64..72].try_into().unwrap()););
            read!(source, let t_reveal_slots = u64::from_le_bytes(data[72..80].try_into().unwrap()););
            read!(source, let instrument_id = u16::from_le_bytes(data[80..82].try_into().unwrap()););
            read!(source, let tick_size = u64::from_le_bytes(data[82..90].try_into().unwrap()););
            read!(source, let lot_size = u64::from_le_bytes(data[90..98].try_into().unwrap()););
            read!(source, let imr_bps = u16::from_le_bytes(data[98..100].try_into().unwrap()););
            read!(source, let mmr_bps = u16::from_le_bytes(data[100..102].try_into().unwrap()););
            read!(source, let taker_fee_bps = u16::from_le_bytes(data[102..104].try_into().unwrap()););
            read!(source, let maker_fee_bps = i16::from_le_bytes(data[104..106].try_into().unwrap()););
            read!(source, let oracle_addr = Pubkey::from(<[u8; 32]>::try_from(&data[106..138]).unwrap()););
            read!(source, let registry_bump = data[138];);
            read!(source, let instrument_bump = data[139];);
            read!(source, let vault_bump = if data.len() > 140 { data[140] } else { 255 };);
            assert_eq!(vault_bump, 255);
            fixtures.push(json!({"program":"core","name":"Initialize","enabled":true,"bytes": ([&[0u8][..], data].concat()),"params":{"governance": governance.to_vec(),"instrumentCount": instrument_count.to_string(),"volatilityMultiplier": volatility_multiplier.to_string(),"batchIdCounter": _batch_id_counter.to_string(),"baseDeposit": base_deposit.to_string(),"nMin": n_min.to_string(),"tMinSlots": t_min_slots.to_string(),"tMaxSlots": t_max_slots.to_string(),"tRevealSlots": t_reveal_slots.to_string(),"instrumentId": instrument_id.to_string(),"tickSize": tick_size.to_string(),"lotSize": lot_size.to_string(),"imrBps": imr_bps.to_string(),"mmrBps": mmr_bps.to_string(),"takerFeeBps": taker_fee_bps.to_string(),"makerFeeBps": maker_fee_bps.to_string(),"oracleAddr": oracle_addr.to_vec(),"registryBump": registry_bump.to_string(),"instrumentBump": instrument_bump.to_string()}}));
        }
    }
    // core::InitPortfolio
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 1, "CoreInstruction::InitPortfolio");
        check(dispatch, "CoreInstruction::InitPortfolio => {\n            msg!(\"Instruction: InitPortfolio\");\n            process_init_portfolio_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_init_portfolio_inner",
        );
        let _ = source;
        check(source, "if data.len() < 33 {");
        {
            let data: &[u8] = &[
                19, 56, 93, 130, 167, 204, 241, 22, 59, 96, 133, 170, 207, 244, 25, 62, 99, 136,
                173, 210, 247, 28, 65, 102, 139, 176, 213, 250, 31, 68, 105, 142, 179,
            ];
            read!(source, let user = Pubkey::from(<[u8; 32]>::try_from(&data[0..32]).unwrap()););
            read!(source, let bump = data[32];);
            fixtures.push(json!({"program":"core","name":"InitPortfolio","enabled":true,"bytes": ([&[1u8][..], data].concat()),"params":{"user": user.to_vec(),"bump": bump.to_string()}}));
        }
    }
    // core::Deposit
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 2, "CoreInstruction::Deposit");
        check(dispatch, "CoreInstruction::Deposit => {\n            msg!(\"Instruction: Deposit\");\n            process_deposit_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_deposit_inner",
        );
        let _ = source;
        check(source, "if data.len() < 8 {");
        {
            let data: &[u8] = &[19, 56, 93, 130, 167, 204, 241, 22];
            read!(source, let amount = u64::from_le_bytes(data[0..8].try_into().unwrap()););
            fixtures.push(json!({"program":"core","name":"Deposit","enabled":true,"bytes": ([&[2u8][..], data].concat()),"params":{"amount": amount.to_string()}}));
        }
    }
    // core::Withdraw
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 3, "CoreInstruction::Withdraw");
        check(dispatch, "CoreInstruction::Withdraw => {\n            msg!(\"Instruction: Withdraw\");\n            process_withdraw_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_withdraw_inner",
        );
        let _ = source;
        check(source, "if data.len() < 8 {");
        {
            let data: &[u8] = &[19, 56, 93, 130, 167, 204, 241, 22];
            read!(source, let amount = u64::from_le_bytes(data[0..8].try_into().unwrap()););
            fixtures.push(json!({"program":"core","name":"Withdraw","enabled":true,"bytes": ([&[3u8][..], data].concat()),"params":{"amount": amount.to_string()}}));
        }
    }
    // core::CommitOrder
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 4, "CoreInstruction::CommitOrder");
        check(dispatch, "CoreInstruction::CommitOrder => {\n            msg!(\"Instruction: CommitOrder\");\n            process_commit_order_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_commit_order_inner",
        );
        let _ = source;
        check(source, "if data.len() < 38 {");
        {
            let data: &[u8] = &[
                19, 56, 93, 1, 1, 204, 241, 22, 59, 96, 133, 170, 207, 244, 25, 62, 99, 136, 173,
                210, 247, 28, 65, 102, 139, 176, 213, 250, 31, 68, 105, 142, 179, 216, 253, 34, 71,
                108,
            ];
            read!(source, let order_type = data[0];);
            read!(source, let instrument_id = u16::from_le_bytes(data[1..3].try_into().unwrap()););
            read!(source, let reduce_only = data[3] != 0;);
            read!(source, let side = data[4];);
            read!(source, let price = i64::from_le_bytes(data[5..13].try_into().unwrap()););
            read!(source, let qty = u64::from_le_bytes(data[13..21].try_into().unwrap()););
            read!(source, let salt = u64::from_le_bytes(data[21..29].try_into().unwrap()););
            read!(source, let batch_id = u64::from_le_bytes(data[29..37].try_into().unwrap()););
            read!(source, let commitment_bump = data[37];);
            fixtures.push(json!({"program":"core","name":"CommitOrder","enabled":false,"bytes": ([&[4u8][..], data].concat()),"params":{"orderType": order_type.to_string(),"instrumentId": instrument_id.to_string(),"reduceOnly": reduce_only,"side": side.to_string(),"price": price.to_string(),"qty": qty.to_string(),"salt": salt.to_string(),"batchId": batch_id.to_string(),"commitmentBump": commitment_bump.to_string()}}));
        }
    }
    // core::RevealOrder
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 5, "CoreInstruction::RevealOrder");
        check(dispatch, "CoreInstruction::RevealOrder => {\n            msg!(\"Instruction: RevealOrder\");\n            process_reveal_order_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_reveal_order_inner",
        );
        let _ = source;
        check(source, "if data.len() < 37 {");
        {
            let data: &[u8] = &[
                19, 56, 93, 1, 1, 204, 241, 22, 59, 96, 133, 170, 207, 244, 25, 62, 99, 136, 173,
                210, 247, 28, 65, 102, 139, 176, 213, 250, 31, 68, 105, 142, 179, 216, 253, 34, 71,
            ];
            read!(source, let order_type = data[0];);
            read!(source, let instrument_id = u16::from_le_bytes(data[1..3].try_into().unwrap()););
            read!(source, let reduce_only = data[3] != 0;);
            read!(source, let side = data[4];);
            read!(source, let price = i64::from_le_bytes(data[5..13].try_into().unwrap()););
            read!(source, let qty = u64::from_le_bytes(data[13..21].try_into().unwrap()););
            read!(source, let salt = u64::from_le_bytes(data[21..29].try_into().unwrap()););
            read!(source, let batch_id = u64::from_le_bytes(data[29..37].try_into().unwrap()););
            fixtures.push(json!({"program":"core","name":"RevealOrder","enabled":false,"bytes": ([&[5u8][..], data].concat()),"params":{"orderType": order_type.to_string(),"instrumentId": instrument_id.to_string(),"reduceOnly": reduce_only,"side": side.to_string(),"price": price.to_string(),"qty": qty.to_string(),"salt": salt.to_string(),"batchId": batch_id.to_string()}}));
        }
    }
    // core::CloseCommitting
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 6, "CoreInstruction::CloseCommitting");
        check(dispatch, "CoreInstruction::CloseCommitting => {\n            msg!(\"Instruction: CloseCommitting\");\n            process_close_committing_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_close_committing_inner",
        );
        let _ = source;
        {
            let data: &[u8] = &[];
            fixtures.push(json!({"program":"core","name":"CloseCommitting","enabled":true,"bytes": ([&[6u8][..], data].concat()),"params":{}}));
        }
    }
    // core::ClearBatch
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 7, "CoreInstruction::ClearBatch");
        check(dispatch, "CoreInstruction::ClearBatch => {\n            msg!(\"Instruction: ClearBatch\");\n            process_clear_batch_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_clear_batch_inner",
        );
        let _ = source;
        check(source, "if data.len() < 6 {");
        {
            let data: &[u8] = &[19, 56, 93, 130, 167, 204];
            read!(source, let num_commitments = u16::from_le_bytes(data[0..2].try_into().unwrap()) as usize;);
            read!(source, let num_instruments = u16::from_le_bytes(data[2..4].try_into().unwrap()) as usize;);
            read!(source, let num_portfolios = u16::from_le_bytes(data[4..6].try_into().unwrap()) as usize;);
            fixtures.push(json!({"program":"core","name":"ClearBatch","enabled":true,"bytes": ([&[7u8][..], data].concat()),"params":{"numCommitments": num_commitments.to_string(),"numInstruments": num_instruments.to_string(),"numPortfolios": num_portfolios.to_string()}}));
        }
    }
    // core::SettleBatch
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 8, "CoreInstruction::SettleBatch");
        check(dispatch, "CoreInstruction::SettleBatch => {\n            msg!(\"Instruction: SettleBatch\");\n            process_settle_batch_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_settle_batch_inner",
        );
        let _ = source;
        check(source, "if data.len() < 4 {");
        check(source, "if data.len() > 4 {");
        {
            let data: &[u8] = &[19, 56, 93, 130, 167];
            read!(source, let num_commitments = u16::from_le_bytes(data[0..2].try_into().unwrap()) as usize;);
            read!(source, let num_portfolios = u16::from_le_bytes(data[2..4].try_into().unwrap()) as usize;);
            read!(source, let next_batch_bump = if data.len() > 4 { data[4] } else { 0 };);
            fixtures.push(json!({"program":"core","name":"SettleBatch","enabled":true,"bytes": ([&[8u8][..], data].concat()),"params":{"numCommitments": num_commitments.to_string(),"numPortfolios": num_portfolios.to_string(),"nextBatchBump": next_batch_bump.to_string()}}));
        }
        {
            let data: &[u8] = &[19, 56, 93, 130];
            read!(source, let num_commitments = u16::from_le_bytes(data[0..2].try_into().unwrap()) as usize;);
            read!(source, let num_portfolios = u16::from_le_bytes(data[2..4].try_into().unwrap()) as usize;);
            read!(source, let next_batch_bump = if data.len() > 4 { data[4] } else { 0 };);
            assert_eq!(next_batch_bump, 0);
            fixtures.push(json!({"program":"core","name":"SettleBatch","enabled":true,"bytes": ([&[8u8][..], data].concat()),"params":{"numCommitments": num_commitments.to_string(),"numPortfolios": num_portfolios.to_string()}}));
        }
    }
    // core::LiquidateUser
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 9, "CoreInstruction::LiquidateUser");
        check(dispatch, "CoreInstruction::LiquidateUser => {\n            msg!(\"Instruction: LiquidateUser\");\n            process_liquidate_user_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_liquidate_user_inner",
        );
        let _ = source;
        check(source, "if data != 1u16.to_le_bytes() {");
        {
            let data: &[u8] = &[1, 0];
            fixtures.push(json!({"program":"core","name":"LiquidateUser","enabled":true,"bytes": ([&[9u8][..], data].concat()),"params":{"numInstruments": u16::from_le_bytes(data.try_into().unwrap()).to_string()}}));
        }
    }
    // core::AddInstrument
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 10, "CoreInstruction::AddInstrument");
        check(dispatch, "CoreInstruction::AddInstrument => {\n            msg!(\"Instruction: AddInstrument\");\n            process_add_instrument_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_add_instrument_inner",
        );
        let _ = source;
        check(source, "if data.len() < 59 {");
        {
            let data: &[u8] = &[
                19, 56, 93, 130, 167, 204, 241, 22, 59, 96, 133, 170, 207, 244, 25, 62, 99, 136,
                173, 210, 247, 28, 65, 102, 139, 176, 213, 250, 31, 68, 105, 142, 179, 216, 253,
                34, 71, 108, 145, 182, 219, 0, 37, 74, 111, 148, 185, 222, 3, 40, 77, 114, 151,
                188, 225, 6, 43, 80, 117,
            ];
            read!(source, let instrument_id = u16::from_le_bytes(data[0..2].try_into().unwrap()););
            read!(source, let tick_size = u64::from_le_bytes(data[2..10].try_into().unwrap()););
            read!(source, let lot_size = u64::from_le_bytes(data[10..18].try_into().unwrap()););
            read!(source, let imr_bps = u16::from_le_bytes(data[18..20].try_into().unwrap()););
            read!(source, let mmr_bps = u16::from_le_bytes(data[20..22].try_into().unwrap()););
            read!(source, let taker_fee_bps = u16::from_le_bytes(data[22..24].try_into().unwrap()););
            read!(source, let maker_fee_bps = i16::from_le_bytes(data[24..26].try_into().unwrap()););
            read!(source, let oracle_addr = Pubkey::from(<[u8; 32]>::try_from(&data[26..58]).unwrap()););
            read!(source, let bump = data[58];);
            fixtures.push(json!({"program":"core","name":"AddInstrument","enabled":true,"bytes": ([&[10u8][..], data].concat()),"params":{"instrumentId": instrument_id.to_string(),"tickSize": tick_size.to_string(),"lotSize": lot_size.to_string(),"imrBps": imr_bps.to_string(),"mmrBps": mmr_bps.to_string(),"takerFeeBps": taker_fee_bps.to_string(),"makerFeeBps": maker_fee_bps.to_string(),"oracleAddr": oracle_addr.to_vec(),"bump": bump.to_string()}}));
        }
    }
    // core::CancelRestingOrder
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 11, "CoreInstruction::CancelRestingOrder");
        check(dispatch, "CoreInstruction::CancelRestingOrder => {\n            msg!(\"Instruction: CancelRestingOrder\");\n            process_cancel_resting_order_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_cancel_resting_order_inner",
        );
        let _ = source;
        check(source, "if data.len() < 8 {");
        {
            let data: &[u8] = &[19, 56, 93, 130, 167, 204, 241, 22];
            read!(source, let order_id = u64::from_le_bytes(data[0..8].try_into().unwrap()););
            fixtures.push(json!({"program":"core","name":"CancelRestingOrder","enabled":true,"bytes": ([&[11u8][..], data].concat()),"params":{"orderId": order_id.to_string()}}));
        }
    }
    // core::ModifyRestingOrder
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 12, "CoreInstruction::ModifyRestingOrder");
        check(dispatch, "CoreInstruction::ModifyRestingOrder => {\n            msg!(\"Instruction: ModifyRestingOrder\");\n            process_modify_resting_order_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_modify_resting_order_inner",
        );
        let _ = source;
        check(source, "if data.len() < 16 {");
        {
            let data: &[u8] = &[
                19, 56, 93, 130, 167, 204, 241, 22, 59, 96, 133, 170, 207, 244, 25, 62,
            ];
            read!(source, let order_id = u64::from_le_bytes(data[0..8].try_into().unwrap()););
            read!(source, let new_qty = u64::from_le_bytes(data[8..16].try_into().unwrap()););
            fixtures.push(json!({"program":"core","name":"ModifyRestingOrder","enabled":true,"bytes": ([&[12u8][..], data].concat()),"params":{"orderId": order_id.to_string(),"newQty": new_qty.to_string()}}));
        }
    }
    // core::CancelAllRestingOrders
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 13, "CoreInstruction::CancelAllRestingOrders");
        check(dispatch, "CoreInstruction::CancelAllRestingOrders => {\n            msg!(\"Instruction: CancelAllRestingOrders\");\n            process_cancel_all_resting_orders_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_cancel_all_resting_orders_inner",
        );
        let _ = source;
        check(source, "if data.len() < 2 {");
        {
            let data: &[u8] = &[19, 56];
            read!(source, let num_books = u16::from_le_bytes(data[0..2].try_into().unwrap()) as usize;);
            fixtures.push(json!({"program":"core","name":"CancelAllRestingOrders","enabled":true,"bytes": ([&[13u8][..], data].concat()),"params":{"numBooks": num_books.to_string()}}));
        }
    }
    // core::SetPauseFlags
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 14, "CoreInstruction::SetPauseFlags");
        check(dispatch, "CoreInstruction::SetPauseFlags => {\n            msg!(\"Instruction: SetPauseFlags\");\n            process_set_pause_flags_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_set_pause_flags_inner",
        );
        let _ = source;
        check(source, "if data.is_empty() {");
        {
            let data: &[u8] = &[19];
            read!(source, let flags = data[0];);
            fixtures.push(json!({"program":"core","name":"SetPauseFlags","enabled":true,"bytes": ([&[14u8][..], data].concat()),"params":{"flags": flags.to_string()}}));
        }
    }
    // core::InitVault
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 15, "CoreInstruction::InitVault");
        check(dispatch, "CoreInstruction::InitVault => {\n            msg!(\"Instruction: InitVault\");\n            process_init_vault_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_init_vault_inner",
        );
        let _ = source;
        check(source, "if data.is_empty() {");
        {
            let data: &[u8] = &[19];
            read!(source, let bump = data[0];);
            fixtures.push(json!({"program":"core","name":"InitVault","enabled":true,"bytes": ([&[15u8][..], data].concat()),"params":{"bump": bump.to_string()}}));
        }
    }
    // core::CreateBatch
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 16, "CoreInstruction::CreateBatch");
        check(dispatch, "CoreInstruction::CreateBatch => {\n            msg!(\"Instruction: CreateBatch\");\n            process_create_batch_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_create_batch_inner",
        );
        let _ = source;
        check(source, "if data.is_empty() {");
        {
            let data: &[u8] = &[19];
            read!(source, let bump = data[0];);
            fixtures.push(json!({"program":"core","name":"CreateBatch","enabled":true,"bytes": ([&[16u8][..], data].concat()),"params":{"bump": bump.to_string()}}));
        }
    }
    // core::SetBatchCounter
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 17, "CoreInstruction::SetBatchCounter");
        check(dispatch, "CoreInstruction::SetBatchCounter => {\n            msg!(\"Instruction: SetBatchCounter\");\n            process_set_batch_counter_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_set_batch_counter_inner",
        );
        let _ = source;
        {
            let data: &[u8] = &[];
            fixtures.push(json!({"program":"core","name":"SetBatchCounter","enabled":true,"bytes": ([&[17u8][..], data].concat()),"params":{}}));
        }
    }
    // core::CreatePortfolio
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 18, "CoreInstruction::CreatePortfolio");
        check(dispatch, "CoreInstruction::CreatePortfolio => {\n            msg!(\"Instruction: CreatePortfolio\");\n            process_create_portfolio_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/instructions/create_portfolio.rs"),
            "process_create_portfolio",
        );
        let _ = source;
        {
            let data: &[u8] = &[19];
            read!(source, let bump = data.first().copied().unwrap_or(0););
            fixtures.push(json!({"program":"core","name":"CreatePortfolio","enabled":true,"bytes": ([&[18u8][..], data].concat()),"params":{"bump": bump.to_string()}}));
        }
    }
    // core::InitPortfolioForUser
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 19, "CoreInstruction::InitPortfolioForUser");
        check(dispatch, "CoreInstruction::InitPortfolioForUser => {\n            msg!(\"Instruction: InitPortfolioForUser\");\n            process_init_portfolio_for_user(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!(
                "../../../programs/perps-core/src/instructions/init_portfolio_for_user.rs"
            ),
            "process_init_portfolio_for_user",
        );
        let _ = source;
        {
            let data: &[u8] = &[
                19, 56, 93, 130, 167, 204, 241, 22, 59, 96, 133, 170, 207, 244, 25, 62, 99, 136,
                173, 210, 247, 28, 65, 102, 139, 176, 213, 250, 31, 68, 105, 142,
            ];
            read!(source, let user_bytes = data.get(0..32).ok_or(ProgramError::InvalidInstructionData)?;);
            read!(source, let user = Pubkey::from(<[u8; 32]>::try_from(user_bytes).unwrap()););
            fixtures.push(json!({"program":"core","name":"InitPortfolioForUser","enabled":true,"bytes": ([&[19u8][..], data].concat()),"params":{"user": user.to_vec()}}));
        }
    }
    // core::PostOrder
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 20, "CoreInstruction::PostOrder");
        check(dispatch, "CoreInstruction::PostOrder => {\n            msg!(\"Instruction: PostOrder\");\n            process_post_order_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_post_order_inner",
        );
        let _ = source;
        check(source, "if data.len() < 21 {");
        {
            let data: &[u8] = &[
                1, 1, 93, 130, 167, 204, 241, 22, 59, 96, 133, 170, 207, 244, 25, 62, 99, 136, 173,
                210, 1,
            ];
            read!(source, let side = data[0];);
            read!(source, let is_maker = data[1] != 0;);
            read!(source, let price = i64::from_le_bytes(data[2..10].try_into().unwrap()););
            read!(source, let qty = u64::from_le_bytes(data[10..18].try_into().unwrap()););
            read!(source, let instrument_id = u16::from_le_bytes(data[18..20].try_into().unwrap()););
            read!(source, let reduce_only = data[20] != 0;);
            fixtures.push(json!({"program":"core","name":"PostOrder","enabled":true,"bytes": ([&[20u8][..], data].concat()),"params":{"side": side.to_string(),"isMaker": is_maker,"price": price.to_string(),"qty": qty.to_string(),"instrumentId": instrument_id.to_string(),"reduceOnly": reduce_only}}));
        }
    }
    // core::SetBatchParams
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 21, "CoreInstruction::SetBatchParams");
        check(dispatch, "CoreInstruction::SetBatchParams => {\n            msg!(\"Instruction: SetBatchParams\");\n            process_set_batch_params_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_set_batch_params_inner",
        );
        let _ = source;
        check(source, "if data.len() < 22 {");
        {
            let data: &[u8] = &[
                19, 56, 93, 130, 167, 204, 241, 22, 59, 96, 133, 170, 207, 244, 25, 62, 99, 136,
                173, 210, 247, 28,
            ];
            read!(source, let max_orders = data[0];);
            read!(source, let marginal_cap = data[1];);
            read!(source, let t_min_slots = u64::from_le_bytes(data[2..10].try_into().unwrap()););
            read!(source, let t_max_slots = u64::from_le_bytes(data[10..18].try_into().unwrap()););
            read!(source, let n_min = u32::from_le_bytes(data[18..22].try_into().unwrap()););
            fixtures.push(json!({"program":"core","name":"SetBatchParams","enabled":true,"bytes": ([&[21u8][..], data].concat()),"params":{"maxOrdersPerBatch": max_orders.to_string(),"marginalSizeCap": marginal_cap.to_string(),"tMinSlots": t_min_slots.to_string(),"tMaxSlots": t_max_slots.to_string(),"nMin": n_min.to_string()}}));
        }
    }
    // core::SetInstrumentFees
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 22, "CoreInstruction::SetInstrumentFees");
        check(dispatch, "CoreInstruction::SetInstrumentFees => {\n            msg!(\"Instruction: SetInstrumentFees\");\n            process_set_instrument_fees_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_set_instrument_fees_inner",
        );
        let _ = source;
        check(source, "if data.len() < 4 {");
        {
            let data: &[u8] = &[19, 56, 93, 130];
            read!(source, let taker_fee_bps = u16::from_le_bytes(data[0..2].try_into().unwrap()););
            read!(source, let maker_fee_bps = i16::from_le_bytes(data[2..4].try_into().unwrap()););
            fixtures.push(json!({"program":"core","name":"SetInstrumentFees","enabled":true,"bytes": ([&[22u8][..], data].concat()),"params":{"takerFeeBps": taker_fee_bps.to_string(),"makerFeeBps": maker_fee_bps.to_string()}}));
        }
    }
    // core::SetInstrumentOracle
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 23, "CoreInstruction::SetInstrumentOracle");
        check(dispatch, "CoreInstruction::SetInstrumentOracle => {\n            msg!(\"Instruction: SetInstrumentOracle\");\n            process_set_instrument_oracle_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_set_instrument_oracle_inner",
        );
        let _ = source;
        {
            let data: &[u8] = &[];
            fixtures.push(json!({"program":"core","name":"SetInstrumentOracle","enabled":true,"bytes": ([&[23u8][..], data].concat()),"params":{}}));
        }
    }
    // core::SetFundingParams
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 24, "CoreInstruction::SetFundingParams");
        check(dispatch, "CoreInstruction::SetFundingParams => {\n            msg!(\"Instruction: SetFundingParams\");\n            process_set_funding_params_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_set_funding_params_inner",
        );
        let _ = source;
        check(source, "if data.len() < 24 {");
        {
            let data: &[u8] = &[
                19, 56, 93, 130, 167, 204, 241, 22, 59, 96, 133, 170, 207, 244, 25, 62, 99, 136,
                173, 210, 247, 28, 65, 102,
            ];
            read!(source, let coefficient_bps = i64::from_le_bytes(data[0..8].try_into().unwrap()););
            read!(source, let max_rate_bps = i64::from_le_bytes(data[8..16].try_into().unwrap()););
            read!(source, let interval_slots = u64::from_le_bytes(data[16..24].try_into().unwrap()););
            fixtures.push(json!({"program":"core","name":"SetFundingParams","enabled":true,"bytes": ([&[24u8][..], data].concat()),"params":{"coefficientBps": coefficient_bps.to_string(),"maxRateBps": max_rate_bps.to_string(),"intervalSlots": interval_slots.to_string()}}));
        }
    }
    // core::InitializeBook
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 25, "CoreInstruction::InitializeBook");
        check(dispatch, "CoreInstruction::InitializeBook => {\n            process_initialize_book_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_initialize_book_inner",
        );
        let _ = source;
        check(source, "if data.len() != 2 {");
        {
            let data: &[u8] = &[19, 56];
            read!(source, let id = u16::from_le_bytes(data.try_into().unwrap()););
            fixtures.push(json!({"program":"core","name":"InitializeBook","enabled":true,"bytes": ([&[25u8][..], data].concat()),"params":{"instrumentId": id.to_string()}}));
        }
    }
    // core::TopUp
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 26, "CoreInstruction::TopUp");
        check(dispatch, "CoreInstruction::TopUp => {\n            msg!(\"Instruction: TopUp\");\n            process_top_up_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_top_up_inner",
        );
        let _ = source;
        check(source, "if data.len() < 8 {");
        {
            let data: &[u8] = &[19, 56, 93, 130, 167, 204, 241, 22];
            read!(source, let amount = u64::from_le_bytes(data[0..8].try_into().unwrap()););
            fixtures.push(json!({"program":"core","name":"TopUp","enabled":true,"bytes": ([&[26u8][..], data].concat()),"params":{"amount": amount.to_string()}}));
        }
    }
    // core::WithdrawInsuranceFund
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 27, "CoreInstruction::WithdrawInsuranceFund");
        check(dispatch, "CoreInstruction::WithdrawInsuranceFund => {\n            msg!(\"Instruction: WithdrawInsuranceFund\");\n            process_withdraw_insurance_fund_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_withdraw_insurance_fund_inner",
        );
        let _ = source;
        check(source, "if data.len() < 8 {");
        {
            let data: &[u8] = &[19, 56, 93, 130, 167, 204, 241, 22];
            read!(source, let amount = u64::from_le_bytes(data[0..8].try_into().unwrap()););
            fixtures.push(json!({"program":"core","name":"WithdrawInsuranceFund","enabled":true,"bytes": ([&[27u8][..], data].concat()),"params":{"amount": amount.to_string()}}));
        }
    }
    // core::Unpause
    {
        let dispatch = include_str!("../../../programs/perps-core/src/entrypoint.rs");
        check_dispatch(dispatch, 28, "CoreInstruction::Unpause");
        check(dispatch, "CoreInstruction::Unpause => {\n            msg!(\"Instruction: Unpause\");\n            process_unpause_inner(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-core/src/entrypoint.rs"),
            "process_unpause_inner",
        );
        let _ = source;
        check(source, "if data.len() < 2 {");
        {
            let data: &[u8] = &[1, 1];
            check(source, "data[0] != 0");
            check(source, "data[1] != 0");
            fixtures.push(json!({"program":"core","name":"Unpause","enabled":true,"bytes": ([&[28u8][..], data].concat()),"params":{"resumeWithdrawals": data[0] != 0,"resumeTrading": data[1] != 0}}));
        }
    }
    // matcher::ComputeClearing
    {
        let dispatch = include_str!("../../../programs/perps-matcher/src/entrypoint.rs");
        check(
            dispatch,
            "0 | 3 => return Err(ProgramError::InvalidInstructionData)",
        );
        {
            let data: &[u8] = &[];
            fixtures.push(json!({"program":"matcher","name":"ComputeClearing","enabled":false,"bytes": ([&[0u8][..], data].concat()),"params":{}}));
        }
    }
    // matcher::CancelResting
    {
        let dispatch = include_str!("../../../programs/perps-matcher/src/entrypoint.rs");
        check_dispatch(dispatch, 1, "MatcherInstruction::CancelResting");
        check(dispatch, "MatcherInstruction::CancelResting => {\n            msg!(\"Instruction: CancelResting\");\n            instructions::process_cancel_resting(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-matcher/src/instructions.rs"),
            "process_cancel_resting",
        );
        let _ = source;
        check(source, "if data.len() < CANCEL_DATA_LEN {");
        {
            let data: &[u8] = &[
                19, 56, 93, 130, 167, 204, 241, 22, 59, 96, 133, 170, 207, 244, 25, 62, 99, 136,
                173, 210, 247, 28, 65, 102, 139, 176, 213, 250, 31, 68, 105, 142, 179, 216, 253,
                34, 71, 108, 145, 182,
            ];
            check(
                source,
                "let (user, accounts) = authenticated_user(accounts)?;",
            );
            read!(source, let order_id = u64::from_le_bytes(
        data[32..40]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    ););
            fixtures.push(json!({"program":"matcher","name":"CancelResting","enabled":true,"bytes": ([&[1u8][..], data].concat()),"params":{"user": data[0..32].to_vec(),"orderId": order_id.to_string()}}));
        }
    }
    // matcher::ModifyResting
    {
        let dispatch = include_str!("../../../programs/perps-matcher/src/entrypoint.rs");
        check_dispatch(dispatch, 2, "MatcherInstruction::ModifyResting");
        check(dispatch, "MatcherInstruction::ModifyResting => {\n            msg!(\"Instruction: ModifyResting\");\n            instructions::process_modify_resting(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-matcher/src/instructions.rs"),
            "process_modify_resting",
        );
        let _ = source;
        check(source, "if data.len() < MODIFY_DATA_LEN {");
        {
            let data: &[u8] = &[
                19, 56, 93, 130, 167, 204, 241, 22, 59, 96, 133, 170, 207, 244, 25, 62, 99, 136,
                173, 210, 247, 28, 65, 102, 139, 176, 213, 250, 31, 68, 105, 142, 179, 216, 253,
                34, 71, 108, 145, 182, 219, 0, 37, 74, 111, 148, 185, 222,
            ];
            check(
                source,
                "let (user, accounts) = authenticated_user(accounts)?;",
            );
            read!(source, let order_id = u64::from_le_bytes(
        data[32..40]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    ););
            read!(source, let new_qty = u64::from_le_bytes(
        data[40..48]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    ););
            fixtures.push(json!({"program":"matcher","name":"ModifyResting","enabled":true,"bytes": ([&[2u8][..], data].concat()),"params":{"user": data[0..32].to_vec(),"orderId": order_id.to_string(),"newQty": new_qty.to_string()}}));
        }
    }
    // matcher::ClearAndMatch
    {
        let dispatch = include_str!("../../../programs/perps-matcher/src/entrypoint.rs");
        check(
            dispatch,
            "0 | 3 => return Err(ProgramError::InvalidInstructionData)",
        );
        {
            let data: &[u8] = &[];
            fixtures.push(json!({"program":"matcher","name":"ClearAndMatch","enabled":false,"bytes": ([&[3u8][..], data].concat()),"params":{}}));
        }
    }
    // matcher::CancelAll
    {
        let dispatch = include_str!("../../../programs/perps-matcher/src/entrypoint.rs");
        check_dispatch(dispatch, 4, "MatcherInstruction::CancelAll");
        check(dispatch, "MatcherInstruction::CancelAll => {\n            msg!(\"Instruction: CancelAll\");\n            instructions::process_cancel_all(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-matcher/src/instructions.rs"),
            "process_cancel_all",
        );
        let _ = source;
        check(source, "if data.len() < 32 {");
        {
            let data: &[u8] = &[
                19, 56, 93, 130, 167, 204, 241, 22, 59, 96, 133, 170, 207, 244, 25, 62, 99, 136,
                173, 210, 247, 28, 65, 102, 139, 176, 213, 250, 31, 68, 105, 142,
            ];
            check(
                source,
                "let (user, accounts) = authenticated_user(accounts)?;",
            );
            fixtures.push(json!({"program":"matcher","name":"CancelAll","enabled":true,"bytes": ([&[4u8][..], data].concat()),"params":{"user": data[0..32].to_vec()}}));
        }
    }
    // matcher::DfbaClear
    {
        let dispatch = include_str!("../../../programs/perps-matcher/src/entrypoint.rs");
        check_dispatch(dispatch, 5, "MatcherInstruction::DfbaClear");
        check(dispatch, "MatcherInstruction::DfbaClear => {\n            msg!(\"Instruction: DfbaClear\");\n            instructions::process_dfba_clear(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-matcher/src/instructions.rs"),
            "process_dfba_clear",
        );
        let _ = source;
        check(source, "if data.len() < DFBA_IX_HEADER_BYTES {");
        check(source, "if num_orders != 0 || data.len() != DFBA_IX_HEADER_BYTES + 8 || !matches!(accounts.len(), 2 | 4) {");
        {
            let data: &[u8] = &[
                19, 56, 93, 130, 167, 204, 241, 22, 0, 0, 133, 170, 207, 244, 25, 62, 99, 136,
            ];
            read!(source, let marginal_size_cap = u64::from_le_bytes(
        data[0..8]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    ););
            read!(source, let num_orders = u16::from_le_bytes([data[8], data[9]]) as usize;);
            use mgk_perps_matcher::instructions::DFBA_IX_HEADER_BYTES;
            read!(source, let batch_id = u64::from_le_bytes(data[DFBA_IX_HEADER_BYTES..].try_into().unwrap()););
            fixtures.push(json!({"program":"matcher","name":"DfbaClear","enabled":true,"bytes": ([&[5u8][..], data].concat()),"params":{"marginalSizeCap": marginal_size_cap.to_string(),"numOrders": num_orders.to_string(),"batchId": batch_id.to_string()}}));
        }
    }
    // matcher::PlaceResting
    {
        let dispatch = include_str!("../../../programs/perps-matcher/src/entrypoint.rs");
        check_dispatch(dispatch, 6, "MatcherInstruction::PlaceResting");
        check(dispatch, "MatcherInstruction::PlaceResting => {\n            msg!(\"Instruction: PlaceResting\");\n            instructions::process_place_resting(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-matcher/src/instructions.rs"),
            "process_place_resting",
        );
        let _ = source;
        check(source, "if data.len() < PLACE_RESTING_DATA_LEN {");
        {
            let data: &[u8] = &[
                19, 56, 93, 130, 167, 204, 241, 22, 59, 96, 133, 170, 207, 244, 25, 62, 99, 136,
                173, 210, 247, 28, 65, 102, 139, 176, 213, 250, 31, 68, 105, 142, 1, 1, 253, 34,
                71, 108, 145, 182, 219, 0, 37, 74, 111, 148, 185, 222, 3, 40, 77, 114, 1,
            ];
            check(
                source,
                "let (user, accounts) = authenticated_user(accounts)?;",
            );
            read!(source, let side = Side::from_u8(data[32]).ok_or(ProgramError::InvalidInstructionData)?;);
            read!(source, let is_maker = data[33] != 0;);
            read!(source, let price = i64::from_le_bytes(
        data[34..42]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    ););
            read!(source, let qty = u64::from_le_bytes(
        data[42..50]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    ););
            read!(source, let instrument_id = u16::from_le_bytes([data[50], data[51]]););
            read!(source, let reduce_only = data[52] != 0;);
            fixtures.push(json!({"program":"matcher","name":"PlaceResting","enabled":true,"bytes": ([&[6u8][..], data].concat()),"params":{"user": data[0..32].to_vec(),"side": (side as u8).to_string(),"isMaker": is_maker,"price": price.to_string(),"qty": qty.to_string(),"instrumentId": instrument_id.to_string(),"reduceOnly": reduce_only}}));
        }
    }
    // matcher::InitializeBook
    {
        let dispatch = include_str!("../../../programs/perps-matcher/src/entrypoint.rs");
        check_dispatch(dispatch, 7, "MatcherInstruction::InitializeBook");
        check(dispatch, "MatcherInstruction::InitializeBook => {\n            msg!(\"Instruction: InitializeBook\");\n            instructions::process_initialize_book(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-matcher/src/instructions.rs"),
            "process_initialize_book",
        );
        let _ = source;
        check(source, "if data.len() < INIT_BOOK_DATA_LEN {");
        {
            let data: &[u8] = &[19, 56, 93];
            read!(source, let instrument_id = u16::from_le_bytes([data[0], data[1]]););
            read!(source, let bump = data[2];);
            fixtures.push(json!({"program":"matcher","name":"InitializeBook","enabled":true,"bytes": ([&[7u8][..], data].concat()),"params":{"instrumentId": instrument_id.to_string(),"bump": bump.to_string()}}));
        }
    }
    // matcher::ConsumeResults
    {
        let dispatch = include_str!("../../../programs/perps-matcher/src/entrypoint.rs");
        check_dispatch(dispatch, 8, "MatcherInstruction::ConsumeResults");
        check(dispatch, "MatcherInstruction::ConsumeResults => {\n            process_consume_results(accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-matcher/src/entrypoint.rs"),
            "process_consume_results",
        );
        let _ = source;
        check(source, "if data.len() != 8 {");
        {
            let data: &[u8] = &[19, 56, 93, 130, 167, 204, 241, 22];
            read!(source, let batch_id = u64::from_le_bytes(data.try_into().unwrap()););
            fixtures.push(json!({"program":"matcher","name":"ConsumeResults","enabled":true,"bytes": ([&[8u8][..], data].concat()),"params":{"batchId": batch_id.to_string()}}));
        }
    }
    // matcher::CancelSettledOrders
    {
        let dispatch = include_str!("../../../programs/perps-matcher/src/entrypoint.rs");
        check_dispatch(dispatch, 9, "MatcherInstruction::CancelSettledOrders");
        check(dispatch, "MatcherInstruction::CancelSettledOrders => {\n            process_cancel_settled_orders(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/perps-matcher/src/entrypoint.rs"),
            "process_cancel_settled_orders",
        );
        let _ = source;
        check(source, "if count > mgk_common::matcher::MAX_SETTLEMENT_ORDERS || data.len() != 1 + count * 8 {");
        {
            let data: &[u8] = &[
                3, 56, 93, 130, 167, 204, 241, 22, 59, 96, 133, 170, 207, 244, 25, 62, 99, 136,
                173, 210, 247, 28, 65, 102, 139,
            ];
            check(
                source,
                "let count = *data.first().ok_or(ProgramError::InvalidInstructionData)? as usize;",
            );
            check(source, "let start = 1 + index * 8;");
            check(
                source,
                "*id = u64::from_le_bytes(data[start..start + 8].try_into().unwrap());",
            );
            fixtures.push(json!({"program":"matcher","name":"CancelSettledOrders","enabled":true,"bytes": ([&[9u8][..], data].concat()),"params":{"orderIds": (0..3).map(|index| {let start = 1 + index * 8; u64::from_le_bytes(data[start..start+8].try_into().unwrap()).to_string()}).collect::<Vec<_>>()}}));
        }
    }
    // oracle::Initialize
    {
        let dispatch = include_str!("../../../programs/oracle/src/entrypoint.rs");
        check_dispatch(dispatch, 0, "OracleInstruction::Initialize");
        check(dispatch, "OracleInstruction::Initialize => {\n            msg!(\"Instruction: Initialize\");\n            instructions::process_initialize(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/oracle/src/instructions.rs"),
            "process_initialize",
        );
        let _ = source;
        check(source, "if data.len() < 9 {");
        {
            let data: &[u8] = &[19, 56, 93, 130, 167, 204, 241, 22, 59];
            read!(source, let initial_price = i64::from_le_bytes([
        data[0], data[1], data[2], data[3], data[4], data[5], data[6], data[7],
    ]););
            read!(source, let bump = data[8];);
            fixtures.push(json!({"program":"oracle","name":"Initialize","enabled":true,"bytes": ([&[0u8][..], data].concat()),"params":{"initialPrice": initial_price.to_string(),"bump": bump.to_string()}}));
        }
    }
    // oracle::UpdatePrice
    {
        let dispatch = include_str!("../../../programs/oracle/src/entrypoint.rs");
        check_dispatch(dispatch, 1, "OracleInstruction::UpdatePrice");
        check(dispatch, "OracleInstruction::UpdatePrice => {\n            msg!(\"Instruction: UpdatePrice\");\n            instructions::process_update_price(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/oracle/src/instructions.rs"),
            "process_update_price",
        );
        let _ = source;
        check(source, "if data.len() < 16 {");
        {
            let data: &[u8] = &[
                19, 56, 93, 130, 167, 204, 241, 22, 59, 96, 133, 170, 207, 244, 25, 62,
            ];
            read!(source, let price = i64::from_le_bytes([
        data[0], data[1], data[2], data[3], data[4], data[5], data[6], data[7],
    ]););
            read!(source, let confidence = i64::from_le_bytes([
        data[8], data[9], data[10], data[11], data[12], data[13], data[14], data[15],
    ]););
            fixtures.push(json!({"program":"oracle","name":"UpdatePrice","enabled":true,"bytes": ([&[1u8][..], data].concat()),"params":{"price": price.to_string(),"confidence": confidence.to_string()}}));
        }
    }
    // oracle::SetAuthority
    {
        let dispatch = include_str!("../../../programs/oracle/src/entrypoint.rs");
        check_dispatch(dispatch, 2, "OracleInstruction::SetAuthority");
        check(dispatch, "OracleInstruction::SetAuthority => {\n            msg!(\"Instruction: SetAuthority\");\n            instructions::process_set_authority(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/oracle/src/instructions.rs"),
            "process_set_authority",
        );
        let _ = source;
        check(source, "if data.len() < 32 {");
        {
            let data: &[u8] = &[
                19, 56, 93, 130, 167, 204, 241, 22, 59, 96, 133, 170, 207, 244, 25, 62, 99, 136,
                173, 210, 247, 28, 65, 102, 139, 176, 213, 250, 31, 68, 105, 142,
            ];
            read!(source, let new_authority_bytes: [u8; 32] = data[0..32]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;);
            read!(source, let new_authority = Pubkey::from(new_authority_bytes););
            fixtures.push(json!({"program":"oracle","name":"SetAuthority","enabled":true,"bytes": ([&[2u8][..], data].concat()),"params":{"authority": new_authority.to_vec()}}));
        }
    }
    // oracle::Activate
    {
        let dispatch = include_str!("../../../programs/oracle/src/entrypoint.rs");
        check_dispatch(dispatch, 3, "OracleInstruction::Activate");
        check(dispatch, "OracleInstruction::Activate => {\n            msg!(\"Instruction: Activate\");\n            instructions::process_activate(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/oracle/src/instructions.rs"),
            "process_activate",
        );
        let _ = source;
        {
            let data: &[u8] = &[];
            fixtures.push(json!({"program":"oracle","name":"Activate","enabled":true,"bytes": ([&[3u8][..], data].concat()),"params":{}}));
        }
    }
    // oracle::Deactivate
    {
        let dispatch = include_str!("../../../programs/oracle/src/entrypoint.rs");
        check_dispatch(dispatch, 4, "OracleInstruction::Deactivate");
        check(dispatch, "OracleInstruction::Deactivate => {\n            msg!(\"Instruction: Deactivate\");\n            instructions::process_deactivate(program_id, accounts, &instruction_data[1..])");
        let source = handler(
            include_str!("../../../programs/oracle/src/instructions.rs"),
            "process_deactivate",
        );
        let _ = source;
        {
            let data: &[u8] = &[];
            fixtures.push(json!({"program":"oracle","name":"Deactivate","enabled":true,"bytes": ([&[4u8][..], data].concat()),"params":{}}));
        }
    }
    println!("{}", serde_json::to_string_pretty(&fixtures).unwrap());
    Ok(())
}
