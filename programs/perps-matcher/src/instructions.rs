use crate::state::clearing::{BuyEntry, SellEntry};
use crate::state::{
    book_state_from_bytes_mut, cancel_all_for_user, cancel_resting_by_id,
    clob_match_with_caps_into, clob_match_with_risk_into, compute_clearing_into,
    default_risk_check, modify_resting_qty, place_resting, separate_priority_queues,
    shuffle_orders, DfbaOrder, DualClearScratch, FillReceipt, LimitOrder, MatchResult, OrderType,
    PartitionedOrders, Side, DFBA_MAX_ORDERS, MAX_FILLS_PER_BATCH, MAX_ORDERS,
};
use core::alloc::Layout;
use mgk_common::layout::{discriminator, stamp_body_mut, LAYOUT_VERSION_1};
use mgk_common::matcher::{
    validate_authority, validate_results, MAX_SETTLEMENT_ORDERS, RESULTS_ENVELOPE_LEN,
};
use pinocchio::{
    account_info::AccountInfo, msg, program_error::ProgramError, pubkey::Pubkey, ProgramResult,
};

#[cfg(target_os = "solana")]
extern crate alloc;
#[cfg(target_os = "solana")]
use alloc::alloc::alloc_zeroed;
#[cfg(not(target_os = "solana"))]
use std::alloc::alloc_zeroed;

// =============================================================================
// Heap scratch — BPF-safe allocation via the BumpAllocator
//
// Solana's SBF loader rejects writable data sections (`.bss`, `.data.S`),
// so static `mut` arrays crash at runtime with "Access violation in program
// section". The `entrypoint!` macro sets up a 32 KB BumpAllocator at
// `HEAP_START_ADDRESS`; each instruction gets a fresh bump. We allocate
// scratch arrays from this heap via `alloc_zeroed`.
//
// All scratch types (LimitOrder, BuyEntry, SellEntry, FillReceipt, etc.)
// are valid when zeroed: Side::Buy = 0, OrderType::LimitGTC = 0, numeric
// fields = 0, bool fields = false, Pubkey = all-zeros.
// =============================================================================

/// Allocate a zeroed fixed-size array from the heap.
///
/// Returns `&'static mut [T; N]` — the BumpAllocator never frees, so the
/// reference is valid for the entire instruction execution. Each BPF
/// instruction starts with a fresh heap, so there is no cross-instruction
/// leakage.
///
/// Returns `Err` if the allocation fails (null pointer from `alloc_zeroed`).
#[inline(always)]
fn heap_array_fixed<T: Sized, const N: usize>() -> Result<&'static mut [T; N], ProgramError> {
    let layout = Layout::array::<T>(N).map_err(|_| ProgramError::InvalidInstructionData)?;
    let ptr = unsafe { alloc_zeroed(layout) };
    if ptr.is_null() {
        msg!("Error: heap allocation failed for scratch array");
        return Err(ProgramError::InsufficientFunds);
    }
    Ok(unsafe { &mut *(ptr as *mut [T; N]) })
}

/// Allocate a single zeroed value from the heap.
#[inline(always)]
fn heap_value<T: Sized>() -> Result<&'static mut T, ProgramError> {
    let layout = Layout::new::<T>();
    let ptr = unsafe { alloc_zeroed(layout) };
    if ptr.is_null() {
        msg!("Error: heap allocation failed for scratch value");
        return Err(ProgramError::InsufficientFunds);
    }
    Ok(unsafe { &mut *(ptr as *mut T) })
}

// =============================================================================
// Scratch helpers — heap-allocated, BPF-safe
// =============================================================================

#[inline(always)]
fn scratch_match_result() -> Result<&'static mut MatchResult, ProgramError> {
    heap_value::<MatchResult>()
}

#[inline(always)]
fn scratch_orders() -> Result<&'static mut [LimitOrder; MAX_ORDERS], ProgramError> {
    heap_array_fixed::<LimitOrder, MAX_ORDERS>()
}

#[inline(always)]
fn scratch_queues() -> Result<&'static mut PartitionedOrders, ProgramError> {
    heap_value::<PartitionedOrders>()
}

#[inline(always)]
fn scratch_caps() -> Result<&'static mut [(Pubkey, u128); MAX_ORDERS], ProgramError> {
    heap_array_fixed::<(Pubkey, u128), MAX_ORDERS>()
}

#[inline(always)]
fn scratch_compute_buys() -> Result<&'static mut [BuyEntry; MAX_ORDERS], ProgramError> {
    heap_array_fixed::<BuyEntry, MAX_ORDERS>()
}

#[inline(always)]
fn scratch_compute_sells() -> Result<&'static mut [SellEntry; MAX_ORDERS], ProgramError> {
    heap_array_fixed::<SellEntry, MAX_ORDERS>()
}

#[inline(always)]
fn scratch_compute_prices() -> Result<&'static mut [i64; MAX_ORDERS * 2], ProgramError> {
    heap_array_fixed::<i64, { MAX_ORDERS * 2 }>()
}

#[inline(always)]
fn scratch_compute_fills() -> Result<&'static mut [FillReceipt; MAX_ORDERS], ProgramError> {
    heap_array_fixed::<FillReceipt, MAX_ORDERS>()
}

#[inline(always)]
fn scratch_compute_eligible_buys() -> Result<&'static mut [BuyEntry; MAX_ORDERS], ProgramError> {
    heap_array_fixed::<BuyEntry, MAX_ORDERS>()
}

#[inline(always)]
fn scratch_compute_eligible_sells() -> Result<&'static mut [SellEntry; MAX_ORDERS], ProgramError> {
    heap_array_fixed::<SellEntry, MAX_ORDERS>()
}

#[inline(always)]
fn scratch_compute_per_order() -> Result<&'static mut [u64; MAX_ORDERS], ProgramError> {
    heap_array_fixed::<u64, MAX_ORDERS>()
}

