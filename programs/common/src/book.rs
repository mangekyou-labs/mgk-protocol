//! Order book data types shared between `perps-core` (mark price sweep,
//! `SettleBatch` funding premium) and `perps-matcher` (matching engine).
//!
//! These types live in `mgk-common` so the perps-core program can
//! read the order book PDA (owned by perps-matcher) without taking a Rust
//! crate dependency on perps-matcher. The crate dependency would cause
//! duplicate `panic_handler` lang items at link time, since each program
//! needs its own `#[panic_handler]` and `cargo build-sbf` compiles both
//! crates as cdylibs.
//!
//! Behaviors (place / cancel / match) live in `perps-matcher` and are
//! intentionally NOT re-exported from here.

use crate::layout::{discriminator, AccountHeader, AccountLayout, LAYOUT_VERSION_1};

/// Sentinel "no link" offset for end of a FIFO chain.
pub const NULL_OFFSET: u32 = u32::MAX;

/// Maximum number of price levels per side of the book.
pub const MAX_LEVELS: usize = 64;
/// Maximum resting orders at a single price level.
pub const MAX_ORDERS_PER_LEVEL: usize = 16;

/// Persistent order book header for a single instrument.
///
/// PDA: `["book", instrument_id]`. Lives in the matcher program account
/// space; perps-core reads it read-only for mark price and funding
/// premium computation.
///
/// This is the **header only** — the resting-order FIFO chains are owned
/// by perps-matcher. Callers that need to walk the resting orders must
/// go through the matcher's `place_resting` / `cancel_resting_by_id`
/// instructions, not by reading the account directly.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OrderBook {
    /// Account discriminator + layout version (offset 0).
    pub header: AccountHeader,
    pub instrument_id: u16,
    pub best_bid: i64,
    pub best_ask: i64,
    pub bid_count: u32,
    pub ask_count: u32,
    pub next_order_id: u64,
    pub last_update_slot: u64,
    pub bids: [BookLevel; MAX_LEVELS],
    pub asks: [BookLevel; MAX_LEVELS],
}

// SAFETY: `repr(C)` POD whose first field is the account header.
unsafe impl AccountLayout for OrderBook {
    const DISCRIMINATOR: u8 = discriminator::ORDER_BOOK;
    const LAYOUT_VERSION: u8 = LAYOUT_VERSION_1;
}

impl OrderBook {
    /// An empty book for `instrument_id` carrying the current header.
    pub fn new(instrument_id: u16) -> Self {
        Self {
            header: AccountHeader::of::<Self>(),
            instrument_id,
            best_bid: 0,
            best_ask: 0,
            bid_count: 0,
            ask_count: 0,
            next_order_id: 0,
            last_update_slot: 0,
            bids: [BookLevel::default(); MAX_LEVELS],
            asks: [BookLevel::default(); MAX_LEVELS],
        }
    }
}

/// A price level on one side of the book.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BookLevel {
    pub price: i64,
    pub total_qty: u64,
    pub order_count: u16,
    pub first_order_offset: u32,
}

/// Size of the `OrderBook` header struct (the on-chain book account's
/// persistent part — level arrays, but **not** the in-memory resting-order
/// FIFO chains owned by the matcher).
#[inline]
pub const fn book_header_size() -> usize {
    core::mem::size_of::<OrderBook>()
}

/// Derive the PDA address for a book account.
///
/// Seeds: `["book", instrument_id_le_bytes]`. Owner: the matcher program.
/// Used by `perps-core` to verify that a `SettleBatch` caller passed the
/// real book account (not a malicious lookalike) for the given instrument.
#[inline]
pub fn book_pda(program_id: &pinocchio::pubkey::Pubkey, instrument_id: u16) -> (pinocchio::pubkey::Pubkey, u8) {
    let id_bytes = instrument_id.to_le_bytes();
    let seeds: [&[u8]; 2] = [b"book", &id_bytes];
    pinocchio::pubkey::find_program_address(&seeds, program_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::{discriminator, load, AccountHeader, AccountLayout, ACCOUNT_HEADER_LEN};
    use crate::MgkError;

    #[test]
    fn order_book_declares_its_account_layout() {
        assert_eq!(OrderBook::DISCRIMINATOR, discriminator::ORDER_BOOK);
        assert_eq!(OrderBook::LAYOUT_VERSION, 1);
    }

    #[test]
    fn order_book_header_is_first_in_the_account() {
        let book = OrderBook::new(7);
        assert_eq!(book.header, AccountHeader::of::<OrderBook>());
        let base = &book as *const OrderBook as usize;
        assert_eq!(&book.header as *const AccountHeader as usize - base, 0);
        assert_eq!(&book.instrument_id as *const u16 as usize - base, ACCOUNT_HEADER_LEN);
    }

    #[test]
    fn order_book_loads_only_with_matching_header() {
        let book = OrderBook::new(7);
        let n = core::mem::size_of::<OrderBook>();
        let mut buf = [0u64; 2048];
        assert!(n <= core::mem::size_of_val(&buf));
        let bytes = unsafe { core::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut u8, n) };
        let src = unsafe { core::slice::from_raw_parts(&book as *const OrderBook as *const u8, n) };
        bytes.copy_from_slice(src);
        assert_eq!(load::<OrderBook>(bytes).unwrap().instrument_id, 7);

        bytes[0] = discriminator::BATCH;
        assert_eq!(load::<OrderBook>(bytes).err(), Some(MgkError::InvalidAccountDiscriminator));
        bytes[0] = discriminator::ORDER_BOOK;
        bytes[1] = 2;
        assert_eq!(load::<OrderBook>(bytes).err(), Some(MgkError::UnsupportedLayoutVersion));
    }
}
