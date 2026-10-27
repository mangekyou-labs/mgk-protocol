//! Slab header - v0 minimal metadata

use crate::layout::{discriminator, AccountHeader, AccountLayout, LAYOUT_VERSION_1};
use pinocchio::pubkey::Pubkey;

// SAFETY: `repr(C)` POD whose first field is the account header.
unsafe impl AccountLayout for SlabHeader {
    const DISCRIMINATOR: u8 = discriminator::SLAB;
    const LAYOUT_VERSION: u8 = LAYOUT_VERSION_1;
}

/// Slab header - v0 simplified for single-account slab
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct SlabHeader {
    /// Account discriminator + layout version (replaces the old
    /// `b"PERP10\0\0"` magic and `version: u32`).
    pub header: AccountHeader,
    /// Sequence number (incremented on any book/state change)
    pub seqno: u32,

    /// Slab program ID
    pub program_id: Pubkey,
    /// LP owner pubkey
    pub lp_owner: Pubkey,
    /// Router program ID (only router can call commit_fill)
    pub router_id: Pubkey,

    /// Shared instrument ID (agreed with router)
    pub instrument: Pubkey,
    /// Contract size (1e6 fixed)
    pub contract_size: i64,
    /// Tick size (1e6 fixed)
    pub tick: i64,
    /// Lot size (1e6 fixed)
    pub lot: i64,
    /// Mark price from shared oracle (1e6 scale)
    pub mark_px: i64,

    /// Taker fee (basis points, 1e6 scale)
    pub taker_fee_bps: i64,

    /// Byte offset to BookArea (from start of account)
    pub off_book: u32,
    /// Byte offset to QuoteCache (from start of account)
    pub off_quote_cache: u32,
    /// Byte offset to receipt area (from start of account)
    pub off_receipt_area: u32,

    /// Bump seed
    pub bump: u8,
    /// Padding
    pub _padding: [u8; 3],
}

impl SlabHeader {
    pub const LEN: usize = core::mem::size_of::<Self>();

    /// Initialize new slab header (v0 minimal)
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        program_id: Pubkey,
        lp_owner: Pubkey,
        router_id: Pubkey,
        instrument: Pubkey,
        mark_px: i64,
        taker_fee_bps: i64,
        contract_size: i64,
        bump: u8,
    ) -> Self {
        // Calculate byte offsets
        let off_quote_cache = Self::LEN as u32;
        let off_book = off_quote_cache + crate::quote_cache::QuoteCache::LEN as u32;
        let off_receipt_area = off_book + 3072; // 3KB for book

        Self {
            header: AccountHeader::of::<Self>(),
            seqno: 0,
            program_id,
            lp_owner,
            router_id,
            instrument,
            contract_size,
            tick: 1_000_000,           // $1 tick
            lot: 1_000_000,            // 1.0 lot
            mark_px,
            taker_fee_bps,
            off_book,
            off_quote_cache,
            off_receipt_area,
            bump,
            _padding: [0; 3],
        }
    }

    /// True if the discriminator and layout version are the current ones.
    pub fn validate(&self) -> bool {
        self.header == AccountHeader::of::<Self>()
    }

    /// Increment sequence number (on any book change)
    pub fn increment_seqno(&mut self) -> u32 {
        self.seqno = self.seqno.wrapping_add(1);
        self.seqno
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_header_validation() {
        let header = SlabHeader::new(
            Pubkey::default(),
            Pubkey::default(),
            Pubkey::default(),
            Pubkey::default(),
            50_000_000_000, // $50,000 mark price
            20,             // 0.2% taker fee
            1_000_000,      // contract size
            255,
        );

        assert!(header.validate());
        assert_eq!(header.seqno, 0);
        assert_eq!(header.header.layout_version, 1);
        assert_eq!(header.header.discriminator, crate::layout::discriminator::SLAB);
    }

    #[test]
    fn test_header_rejects_wrong_discriminator_or_version() {
        use crate::layout::{discriminator, load, AccountHeader};
        use crate::MgkError;
        let mut header = SlabHeader::new(
            Pubkey::default(),
            Pubkey::default(),
            Pubkey::default(),
            Pubkey::default(),
            1,
            1,
            1,
            0,
        );
        let n = core::mem::size_of::<SlabHeader>();
        let as_bytes = |h: &SlabHeader| -> [u8; 256] {
            let mut b = [0u8; 256];
            let src = unsafe { core::slice::from_raw_parts(h as *const SlabHeader as *const u8, n) };
            b[..n].copy_from_slice(src);
            b
        };
        assert!(load::<SlabHeader>(&as_bytes(&header)[..n]).is_ok());
        header.header = AccountHeader::new(discriminator::BATCH, 1);
        assert!(!header.validate());
        assert_eq!(
            load::<SlabHeader>(&as_bytes(&header)[..n]).err(),
            Some(MgkError::InvalidAccountDiscriminator)
        );
        header.header = AccountHeader::new(discriminator::SLAB, 2);
        assert!(!header.validate());
        assert_eq!(
            load::<SlabHeader>(&as_bytes(&header)[..n]).err(),
            Some(MgkError::UnsupportedLayoutVersion)
        );
    }

    #[test]
    fn test_seqno_increment() {
        let mut header = SlabHeader::new(
            Pubkey::default(),
            Pubkey::default(),
            Pubkey::default(),
            Pubkey::default(),
            50_000_000_000,
            20,
            1_000_000,
            255,
        );

        assert_eq!(header.seqno, 0);
        assert_eq!(header.increment_seqno(), 1);
        assert_eq!(header.increment_seqno(), 2);
        assert_eq!(header.seqno, 2);
    }

    #[test]
    fn test_offsets() {
        let header = SlabHeader::new(
            Pubkey::default(),
            Pubkey::default(),
            Pubkey::default(),
            Pubkey::default(),
            50_000_000_000,
            20,
            1_000_000,
            255,
        );

        // Verify offsets are non-zero and ordered correctly
        assert!(header.off_quote_cache > 0);
        assert!(header.off_book > header.off_quote_cache);
        assert!(header.off_receipt_area > header.off_book);
    }
}