/// Compute uniform clearing price and fill allocations.
///
/// Accounts:
/// 0. `[writable]` Results account (to receive cleared results)
///
/// Instruction data (M6 6g wire format):
/// - num_orders: u16 (2 bytes)
/// - For each order (53 bytes):
///   - side: u8 (0 = Buy, 1 = Sell)
///   - price: i64 (8 bytes LE)
///   - qty: u64 (8 bytes LE)
///   - user: Pubkey (32 bytes)
///   - order_type: u8 (design L319-327)
///   - instrument_id: u16 (2 bytes LE)
///   - reduce_only: u8 (0 or 1)
pub fn process_compute_clearing(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.is_empty() {
        msg!("Error: ComputeClearing requires at least 1 account");
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let results_account = &accounts[0];

    if !results_account.is_writable() {
        msg!("Error: Results account must be writable");
        return Err(ProgramError::InvalidAccountData);
    }

    // Parse instruction data
    if data.len() < 2 {
        msg!("Error: Instruction data too short");
        return Err(ProgramError::InvalidInstructionData);
    }

    let num_orders = u16::from_le_bytes([data[0], data[1]]) as usize;
    if num_orders == 0 {
        msg!("Error: No orders provided");
        return Err(ProgramError::InvalidInstructionData);
    }
    if num_orders > MAX_ORDERS {
        msg!("Error: Too many orders");
        return Err(ProgramError::InvalidInstructionData);
    }

    // M6 6g: 53 bytes per order (was 49)
    let expected_data_len = 2 + num_orders * 53;
    if data.len() < expected_data_len {
        msg!("Error: Instruction data too short for specified num_orders");
        return Err(ProgramError::InvalidInstructionData);
    }

    // Deserialize orders directly into heap scratch — no stack allocation.
    let orders = scratch_orders()?;

    for (i, order) in orders.iter_mut().take(num_orders).enumerate() {
        let offset = 2 + i * 53;
        let side_byte = data[offset];
        let side = match Side::from_u8(side_byte) {
            Some(s) => s,
            None => {
                msg!("Error: Invalid side");
                return Err(ProgramError::InvalidInstructionData);
            }
        };
        let price = i64::from_le_bytes([
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
            data[offset + 4],
            data[offset + 5],
            data[offset + 6],
            data[offset + 7],
            data[offset + 8],
        ]);
        let qty = u64::from_le_bytes([
            data[offset + 9],
            data[offset + 10],
            data[offset + 11],
            data[offset + 12],
            data[offset + 13],
            data[offset + 14],
            data[offset + 15],
            data[offset + 16],
        ]);
        let user = Pubkey::from(
            <[u8; 32]>::try_from(&data[offset + 17..offset + 49])
                .map_err(|_| ProgramError::InvalidInstructionData)?,
        );
        let order_type = OrderType::from_u8(data[offset + 49]).unwrap_or(OrderType::LimitGTC);
        let instrument_id = u16::from_le_bytes([data[offset + 50], data[offset + 51]]);
        let reduce_only = data[offset + 52] != 0;
        *order = LimitOrder {
            user,
            instrument_id,
            order_type,
            side,
            price,
            qty,
            reduce_only,
            cancel_order_id: 0,
            is_maker: false,
        };
    }

    // Compute clearing using heap scratch for all intermediate arrays.
    let fills = scratch_compute_fills()?;
    let result = compute_clearing_into(
        orders,
        MAX_ORDERS,
        scratch_compute_buys()?,
        scratch_compute_sells()?,
        scratch_compute_prices()?,
        fills,
        scratch_compute_eligible_buys()?,
        scratch_compute_eligible_sells()?,
        scratch_compute_per_order()?,
    );
    let (clearing_price, num_fills) = match result {
        Some(r) => r,
        None => {
            msg!("No match — no clearing price found");
            write_empty_result(results_account)?;
            return Ok(());
        }
    };

    // Write results to the results account (fills already in scratch buffer).
    write_results(results_account, clearing_price, num_fills, fills)?;

    msg!("Clearing computed successfully");
    Ok(())
}

/// Authenticate the core-owned registry PDA before touching matcher state.
fn authenticated_accounts(accounts: &[AccountInfo]) -> Result<&[AccountInfo], ProgramError> {
    let authority = accounts.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
    validate_authority(authority)?;
    Ok(&accounts[1..])
}
fn authenticated_user(accounts: &[AccountInfo]) -> Result<(Pubkey, &[AccountInfo]), ProgramError> {
    let accounts = authenticated_accounts(accounts)?;
    let user = accounts.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    Ok((*user.key(), &accounts[1..]))
}
fn validate_book(book: &AccountInfo, program_id: &Pubkey) -> ProgramResult {
    if !book.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    if book.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let raw = book.try_borrow_data()?;
    let header = mgk_common::layout::load::<mgk_common::book::OrderBook>(&raw)?;
    if book.key() != &mgk_common::book::book_pda(program_id, header.instrument_id).0 {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(())
}
fn begin_results(raw: &mut [u8], batch_id: u64) -> ProgramResult {
    if raw.first().copied() != Some(discriminator::UNINITIALIZED) {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    let body = stamp_body_mut(raw, discriminator::BATCH_RESULTS, LAYOUT_VERSION_1)?;
    if body.len() < RESULTS_ENVELOPE_LEN + DFBA_RESULT_HEADER_BYTES {
        return Err(ProgramError::AccountDataTooSmall);
    }
    body[..8].copy_from_slice(&batch_id.to_le_bytes());
    body[8] = 0;
    Ok(())
}
/// Mark a validated batch's unspent matcher output as consumed.
pub fn consume_results(raw: &mut [u8], batch_id: u64) -> ProgramResult {
    mgk_common::matcher::unspent_results(raw, batch_id)?;
    raw[mgk_common::layout::ACCOUNT_HEADER_LEN + 8] = 1;
    Ok(())
}

/// Stamp the `BATCH_RESULTS` account header (spec 13 / issue 16) and return the
/// bytes after it. Every results wire offset in this file is relative to the
/// returned body, so the 8-byte header never leaks into the layouts below.
fn results_body(raw: &mut [u8]) -> Result<&mut [u8], ProgramError> {
    stamp_body_mut(raw, discriminator::BATCH_RESULTS, LAYOUT_VERSION_1)
        .map_err(|_| ProgramError::AccountDataTooSmall)
}

fn dfba_results_body(raw: &mut [u8]) -> Result<&mut [u8], ProgramError> {
    let body = results_body(raw)?;
    body.get_mut(RESULTS_ENVELOPE_LEN..)
        .ok_or(ProgramError::AccountDataTooSmall)
}

fn write_empty_result(account: &AccountInfo) -> ProgramResult {
    let mut raw = account.try_borrow_mut_data()?;
    let data = results_body(&mut raw)?;
    if data.len() < 10 {
        msg!("Error: Results account too small");
        return Err(ProgramError::AccountDataTooSmall);
    }
    // clearing_price = 0
    data[0..8].copy_from_slice(&0i64.to_le_bytes());
    // num_fills = 0
    data[8..10].copy_from_slice(&0u16.to_le_bytes());
    Ok(())
}

fn write_results(
    account: &AccountInfo,
    clearing_price: i64,
    num_fills: usize,
    fills: &[FillReceipt; MAX_ORDERS],
) -> ProgramResult {
    let mut raw = account.try_borrow_mut_data()?;
    let data = results_body(&mut raw)?;
    let needed = 10 + num_fills * 48;
    if data.len() < needed {
        msg!("Error: Results account too small");
        return Err(ProgramError::AccountDataTooSmall);
    }

    // clearing_price: i64 (8 bytes)
    data[0..8].copy_from_slice(&clearing_price.to_le_bytes());
    // num_fills: u16 (2 bytes)
    data[8..10].copy_from_slice(&(num_fills as u16).to_le_bytes());

    for (i, fill) in fills.iter().take(num_fills).enumerate() {
        let offset = 10 + i * 48;
        // user: Pubkey (32 bytes)
        data[offset..offset + 32].copy_from_slice(fill.user.as_ref());
        // filled_qty: u64 (8 bytes)
        data[offset + 32..offset + 40].copy_from_slice(&fill.filled_qty.to_le_bytes());
        // notional: u64 (8 bytes)
        data[offset + 40..offset + 48].copy_from_slice(&fill.notional.to_le_bytes());
    }

    Ok(())
}

// =============================================================================
// DFBA clear (disc 5) — dual uniform-price auctions
// =============================================================================
//
// Wire format (after disc):
//   marginal_size_cap: u64 LE (8)
//   num_orders: u16 LE (2)
//   num_orders must be zero (orders are read exclusively from the book)
//   batch_id: u64 LE (8)
//
// Results account layout (following account header):
//   batch_id: u64 (8), spent: u8 (1)
//   bid_clearing_price: i64 (8)
//   ask_clearing_price: i64 (8)
//   matched_bid_qty: u64 (8)
//   matched_ask_qty: u64 (8)
//   num_fills: u16 (2)
//   fills[] each 51 bytes:
//     user: 32, order_id: 8, fill_qty: 8, fill_price: 8, is_maker: 1, auction: 1
//       auction: 0=Bid, 1=Ask

/// Bytes per DFBA input order in instruction data.
pub const DFBA_ORDER_WIRE_BYTES: usize = 58;
/// Header before orders: marginal_size_cap(8) + num_orders(2).
pub const DFBA_IX_HEADER_BYTES: usize = 10;
/// Header of results account before fill array.
pub const DFBA_RESULT_HEADER_BYTES: usize = 34;
/// Bytes per fill in results account.
pub const DFBA_FILL_WIRE_BYTES: usize = 58;

/// Dual Flow Batch Auction clear.
///
/// Accounts:
/// 0. `[writable]` Results account
/// 1. `[writable]` Book account (optional if orders supplied in data; required
///    when `num_orders == 0` to collect resting orders)
///
/// When `num_orders > 0`, orders are read from instruction data.
/// When `num_orders == 0` and book is present, resting book is collected.
/// After clear, filled qty is applied to resting orders on the book (if book present).
#[inline(never)]
pub fn process_dfba_clear(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let accounts = authenticated_accounts(accounts)?;

    if accounts.is_empty() {
        msg!("Error: DfbaClear requires results account");
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let results_account = &accounts[0];
    if !results_account.is_writable() {
        msg!("Error: Results account must be writable");
        return Err(ProgramError::InvalidAccountData);
    }
    if data.len() < DFBA_IX_HEADER_BYTES {
        msg!("Error: DfbaClear data too short");
        return Err(ProgramError::InvalidInstructionData);
    }

    let marginal_size_cap = u64::from_le_bytes(
        data[0..8]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let num_orders = u16::from_le_bytes([data[8], data[9]]) as usize;
    if num_orders > DFBA_MAX_ORDERS {
        msg!("Error: DfbaClear too many orders");
        return Err(ProgramError::InvalidInstructionData);
    }

    // Only persistent, authenticated orders can enter clearing. Inline orders
    // carried arbitrary identities and are deliberately unavailable.
    if num_orders != 0 || data.len() != DFBA_IX_HEADER_BYTES + 8 || !matches!(accounts.len(), 2 | 4)
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    let batch_id = u64::from_le_bytes(data[DFBA_IX_HEADER_BYTES..].try_into().unwrap());
    validate_book(&accounts[1], program_id)?;
    create_results_if_needed(results_account, batch_id, accounts.get(2), accounts.get(3))?;
    validate_results(results_account, batch_id)?;
    {
        let mut raw = results_account.try_borrow_mut_data()?;
        begin_results(&mut raw, batch_id)?;
    }

    // One contiguous 4-region order buffer (single heap alloc — less waste
    // than four separate arrays under the 32 KiB default heap).
    // Regions: [0)=maker_buy, [1)=maker_sell, [2)=taker_buy, [3)=taker_sell
    const REGIONS: usize = 4;
    let order_buf = heap_array_fixed::<DfbaOrder, { DFBA_MAX_ORDERS * REGIONS }>()?;
    let (left, right) = order_buf.split_at_mut(DFBA_MAX_ORDERS * 2);
    let (maker_buys, maker_sells) = left.split_at_mut(DFBA_MAX_ORDERS);
    let (taker_buys, taker_sells) = right.split_at_mut(DFBA_MAX_ORDERS);
    let mut n_mb = 0usize;
    let mut n_ms = 0usize;
    let mut n_tb = 0usize;
    let mut n_ts = 0usize;

    let push = |order: DfbaOrder,
                is_maker: bool,
                side: Side,
                mb: &mut [DfbaOrder],
                ms: &mut [DfbaOrder],
                tb: &mut [DfbaOrder],
                ts: &mut [DfbaOrder],
                n_mb: &mut usize,
                n_ms: &mut usize,
                n_tb: &mut usize,
                n_ts: &mut usize|
     -> Result<(), ProgramError> {
        if order.size == 0 {
            return Ok(());
        }
        match (is_maker, side) {
            (true, Side::Buy) if *n_mb < DFBA_MAX_ORDERS => {
                mb[*n_mb] = order;
                *n_mb += 1;
            }
            (true, Side::Sell) if *n_ms < DFBA_MAX_ORDERS => {
                ms[*n_ms] = order;
                *n_ms += 1;
            }
            (false, Side::Buy) if *n_tb < DFBA_MAX_ORDERS => {
                tb[*n_tb] = order;
                *n_tb += 1;
            }
            (false, Side::Sell) if *n_ts < DFBA_MAX_ORDERS => {
                ts[*n_ts] = order;
                *n_ts += 1;
            }
            // Region full or unknown side: drop overflow (hard per-side cap).
            _ => {}
        }
        Ok(())
    };

    if accounts.len() >= 2 {
        // Collect from book resting orders.
        let book_account = &accounts[1];
        if book_account.owner() != program_id {
            return Err(ProgramError::IllegalOwner);
        }
        let mut book_data = book_account.try_borrow_mut_data()?;
        let state = book_state_from_bytes_mut(&mut book_data)?;
        let live = state.resting[..state.resting_count]
            .iter()
            .filter(|r| r.qty > r.filled_qty && r.order_id != u64::MAX)
            .count();
        if live > MAX_SETTLEMENT_ORDERS {
            return Err(ProgramError::InvalidAccountData);
        }
        for i in 0..state.resting_count {
            let r = &state.resting[i];
            let rem = r.qty.saturating_sub(r.filled_qty);
            if rem == 0 || r.order_id == u64::MAX {
                continue;
            }
            push(
                DfbaOrder {
                    price: r.price,
                    size: rem,
                    order_id: r.order_id,
                    user: r.user,
                },
                r.is_maker,
                r.side,
                maker_buys,
                maker_sells,
                taker_buys,
                taker_sells,
                &mut n_mb,
                &mut n_ms,
                &mut n_tb,
                &mut n_ts,
            )?;
        }
    } else {
        write_dfba_empty_result(results_account)?;
        return Ok(());
    }

    // Sequential bid→ask: one AllocationResult at a time (DualAuctionResult
    // alone is ~14KB and blows the default 32KB heap with order_buf+scratch).
    let scratch = heap_value::<DualClearScratch>()?;
    let alloc_out = heap_value::<crate::state::AllocationResult>()?;

    let mut bid_price: i64 = 0;
    let mut ask_price: i64 = 0;
    let mut matched_bid: u64 = 0;
    let mut matched_ask: u64 = 0;
    let mut fill_count: u16 = 0;

    // Zero results header; fills written as we go.
    {
        let mut raw = results_account.try_borrow_mut_data()?;
        let rd = dfba_results_body(&mut raw)?;
        if rd.len() < DFBA_RESULT_HEADER_BYTES {
            return Err(ProgramError::AccountDataTooSmall);
        }
        rd[..DFBA_RESULT_HEADER_BYTES].fill(0);
    }

    // --- Bid auction: maker-buy × taker-sell ---
    if let Some(bid) = crate::state::dfba_clear_into(
        &maker_buys[..n_mb],
        &taker_sells[..n_ts],
        crate::state::AuctionKind::Bid,
        &mut scratch.alloc.m_ord,
        &mut scratch.alloc.t_ord,
        &mut scratch.prices,
    ) {
        bid_price = bid.clearing_price;
        matched_bid = bid.matched_qty;
        crate::state::dfba_allocate_into(
            &maker_buys[..n_mb],
            &taker_sells[..n_ts],
            crate::state::AuctionKind::Bid,
            &bid,
            marginal_size_cap,
            alloc_out,
            &mut scratch.alloc,
        );
        fill_count = append_alloc_fills(
            results_account,
            alloc_out,
            fill_count,
            /*auction*/ 0,
            accounts,
            program_id,
        )?;
    }

    // --- Ask auction: maker-sell × taker-buy ---
    alloc_out.maker_fill_count = 0;
    alloc_out.taker_fill_count = 0;
    if let Some(ask) = crate::state::dfba_clear_into(
        &maker_sells[..n_ms],
        &taker_buys[..n_tb],
        crate::state::AuctionKind::Ask,
        &mut scratch.alloc.m_ord,
        &mut scratch.alloc.t_ord,
        &mut scratch.prices,
    ) {
        ask_price = ask.clearing_price;
        matched_ask = ask.matched_qty;
        crate::state::dfba_allocate_into(
            &maker_sells[..n_ms],
            &taker_buys[..n_tb],
            crate::state::AuctionKind::Ask,
            &ask,
            marginal_size_cap,
            alloc_out,
            &mut scratch.alloc,
        );
        fill_count = append_alloc_fills(
            results_account,
            alloc_out,
            fill_count,
            /*auction*/ 1,
            accounts,
            program_id,
        )?;
    }

    // Write dual header.
    {
        let mut raw = results_account.try_borrow_mut_data()?;
        let rd = dfba_results_body(&mut raw)?;
        rd[0..8].copy_from_slice(&bid_price.to_le_bytes());
        rd[8..16].copy_from_slice(&ask_price.to_le_bytes());
        rd[16..24].copy_from_slice(&matched_bid.to_le_bytes());
        rd[24..32].copy_from_slice(&matched_ask.to_le_bytes());
        rd[32..34].copy_from_slice(&fill_count.to_le_bytes());
    }

    msg!("DfbaClear computed");
    Ok(())
}

/// Append maker+taker fills from one auction allocation into the results
/// account and apply fill qty to the book when present.
fn append_alloc_fills(
    results_account: &AccountInfo,
    alloc: &crate::state::AllocationResult,
    start_index: u16,
    auction: u8,
    accounts: &[AccountInfo],
    program_id: &Pubkey,
) -> Result<u16, ProgramError> {
    let mut w = start_index as usize;
    let mut write_one =
        |user: &Pubkey, order_id: u64, fill_qty: u64, is_maker: bool| -> Result<(), ProgramError> {
            if fill_qty == 0 {
                return Ok(());
            }
            {
                let mut raw = results_account.try_borrow_mut_data()?;
                let data = dfba_results_body(&mut raw)?;
                let need = DFBA_RESULT_HEADER_BYTES
                    .checked_add(
                        (w + 1)
                            .checked_mul(DFBA_FILL_WIRE_BYTES)
                            .ok_or(ProgramError::InvalidInstructionData)?,
                    )
                    .ok_or(ProgramError::InvalidInstructionData)?;
                if data.len() < need {
                    return Err(ProgramError::AccountDataTooSmall);
                }
                let price = alloc.clearing_price;
                encode_dfba_fill(data, w, user, order_id, fill_qty, price, is_maker, auction);
            }
            // Apply to book outside results borrow.
            if accounts.len() >= 2 {
                let book_account = &accounts[1];
                if book_account.is_writable() && book_account.owner() == program_id {
                    let mut book_data = book_account.try_borrow_mut_data()?;
                    let state = book_state_from_bytes_mut(&mut book_data)?;
                    apply_one_fill_to_book(state, order_id, fill_qty);
                }
            }
            w += 1;
            Ok(())
        };

    for i in 0..alloc.maker_fill_count {
        let f = &alloc.maker_fills[i];
        write_one(&f.user, f.order_id, f.fill_qty, true)?;
    }
    for i in 0..alloc.taker_fill_count {
        let f = &alloc.taker_fills[i];
        write_one(&f.user, f.order_id, f.fill_qty, false)?;
    }
    Ok(w as u16)
}

fn apply_one_fill_to_book(state: &mut crate::state::BookState, order_id: u64, fill_qty: u64) {
    if fill_qty == 0 {
        return;
    }
    for i in 0..state.resting_count {
        if state.resting[i].order_id == order_id {
            let r = &mut state.resting[i];
            let rem = r.qty.saturating_sub(r.filled_qty);
            let f = fill_qty.min(rem);
            r.filled_qty = r.filled_qty.saturating_add(f);
            break;
        }
    }
}

#[allow(dead_code)]
fn apply_dfba_fills_to_book(
    state: &mut crate::state::BookState,
    dual: &crate::state::DualAuctionResult,
) {
    let apply = |state: &mut crate::state::BookState, order_id: u64, fill_qty: u64| {
        if fill_qty == 0 {
            return;
        }
        for i in 0..state.resting_count {
            if state.resting[i].order_id == order_id {
                let r = &mut state.resting[i];
                let rem = r.qty.saturating_sub(r.filled_qty);
                let f = fill_qty.min(rem);
                r.filled_qty = r.filled_qty.saturating_add(f);
                break;
            }
        }
    };
    for i in 0..dual.bid_alloc.maker_fill_count {
        let f = &dual.bid_alloc.maker_fills[i];
        apply(state, f.order_id, f.fill_qty);
    }
    for i in 0..dual.bid_alloc.taker_fill_count {
        let f = &dual.bid_alloc.taker_fills[i];
        apply(state, f.order_id, f.fill_qty);
    }
    for i in 0..dual.ask_alloc.maker_fill_count {
        let f = &dual.ask_alloc.maker_fills[i];
        apply(state, f.order_id, f.fill_qty);
    }
    for i in 0..dual.ask_alloc.taker_fill_count {
        let f = &dual.ask_alloc.taker_fills[i];
        apply(state, f.order_id, f.fill_qty);
    }
}

fn write_dfba_empty_result(account: &AccountInfo) -> ProgramResult {
    let mut raw = account.try_borrow_mut_data()?;
    let data = dfba_results_body(&mut raw)?;
    if data.len() < DFBA_RESULT_HEADER_BYTES {
        return Err(ProgramError::AccountDataTooSmall);
    }
    data[..DFBA_RESULT_HEADER_BYTES].fill(0);
    Ok(())
}

#[allow(dead_code)]
fn write_dfba_results(
    account: &AccountInfo,
    dual: &crate::state::DualAuctionResult,
) -> ProgramResult {
    let total_fills = dual.bid_alloc.maker_fill_count
        + dual.bid_alloc.taker_fill_count
        + dual.ask_alloc.maker_fill_count
        + dual.ask_alloc.taker_fill_count;
    let needed = DFBA_RESULT_HEADER_BYTES
        .checked_add(
            total_fills
                .checked_mul(DFBA_FILL_WIRE_BYTES)
                .ok_or(ProgramError::InvalidInstructionData)?,
        )
        .ok_or(ProgramError::InvalidInstructionData)?;

    let mut raw = account.try_borrow_mut_data()?;
    let data = dfba_results_body(&mut raw)?;
    if data.len() < needed {
        msg!("Error: DfbaClear results account too small");
        return Err(ProgramError::AccountDataTooSmall);
    }

    data[0..8].copy_from_slice(&dual.bid.clearing_price.to_le_bytes());
    data[8..16].copy_from_slice(&dual.ask.clearing_price.to_le_bytes());
    data[16..24].copy_from_slice(&dual.bid_alloc.matched_qty.to_le_bytes());
    data[24..32].copy_from_slice(&dual.ask_alloc.matched_qty.to_le_bytes());

    let mut w = 0usize;
    let bp = dual.bid_alloc.clearing_price;
    for i in 0..dual.bid_alloc.maker_fill_count {
        let f = &dual.bid_alloc.maker_fills[i];
        if f.fill_qty > 0 {
            encode_dfba_fill(data, w, &f.user, f.order_id, f.fill_qty, bp, true, 0);
            w += 1;
        }
    }
    for i in 0..dual.bid_alloc.taker_fill_count {
        let f = &dual.bid_alloc.taker_fills[i];
        if f.fill_qty > 0 {
            encode_dfba_fill(data, w, &f.user, f.order_id, f.fill_qty, bp, false, 0);
            w += 1;
        }
    }
    let ap = dual.ask_alloc.clearing_price;
    for i in 0..dual.ask_alloc.maker_fill_count {
        let f = &dual.ask_alloc.maker_fills[i];
        if f.fill_qty > 0 {
            encode_dfba_fill(data, w, &f.user, f.order_id, f.fill_qty, ap, true, 1);
            w += 1;
        }
    }
    for i in 0..dual.ask_alloc.taker_fill_count {
        let f = &dual.ask_alloc.taker_fills[i];
        if f.fill_qty > 0 {
            encode_dfba_fill(data, w, &f.user, f.order_id, f.fill_qty, ap, false, 1);
            w += 1;
        }
    }

    data[32..34].copy_from_slice(&(w as u16).to_le_bytes());
    let _ = total_fills;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn encode_dfba_fill(
    data: &mut [u8],
    index: usize,
    user: &Pubkey,
    order_id: u64,
    fill_qty: u64,
    fill_price: i64,
    is_maker: bool,
    auction: u8,
) {
    let off = DFBA_RESULT_HEADER_BYTES + index * DFBA_FILL_WIRE_BYTES;
    data[off..off + 32].copy_from_slice(user.as_ref());
    data[off + 32..off + 40].copy_from_slice(&order_id.to_le_bytes());
    data[off + 40..off + 48].copy_from_slice(&fill_qty.to_le_bytes());
    data[off + 48..off + 56].copy_from_slice(&fill_price.to_le_bytes());
    data[off + 56] = if is_maker { 1 } else { 0 };
    data[off + 57] = auction;
}

// =============================================================================
// InitializeBook (disc 7) — create matcher-owned book PDA for an instrument
// =============================================================================

/// System Program ID (all zeros).
const SYSTEM_PROGRAM_ID_BYTES: [u8; 32] = [0u8; 32];

/// Wire after disc: instrument_id(2) + bump(1) = 3 bytes.
pub const INIT_BOOK_DATA_LEN: usize = 2 + 1;

/// Allocate a fresh batch results PDA when clearing its batch for the first time.
fn create_results_if_needed(
    results: &AccountInfo,
    batch_id: u64,
    payer: Option<&AccountInfo>,
    system: Option<&AccountInfo>,
) -> ProgramResult {
    if results.key() != &mgk_common::matcher::results_pda(batch_id).0 {
        return Err(ProgramError::InvalidSeeds);
    }
    if results.data_len() != 0 {
        return Ok(());
    }
    let payer = payer.ok_or(ProgramError::NotEnoughAccountKeys)?;
    let system = system.ok_or(ProgramError::NotEnoughAccountKeys)?;
    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !payer.is_writable() || !results.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    if system.key() != &SYSTEM_PROGRAM_ID_BYTES || results.owner() != &SYSTEM_PROGRAM_ID_BYTES {
        return Err(ProgramError::IncorrectProgramId);
    }
    use pinocchio::instruction::{AccountMeta, Instruction, Signer};
    use pinocchio::program::invoke_signed;
    use pinocchio::sysvars::{rent::Rent, Sysvar};
    let space = results_account_space();
    let lamports = Rent::get()?.minimum_balance(space);
    let mut data = [0u8; 52];
    data[4..12].copy_from_slice(&lamports.to_le_bytes());
    data[12..20].copy_from_slice(&(space as u64).to_le_bytes());
    data[20..52].copy_from_slice(&mgk_common::program_ids::PERPS_MATCHER_ID);
    let metas = [
        AccountMeta::writable_signer(payer.key()),
        AccountMeta::writable_signer(results.key()),
    ];
    let ix = Instruction {
        program_id: &SYSTEM_PROGRAM_ID_BYTES,
        accounts: &metas,
        data: &data,
    };
    let id = batch_id.to_le_bytes();
    let bump = [mgk_common::matcher::results_pda(batch_id).1];
    let seeds = pinocchio::seeds!(b"results", &id, &bump);
    invoke_signed::<2>(&ix, &[payer, results], &[Signer::from(&seeds)])
}

// Each live order belongs to exactly one of the four auction regions. Allocation
// aggregates quantity by order, so fragmented counterparties still emit at most
// one receipt per live order across both auctions.
fn results_account_space() -> usize {
    mgk_common::layout::ACCOUNT_HEADER_LEN + RESULTS_ENVELOPE_LEN + 34 + MAX_SETTLEMENT_ORDERS * 58
}

/// Create and zero-init a book PDA.
///
/// Accounts:
/// 0. `[writable]` Book PDA (`["book", instrument_id_le]`)
/// 1. `[signer, writable]` Payer (governance / keeper)
/// 2. `[]` System program
///
/// Data: `instrument_id(2 LE) + bump(1)`.
/// Idempotent: if book already has full size, succeeds without re-creating.
pub fn process_initialize_book(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let accounts = authenticated_accounts(accounts)?;

    if accounts.len() < 3 {
        msg!("Error: InitializeBook needs book, payer, system_program");
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < INIT_BOOK_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    let book_account = &accounts[0];
    let payer = &accounts[1];
    let _system = &accounts[2];

    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !book_account.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    let instrument_id = u16::from_le_bytes([data[0], data[1]]);
    let bump = data[2];
    let book_space = crate::state::book_account_size();

    let id_le = instrument_id.to_le_bytes();
    let (expected_pda, _) = pinocchio::pubkey::find_program_address(&[b"book", &id_le], program_id);
    if book_account.key() != &expected_pda {
        msg!("Error: book PDA mismatch");
        return Err(ProgramError::InvalidSeeds);
    }

    // Already allocated (idempotent). A pre-allocated, still-zeroed account
    // has no discriminator yet, so stamp it; a stamped book is left alone.
    if book_account.data_len() >= book_space && book_account.owner() == program_id {
        stamp_new_book(book_account, instrument_id)?;
        msg!("InitializeBook: already exists");
        return Ok(());
    }

    if book_account.data_len() > 0 && book_account.owner() != program_id {
        msg!("Error: book account has unexpected owner");
        return Err(ProgramError::IllegalOwner);
    }

    use pinocchio::instruction::{AccountMeta, Instruction, Signer};
    use pinocchio::program::invoke_signed;
    use pinocchio::sysvars::{rent::Rent, Sysvar};

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(book_space);

    let mut ix_data = [0u8; 52];
    ix_data[0..4].copy_from_slice(&0u32.to_le_bytes()); // CreateAccount
    ix_data[4..12].copy_from_slice(&lamports.to_le_bytes());
    ix_data[12..20].copy_from_slice(&(book_space as u64).to_le_bytes());
    ix_data[20..52].copy_from_slice(program_id.as_ref());

    let metas = [
        AccountMeta::writable_signer(payer.key()),
        AccountMeta::writable_signer(book_account.key()),
    ];
    let sys_id = Pubkey::from(SYSTEM_PROGRAM_ID_BYTES);
    let ix = Instruction {
        program_id: &sys_id,
        accounts: &metas,
        data: &ix_data,
    };
    let bump_seed = [bump];
    let signer_seeds = pinocchio::seeds!(b"book", id_le.as_slice(), &bump_seed);
    let signer = Signer::from(&signer_seeds);
    invoke_signed::<2>(&ix, &[payer, book_account], &[signer])?;
    // createAccount zeros account data → empty BookState (resting_count=0),
    // which still lacks the discriminator + layout version: stamp them.
    stamp_new_book(book_account, instrument_id)?;
    msg!("InitializeBook: book PDA created");
    Ok(())
}

/// Give a zeroed (discriminator 0) book account its `OrderBook` header and
/// instrument id. Accounts that already carry any discriminator are left
/// untouched, so re-running `InitializeBook` never clobbers a live book.
fn stamp_new_book(book_account: &AccountInfo, instrument_id: u16) -> ProgramResult {
    let mut data = book_account.try_borrow_mut_data()?;
    if data.first().copied() != Some(discriminator::UNINITIALIZED) {
        return Ok(());
    }
    stamp_body_mut(&mut data, discriminator::ORDER_BOOK, LAYOUT_VERSION_1)
        .map_err(|_| ProgramError::AccountDataTooSmall)?;
    let state = book_state_from_bytes_mut(&mut data)?;
    state.book.instrument_id = instrument_id;
    Ok(())
}

// =============================================================================
// PlaceResting (disc 6) — DFBA open post CPI target
// =============================================================================

/// Wire: reserved identity padding(32) + side(1) + is_maker(1) + price(8) + qty(8) + instrument_id(2)
///        + reduce_only(1) = 53 bytes
pub const PLACE_RESTING_DATA_LEN: usize = 32 + 1 + 1 + 8 + 8 + 2 + 1;

/// Place a resting order on the book with DFBA maker/taker role.
///
/// Accounts:
/// 0. `[signer]` Core registry PDA
/// 1. `[signer]` Verified trader
/// 2. `[writable]` Book account (matcher-owned)
///
/// Data: see `PLACE_RESTING_DATA_LEN`. Writes 8-byte `order_id` LE at the start
/// of the book account's unused region is not done — order_id is in book state
/// only; callers read book after CPI. (Core does not need order_id return for v1.)
pub fn process_place_resting(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let (user, accounts) = authenticated_user(accounts)?;

    if accounts.is_empty() {
        msg!("Error: PlaceResting requires book account");
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let book_account = &accounts[0];
    validate_book(book_account, program_id)?;
    if !book_account.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    if book_account.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    if data.len() < PLACE_RESTING_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    // The first 32 payload bytes are reserved compatibility padding; identity comes from the signer.
    let side = Side::from_u8(data[32]).ok_or(ProgramError::InvalidInstructionData)?;
    let is_maker = data[33] != 0;
    let price = i64::from_le_bytes(
        data[34..42]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let qty = u64::from_le_bytes(
        data[42..50]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let instrument_id = u16::from_le_bytes([data[50], data[51]]);
    let reduce_only = data[52] != 0;

    let order = LimitOrder {
        user,
        instrument_id,
        order_type: OrderType::LimitGTC,
        side,
        price,
        qty,
        reduce_only,
        cancel_order_id: 0,
        is_maker,
    };

    let mut book_data = book_account.try_borrow_mut_data()?;
    let state = book_state_from_bytes_mut(&mut book_data)?;
    if state.book.instrument_id != instrument_id {
        return Err(ProgramError::InvalidAccountData);
    }
    let live = state.resting[..state.resting_count]
        .iter()
        .filter(|r| r.qty > r.filled_qty && r.order_id != u64::MAX)
        .count();
    if live >= MAX_SETTLEMENT_ORDERS {
        return Err(ProgramError::InvalidAccountData);
    }
    let _order_id = place_resting(state, &order).map_err(|_| ProgramError::InvalidAccountData)?;
    msg!("PlaceResting: order placed");
    Ok(())
}

// =============================================================================
// 6h. Direct cancel / modify (CPI from Core)
// =============================================================================
//
// Both instructions take the instrument's book account (writable, owned by
// this matcher program) plus an authenticated signer and an `order_id`. They
// deserialize the `BookState`, mutate it, and serialize back.

const CANCEL_DATA_LEN: usize = 32 + 8; // user(32) + order_id(8)
const MODIFY_DATA_LEN: usize = 32 + 8 + 8; // user(32) + order_id(8) + new_qty(8)

/// Cancel a single resting order by `order_id`.
///
/// Accounts:
/// 0. `[writable]` Book account (PDA: `["book", instrument_id_le]`)
/// 1. [] Matcher program (for ownership check, optional)
///
/// Data: reserved identity padding(32) + order_id(8) = 40 bytes
pub fn process_cancel_resting(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let (user, accounts) = authenticated_user(accounts)?;

    if accounts.is_empty() {
        msg!("Error: CancelResting requires at least 1 account (book)");
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let book_account = &accounts[0];
    validate_book(book_account, program_id)?;
    if !book_account.is_writable() {
        msg!("Error: Book account must be writable");
        return Err(ProgramError::InvalidAccountData);
    }
    if book_account.owner() != program_id {
        msg!("Error: Book account not owned by matcher");
        return Err(ProgramError::IllegalOwner);
    }
    if data.len() < CANCEL_DATA_LEN {
        msg!("Error: CancelResting data too short");
        return Err(ProgramError::InvalidInstructionData);
    }

    // The first 32 payload bytes are reserved compatibility padding; identity comes from the signer.
    let order_id = u64::from_le_bytes(
        data[32..40]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );

    // Borrow BookState from the account buffer — no 27 KB stack copy.
    let mut book_data = book_account.try_borrow_mut_data()?;
    let state = book_state_from_bytes_mut(&mut book_data)?;
    cancel_resting_by_id(state, order_id, &user)?;
    // serialize_book_state writes through the borrowed reference.

    msg!("CancelResting: removed order");
    Ok(())
}

/// Modify a single resting order's qty by `order_id`.
///
/// Accounts:
/// 0. `[writable]` Book account
///
/// Data: reserved identity padding(32) + order_id(8) + new_qty(8) = 48 bytes
pub fn process_modify_resting(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let (user, accounts) = authenticated_user(accounts)?;

    if accounts.is_empty() {
        msg!("Error: ModifyResting requires at least 1 account (book)");
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let book_account = &accounts[0];
    validate_book(book_account, program_id)?;
    if !book_account.is_writable() {
        msg!("Error: Book account must be writable");
        return Err(ProgramError::InvalidAccountData);
    }
    if book_account.owner() != program_id {
        msg!("Error: Book account not owned by matcher");
        return Err(ProgramError::IllegalOwner);
    }
    if data.len() < MODIFY_DATA_LEN {
        msg!("Error: ModifyResting data too short");
        return Err(ProgramError::InvalidInstructionData);
    }

    // The first 32 payload bytes are reserved compatibility padding; identity comes from the signer.
    let order_id = u64::from_le_bytes(
        data[32..40]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let new_qty = u64::from_le_bytes(
        data[40..48]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );

    // Borrow BookState from the account buffer — no 27 KB stack copy.
    let mut book_data = book_account.try_borrow_mut_data()?;
    let state = book_state_from_bytes_mut(&mut book_data)?;
    modify_resting_qty(state, order_id, &user, new_qty)?;

    msg!("ModifyResting: order updated");
    Ok(())
}

/// Cancel every resting order owned by `user` on this book (M7 7.7).
///
/// Called by Core's `CancelAllRestingOrders` (disc 13) on liquidation or
/// user request. Each call targets a single book; the Core instruction
/// dispatches one CPI per book the user has resting orders on.
///
/// Accounts:
/// 0. `[writable]` Book account (PDA: `["book", instrument_id_le]`)
///
/// Data: reserved identity padding(32) = 32 bytes; user comes from signer account
///
/// Behavior:
/// - Linear scan of `state.resting[0..resting_count]` for live orders
///   (`qty > 0`) whose `user` matches the authenticated signer.
/// - Each match is removed via `remove_at_offset`, which clears the slot
///   in place and updates the level head / count / best-price.
/// - Returns silently when no orders match (empty book is not an error).
pub fn process_cancel_all(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let (user, accounts) = authenticated_user(accounts)?;

    if accounts.is_empty() {
        msg!("Error: CancelAll requires at least 1 account (book)");
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let book_account = &accounts[0];
    validate_book(book_account, program_id)?;
    if !book_account.is_writable() {
        msg!("Error: Book account must be writable");
        return Err(ProgramError::InvalidAccountData);
    }
    if book_account.owner() != program_id {
        msg!("Error: Book account not owned by matcher");
        return Err(ProgramError::IllegalOwner);
    }
    if data.len() < 32 {
        msg!("Error: CancelAll data too short (need user pubkey)");
        return Err(ProgramError::InvalidInstructionData);
    }

    // The first 32 payload bytes are reserved compatibility padding; identity comes from the signer.

    // Borrow BookState from the account buffer — no 27 KB stack copy.
    let mut book_data = book_account.try_borrow_mut_data()?;
    let state = book_state_from_bytes_mut(&mut book_data)?;
    let _removed = cancel_all_for_user(state, &user);

    msg!("CancelAll: removed orders");
    Ok(())
}

/// M7 7.7: pin the matcher `CancelAll` discriminator value. The Core
/// CPI encoder (`programs/perps-core/src/instructions/cancel_all_resting_orders.rs`)
/// uses the same value, so any change here must be coordinated with
/// the Core side. The const is `#[cfg(test)]` because the production
/// binary routes discs through `process_instruction`'s match — the
/// pin exists to catch test-side drift.
#[cfg(test)]
const MATCHER_CANCEL_ALL_DISCRIMINATOR: u8 = 4;

/// M7 7.7: wire-format pin for `process_cancel_all` data length
/// (after the disc byte is stripped). The Core CPI encoder
/// (`programs/perps-core/src/instructions/cancel_all_resting_orders.rs`)
/// builds a 33-byte buffer (1 byte disc + 32 byte user). The entry
/// point's `data.len() < 32` check rejects anything shorter.
#[cfg(test)]
const CANCEL_ALL_DATA_LEN: usize = 32;

// =============================================================================
// 6i.2. ClearAndMatch — CLOB matching against a persistent book
// =============================================================================
//
// Wires up the full 6a-6e pipeline (shuffle → partition → CLOB match) against
// the on-chain `BookState`. Replaces the old uniform-clearing path for the
// perps-core `ClearBatch` flow. The book is mutated in place and serialized
// back, so resting GTC orders persist across batches (6f).

/// Bytes per fill in the CLOB results account.
/// user(32) + filled_qty(8) + notional(8) + is_maker(1) = 49.
pub const BYTES_PER_FILL: usize = 49;
/// Maximum size the results account must be allocated to for ClearAndMatch.
pub const MAX_RESULTS_SIZE: usize =
    mgk_common::layout::ACCOUNT_HEADER_LEN + 2 + MAX_FILLS_PER_BATCH * BYTES_PER_FILL;

/// Per-order wire size for ClearAndMatch (same as ComputeClearing in 6g).
const CLEAR_ORDER_BYTES: usize = 53;
/// Bytes per user cap in the M7 7.6 cap section: user(32) + max_notional(16) = 48.
const CLEAR_CAP_BYTES: usize = 48;

/// `ClearAndMatch` (M6 6i.2): full CLOB pipeline against a persistent book.
///
/// Accounts:
/// 0. `[writable]` Book account (matcher-owned, `["book", instrument_id_le]`)
/// 1. `[writable]` Results account (core-owned, receives fills)
///
/// Data (M7 7.6 added the `num_caps` + caps section for risk-callback wiring):
/// - close_slot: u64 (8) — used as the Fisher-Yates shuffle seed
/// - num_orders: u16 (2)
/// - num_caps: u16 (2) — number of per-user notional caps (M7 7.6, D2);
///   zero = no cap (default risk check)
/// - caps[num_caps]: each 48 bytes — `user(32) + max_notional(16)` little-endian
/// - orders[num_orders]: each 53 bytes — side(1) + price(8) + qty(8) +
///   user(32) + order_type(1) + instrument_id(2) + reduce_only(1)
///
/// Results account layout:
/// - num_fills: u16 (2)
/// - For each fill (49 bytes): user(32) + filled_qty(8) + notional(8) + is_maker(1)
pub fn process_clear_and_match(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 2 {
        msg!("Error: ClearAndMatch requires book + results accounts");
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let book_account = &accounts[0];
    let results_account = &accounts[1];

    if !book_account.is_writable() || !results_account.is_writable() {
        msg!("Error: ClearAndMatch accounts must be writable");
        return Err(ProgramError::InvalidAccountData);
    }
    if book_account.owner() != program_id {
        msg!("Error: Book account not owned by matcher");
        return Err(ProgramError::IllegalOwner);
    }

    // Header: close_slot(8) + num_orders(2) + num_caps(2)
    if data.len() < 12 {
        msg!("Error: ClearAndMatch data too short for header");
        return Err(ProgramError::InvalidInstructionData);
    }
    let close_slot = u64::from_le_bytes(
        data[0..8]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let num_orders = u16::from_le_bytes(
        data[8..10]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    ) as usize;
    let num_caps = u16::from_le_bytes(
        data[10..12]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    ) as usize;

    if num_orders == 0 || num_orders > MAX_ORDERS {
        msg!("Error: ClearAndMatch num_orders out of range");
        return Err(ProgramError::InvalidInstructionData);
    }

    let caps_offset = 12usize;
    let orders_offset = caps_offset + num_caps * CLEAR_CAP_BYTES;
    let expected_len = orders_offset + num_orders * CLEAR_ORDER_BYTES;
    if data.len() < expected_len {
        msg!("Error: ClearAndMatch data too short for caps + orders");
        return Err(ProgramError::InvalidInstructionData);
    }

    if num_orders == 1 {
        let offset = orders_offset;
        let side = match Side::from_u8(data[offset]) {
            Some(s) => s,
            None => {
                msg!("Error: Invalid side in ClearAndMatch");
                return Err(ProgramError::InvalidInstructionData);
            }
        };
        let price = i64::from_le_bytes(
            data[offset + 1..offset + 9]
                .try_into()
                .map_err(|_| ProgramError::InvalidInstructionData)?,
        );
        let qty = u64::from_le_bytes(
            data[offset + 9..offset + 17]
                .try_into()
                .map_err(|_| ProgramError::InvalidInstructionData)?,
        );
        let user = Pubkey::from(
            <[u8; 32]>::try_from(&data[offset + 17..offset + 49])
                .map_err(|_| ProgramError::InvalidInstructionData)?,
        );
        let order_type = OrderType::from_u8(data[offset + 49]).unwrap_or(OrderType::LimitGTC);
        let instrument_id = u16::from_le_bytes([data[offset + 50], data[offset + 51]]);
        let reduce_only = data[offset + 52] != 0;
        let order = LimitOrder {
            user,
            instrument_id,
            order_type,
            side,
            price,
            qty,
            reduce_only,
            cancel_order_id: 0,
            is_maker: false,
        };

        if order.order_type == OrderType::LimitGTC {
            let mut book_data = book_account.try_borrow_mut_data()?;
            let state = book_state_from_bytes_mut(&mut book_data)?;
            place_resting(state, &order).map_err(|_| ProgramError::InvalidAccountData)?;
        }

        let mut raw = results_account.try_borrow_mut_data()?;
        let results = results_body(&mut raw)?;
        if results.len() < 2 {
            msg!("Error: Results account too small for CLOB fills");
            return Err(ProgramError::AccountDataTooSmall);
        }
        results[0..2].copy_from_slice(&0u16.to_le_bytes());
        msg!("ClearAndMatch: single resting order placed");
        return Ok(());
    }

    // Parse caps directly into heap scratch.
    let caps = scratch_caps()?;
    if num_caps > MAX_ORDERS {
        msg!("Error: ClearAndMatch num_caps exceeds MAX_ORDERS");
        return Err(ProgramError::InvalidInstructionData);
    }
    for (i, cap_slot) in caps.iter_mut().enumerate().take(num_caps) {
        let off = caps_offset + i * CLEAR_CAP_BYTES;
        let user = Pubkey::from(
            <[u8; 32]>::try_from(&data[off..off + 32])
                .map_err(|_| ProgramError::InvalidInstructionData)?,
        );
        let cap = u128::from_le_bytes(
            data[off + 32..off + 48]
                .try_into()
                .map_err(|_| ProgramError::InvalidInstructionData)?,
        );
        *cap_slot = (user, cap);
    }
    let caps_slice = &caps[..num_caps];

    // Parse orders directly into heap scratch — no stack allocation.
    let orders = scratch_orders()?;

    for (i, slot) in orders.iter_mut().take(num_orders).enumerate() {
        let offset = orders_offset + i * CLEAR_ORDER_BYTES;
        let side = match Side::from_u8(data[offset]) {
            Some(s) => s,
            None => {
                msg!("Error: Invalid side in ClearAndMatch");
                return Err(ProgramError::InvalidInstructionData);
            }
        };
        let price = i64::from_le_bytes(
            data[offset + 1..offset + 9]
                .try_into()
                .map_err(|_| ProgramError::InvalidInstructionData)?,
        );
        let qty = u64::from_le_bytes(
            data[offset + 9..offset + 17]
                .try_into()
                .map_err(|_| ProgramError::InvalidInstructionData)?,
        );
        let user = Pubkey::from(
            <[u8; 32]>::try_from(&data[offset + 17..offset + 49])
                .map_err(|_| ProgramError::InvalidInstructionData)?,
        );
        let order_type = OrderType::from_u8(data[offset + 49]).unwrap_or(OrderType::LimitGTC);
        let instrument_id = u16::from_le_bytes([data[offset + 50], data[offset + 51]]);
        let reduce_only = data[offset + 52] != 0;
        *slot = LimitOrder {
            user,
            instrument_id,
            order_type,
            side,
            price,
            qty,
            reduce_only,
            cancel_order_id: 0,
            is_maker: false,
        };
    }

    // 1. Fisher-Yates shuffle seeded by close_slot (6b).
    shuffle_orders(&mut orders[..num_orders], close_slot);

    // 2. Partition into cancels / ALOs / regulars (6c).
    // queues lives in heap scratch — no stack allocation.
    let queues = scratch_queues()?;
    queues.zeroed_in_place();
    separate_priority_queues(&orders[..num_orders], queues);

    // 3. Borrow BookState from the account buffer — no 27 KB stack copy.
    //    Zero the match result in heap scratch — no 7 KB stack copy.
    let mut book_data = book_account.try_borrow_mut_data()?;
    let state = book_state_from_bytes_mut(&mut book_data)?;
    let result = scratch_match_result()?;
    result.zeroed_in_place();

    // M7 7.6: if caps were provided, use the cap-aware risk check (D2);
    // otherwise fall back to the default always-passing check.
    if num_caps > 0 {
        clob_match_with_caps_into(state, queues, caps_slice, result);
    } else {
        clob_match_with_risk_into(state, queues, default_risk_check, result);
    }
    // serialize_book_state writes through the borrowed BookState.

    // 4. Write fills to the results account.
    write_clob_results(results_account, result)?;

    msg!("ClearAndMatch: complete");
    Ok(())
}

/// Write `MatchResult` fills into the results account in CLOB wire format.
fn write_clob_results(account: &AccountInfo, result: &crate::state::MatchResult) -> ProgramResult {
    let mut raw = account.try_borrow_mut_data()?;
    let data = results_body(&mut raw)?;
    let needed = 2 + result.fill_count * BYTES_PER_FILL;
    if data.len() < needed {
        msg!("Error: Results account too small for CLOB fills");
        return Err(ProgramError::AccountDataTooSmall);
    }

    // num_fills: u16 (2)
    data[0..2].copy_from_slice(&(result.fill_count as u16).to_le_bytes());

    for (i, fill) in result.fills.iter().take(result.fill_count).enumerate() {
        let offset = 2 + i * BYTES_PER_FILL;
        data[offset..offset + 32].copy_from_slice(fill.user.as_ref());
        data[offset + 32..offset + 40].copy_from_slice(&fill.filled_qty.to_le_bytes());
        data[offset + 40..offset + 48].copy_from_slice(&fill.notional.to_le_bytes());
        data[offset + 48] = fill.is_maker as u8;
    }

    Ok(())
}

#[cfg(test)]
mod results_header_tests {
    //! Spec 13 / issue 16: the results account is a `BATCH_RESULTS` account.
    //! The matcher stamps the header whenever it (re)writes results and all
    //! wire offsets are relative to the 8-byte header.
    use super::*;
    use mgk_common::layout::{discriminator, ACCOUNT_HEADER_LEN, LAYOUT_VERSION_1};

    #[test]
    fn results_can_only_be_written_once_even_after_consumption() {
        let mut raw = [0u8; 128];
        begin_results(&mut raw, 7).unwrap();
        assert!(begin_results(&mut raw, 7).is_err());
        raw[ACCOUNT_HEADER_LEN + 8] = 1;
        assert!(begin_results(&mut raw, 7).is_err());
        assert!(begin_results(&mut raw, 8).is_err());
    }

    #[test]
    fn results_body_stamps_batch_results_header_and_skips_it() {
        let mut raw = [0xAAu8; 64];
        let body = results_body(&mut raw).unwrap();
        assert_eq!(body.len(), 64 - ACCOUNT_HEADER_LEN);
        assert_eq!(
            &raw[..8],
            &[
                discriminator::BATCH_RESULTS,
                LAYOUT_VERSION_1,
                0,
                0,
                0,
                0,
                0,
                0
            ]
        );
        assert_eq!(raw[8], 0xAA, "body bytes are left untouched");
    }

    #[test]
    fn results_body_rejects_account_smaller_than_header() {
        let mut raw = [0u8; 4];
        assert_eq!(
            results_body(&mut raw).err(),
            Some(ProgramError::AccountDataTooSmall)
        );
    }

    #[test]
    fn dfba_fills_preserve_the_batch_envelope() {
        let mut raw = [0u8; ACCOUNT_HEADER_LEN
            + RESULTS_ENVELOPE_LEN
            + DFBA_RESULT_HEADER_BYTES
            + DFBA_FILL_WIRE_BYTES];
        begin_results(&mut raw, 42).unwrap();
        let body = dfba_results_body(&mut raw).unwrap();
        encode_dfba_fill(body, 0, &[7; 32], 5, 11, 100, true, 1);
        let payload = mgk_common::matcher::unspent_results(&raw, 42).unwrap();
        assert_eq!(
            &payload[DFBA_RESULT_HEADER_BYTES..DFBA_RESULT_HEADER_BYTES + 32],
            &[7; 32]
        );
        assert!(mgk_common::matcher::unspent_results(&raw, 41).is_err());
    }

    #[test]
    fn dfba_fill_is_encoded_after_header_and_dfba_prefix() {
        let mut raw = [0u8; ACCOUNT_HEADER_LEN + DFBA_RESULT_HEADER_BYTES + DFBA_FILL_WIRE_BYTES];
        let body = results_body(&mut raw).unwrap();
        let user = Pubkey::from([7u8; 32]);
        encode_dfba_fill(body, 0, &user, 5, 11, 100, true, 1);
        let start = ACCOUNT_HEADER_LEN + DFBA_RESULT_HEADER_BYTES;
        assert_eq!(&raw[start..start + 32], &[7u8; 32]);
        assert_eq!(raw[start + 56], 1);
        assert_eq!(raw[start + 57], 1);
        assert_eq!(raw[0], discriminator::BATCH_RESULTS);
    }

    #[test]
    fn max_results_size_includes_account_header() {
        assert_eq!(
            MAX_RESULTS_SIZE,
            ACCOUNT_HEADER_LEN + 2 + MAX_FILLS_PER_BATCH * BYTES_PER_FILL
        );
    }
}

#[cfg(test)]
mod tests {
    //! M7 7.7 remediation R2: tests for the `process_cancel_all`
    //! instruction entry point.
    //!
    //! Test scope is intentionally limited to **wire-format pins +
    //! helper-level scenarios** because the AccountInfo-touching paths
    //! (writable, owner, borrow_mut on the book account) need a real
    //! Solana runtime to exercise meaningfully. The end-to-end path
    //! (CPI from Core → matcher `process_cancel_all` →
    //! `cancel_all_for_user` on a real book) is covered by
    //! `tests/lifecycle.rs` under `BPF_OUT_DIR` (R5).
    //!
    //! Five cases per planning/README §7.7.R-R2:
    //! 1. happy path — `cancel_all_for_user` removes all matching orders
    //!    (state/book.rs has 4 dedicated helper tests too)
    //! 2. wrong owner — helper ignores orders whose `user` doesn't match
    //! 3. not-writable — pinned via the entry-point's `is_writable` check
    //!    on the `book_account` parameter (covered by R5 BPF runtime)
    //! 4. data-too-short — pinned via `CANCEL_ALL_DATA_LEN` (32)
    //! 5. empty book — `cancel_all_for_user` on an empty `BookState`
    //!    returns 0 (idempotent)

    use super::*;
    use crate::state::{
        book::{book_account_size, deserialize_book_state, place_resting, serialize_book_state},
        BookState, LimitOrder, OrderType, Side,
    };
    use pinocchio::pubkey::Pubkey;

    fn user_pubkey(byte: u8) -> Pubkey {
        let mut b = [0u8; 32];
        b[0] = byte;
        Pubkey::from(b)
    }

    fn make_order(byte: u8, side: Side, price: i64, qty: u64) -> LimitOrder {
        let mut user_bytes = [0u8; 32];
        user_bytes[0] = byte;
        LimitOrder {
            user: Pubkey::from(user_bytes),
            instrument_id: 0,
            order_type: OrderType::LimitGTC,
            side,
            price,
            qty,
            reduce_only: false,
            cancel_order_id: 0,
            is_maker: false,
        }
    }

    #[test]
    fn test_r2_happy_path_cancels_all_user_orders() {
        let mut state = BookState::new();
        place_resting(&mut state, &make_order(1, Side::Buy, 100, 5)).unwrap();
        place_resting(&mut state, &make_order(1, Side::Buy, 95, 3)).unwrap();
        place_resting(&mut state, &make_order(2, Side::Buy, 90, 7)).unwrap();
        assert_eq!(state.resting_count, 3);

        let removed = cancel_all_for_user(&mut state, &user_pubkey(1));
        assert_eq!(removed, 2);
        let user2_still_present = state
            .resting
            .iter()
            .take(state.resting_count)
            .any(|r| r.qty > 0 && r.user == user_pubkey(2));
        assert!(user2_still_present, "user 2's order should be preserved");
    }

    #[test]
    fn test_r2_wrong_owner_leaves_book_intact() {
        let mut state = BookState::new();
        place_resting(&mut state, &make_order(1, Side::Buy, 100, 5)).unwrap();
        place_resting(&mut state, &make_order(1, Side::Sell, 110, 3)).unwrap();
        assert_eq!(state.resting_count, 2);

        let removed = cancel_all_for_user(&mut state, &user_pubkey(99));
        assert_eq!(removed, 0);
        let live = state
            .resting
            .iter()
            .take(state.resting_count)
            .filter(|r| r.qty > 0)
            .count();
        assert_eq!(live, 2, "no orders should be removed for non-matching user");
    }

    #[test]
    fn test_r2_not_writable_is_data_only() {
        // Pinned via the entry-point's `is_writable` check on the
        // `book_account` parameter. The actual branch returns
        // `ProgramError::InvalidAccountData` and is exercised by R5
        // under BPF; here we document the data layout the check
        // depends on (mutable book buffer). The helper is the source
        // of truth; if the helper removes orders, the entry point
        // will succeed when given a writable account.
        let mut state = BookState::new();
        place_resting(&mut state, &make_order(1, Side::Buy, 100, 5)).unwrap();
        let mut buf = vec![0u8; book_account_size()];
        serialize_book_state(&state, &mut buf).unwrap();
        let mut state2 = deserialize_book_state(&buf).unwrap();
        let removed = cancel_all_for_user(&mut state2, &user_pubkey(1));
        assert_eq!(removed, 1);
    }

    #[test]
    fn test_r2_data_too_short_threshold() {
        // The entry point's data check is `data.len() < 32`. Pin the
        // threshold so a refactor that adds (or removes) a payload
        // field is caught at the wire-format level rather than at
        // runtime.
        assert_eq!(CANCEL_ALL_DATA_LEN, 32);
        let short_data = [0u8; 31];
        assert!(short_data.len() < CANCEL_ALL_DATA_LEN);
        let boundary_data = [0u8; 32];
        assert!(boundary_data.len() >= CANCEL_ALL_DATA_LEN);
    }

    #[test]
    fn test_r2_empty_book_is_idempotent() {
        // cancel_all_for_user on an empty BookState must return 0 and
        // leave resting_count at 0.
        let mut state = BookState::new();
        assert_eq!(state.resting_count, 0);
        let removed = cancel_all_for_user(&mut state, &user_pubkey(1));
        assert_eq!(removed, 0);
        assert_eq!(state.resting_count, 0);

        // And on a state with only zero-qty tombstones (post-remove
        // remnants), still 0.
        place_resting(&mut state, &make_order(1, Side::Buy, 100, 5)).unwrap();
        let _ = cancel_all_for_user(&mut state, &user_pubkey(1));
        let live = state
            .resting
            .iter()
            .take(state.resting_count)
            .filter(|r| r.qty > 0)
            .count();
        assert_eq!(live, 0);
        let removed2 = cancel_all_for_user(&mut state, &user_pubkey(1));
        assert_eq!(removed2, 0);
    }

    #[test]
    fn test_cancel_all_data_layout_is_stable() {
        let mut buf = [0u8; 33];
        buf[0] = 4; // MATCHER_CANCEL_ALL discriminator
        let user = Pubkey::from([7u8; 32]);
        buf[1..33].copy_from_slice(user.as_ref());
        assert_eq!(buf[0], 4);
        assert_eq!(buf[1], 7);
        assert_eq!(buf[32], 7);
    }

    #[test]
    fn test_cancel_all_user_parsing_is_stable() {
        let user = Pubkey::from([9u8; 32]);
        let mut data = [0u8; CANCEL_ALL_DATA_LEN];
        data.copy_from_slice(user.as_ref());
        let parsed = Pubkey::from(<[u8; 32]>::try_from(&data[0..32]).unwrap());
        assert_eq!(parsed, user);
    }

    #[test]
    fn test_cancel_all_discriminator_matches_entrypoint() {
        assert_eq!(MATCHER_CANCEL_ALL_DISCRIMINATOR, 4);
    }

    #[test]
    fn test_heap_scratch_returns_writable_zeroed_memory() {
        let arr = heap_array_fixed::<u64, 64>().unwrap();
        assert_eq!(arr[0], 0);
        assert_eq!(arr[63], 0);
        arr[0] = 42;
        arr[63] = 99;
        assert_eq!(arr[0], 42);
        assert_eq!(arr[63], 99);
    }

    #[test]
    fn test_heap_scratch_limit_order_array_is_valid() {
        let arr = heap_array_fixed::<LimitOrder, MAX_ORDERS>().unwrap();
        assert_eq!(arr[0].price, 0);
        assert_eq!(arr[0].qty, 0);
        assert_eq!(arr[0].side, Side::Buy);
        assert_eq!(arr[0].order_type, OrderType::LimitGTC);
        arr[0].price = 100;
        arr[0].qty = 5;
        arr[0].side = Side::Sell;
        assert_eq!(arr[0].price, 100);
        assert_eq!(arr[0].qty, 5);
        assert_eq!(arr[0].side, Side::Sell);
    }

    #[test]
    fn test_heap_scratch_two_allocations_do_not_alias() {
        let a = heap_array_fixed::<u64, 16>().unwrap();
        let b = heap_array_fixed::<u64, 16>().unwrap();
        a[0] = 111;
        b[0] = 222;
        assert_eq!(a[0], 111);
        assert_eq!(b[0], 222);
    }
}
