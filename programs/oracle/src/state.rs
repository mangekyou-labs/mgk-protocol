//! Oracle state structures
//!
//! Minimal price oracle for Surfpool testing. Stores price data for instruments.

use mgk_common::layout::{discriminator, AccountHeader, AccountLayout, LAYOUT_VERSION_1};
use pinocchio::pubkey::Pubkey;

/// Size of PriceOracle account: 128 bytes
pub const PRICE_ORACLE_SIZE: usize = 128;

/// Price oracle account state
///
/// Stores current price data for an instrument. Similar to Pyth but simplified.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct PriceOracle {
    /// Account discriminator + layout version (replaces the old 8-byte magic).
    pub header: AccountHeader,

    /// Unused (was `version`; the layout version now lives in the header).
    /// Kept so later fields retain their offsets.
    pub _unused: u8,

    /// Bump seed for PDA
    pub bump: u8,

    /// Whether this oracle is currently active
    pub is_active: bool,

    /// Padding for alignment
    pub _padding: [u8; 5],

    /// Authority that can update prices
    pub authority: Pubkey,

    /// Instrument this oracle is for
    pub instrument: Pubkey,

    /// Current price (scaled by 1_000_000)
    pub price: i64,

    /// Last update timestamp (Unix timestamp)
    pub timestamp: i64,

    /// Price confidence interval (scaled by 1_000_000)
    pub confidence: i64,

    /// Reserved for future use (24 bytes to reach 128 total)
    pub _reserved: [u8; 24],
}

// SAFETY: `#[repr(C)]` POD with `AccountHeader` at offset 0. As before the
// header, `is_active` is a `bool` that only this program's handlers write (0/1).
unsafe impl AccountLayout for PriceOracle {
    const DISCRIMINATOR: u8 = discriminator::PRICE_ORACLE;
    const LAYOUT_VERSION: u8 = LAYOUT_VERSION_1;
}

impl PriceOracle {
    /// Create a new price oracle
    pub fn new(authority: Pubkey, instrument: Pubkey, price: i64, bump: u8) -> Self {
        Self {
            header: AccountHeader::of::<Self>(),
            _unused: 0,
            bump,
            is_active: false,
            _padding: [0; 5],
            authority,
            instrument,
            price,
            timestamp: 0,
            confidence: 0,
            _reserved: [0; 24],
        }
    }

    /// Update the price
    pub fn update_price(&mut self, price: i64, timestamp: i64, confidence: i64) {
        self.price = price;
        self.timestamp = timestamp;
        self.confidence = confidence;
    }

    /// Activate the oracle (enable price reads)
    pub fn activate(&mut self) {
        self.is_active = true;
    }

    /// Deactivate the oracle (disable price reads)
    pub fn deactivate(&mut self) {
        self.is_active = false;
    }

    /// Transfer authority to a new pubkey
    pub fn set_authority(&mut self, new_authority: Pubkey) {
        self.authority = new_authority;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_price_oracle_size() {
        use core::mem::size_of;
        assert_eq!(size_of::<PriceOracle>(), PRICE_ORACLE_SIZE);
    }

    #[test]
    fn test_price_oracle_header_and_offsets() {
        use core::mem::offset_of;
        use mgk_common::layout::{discriminator, AccountHeader, LAYOUT_VERSION_1};

        let oracle = PriceOracle::new(Pubkey::default(), Pubkey::default(), 1, 7);
        assert_eq!(
            oracle.header,
            AccountHeader::new(discriminator::PRICE_ORACLE, LAYOUT_VERSION_1)
        );
        // Fields after the header keep their pre-header offsets.
        assert_eq!(offset_of!(PriceOracle, header), 0);
        assert_eq!(offset_of!(PriceOracle, bump), 9);
        assert_eq!(offset_of!(PriceOracle, is_active), 10);
        assert_eq!(offset_of!(PriceOracle, authority), 16);
        assert_eq!(offset_of!(PriceOracle, instrument), 48);
        assert_eq!(offset_of!(PriceOracle, price), 80);
        assert_eq!(offset_of!(PriceOracle, timestamp), 88);
        assert_eq!(offset_of!(PriceOracle, confidence), 96);
    }

    #[test]
    fn test_load_rejects_wrong_discriminator_and_version() {
        use mgk_common::error::MgkError;
        use mgk_common::layout::{discriminator, load, load_mut};

        let oracle = PriceOracle::new(Pubkey::default(), Pubkey::default(), 5, 1);
        let mut buf = [0u8; PRICE_ORACLE_SIZE];
        unsafe { *(buf.as_mut_ptr() as *mut PriceOracle) = oracle };
        assert_eq!(load::<PriceOracle>(&buf).unwrap().price, 5);

        // Zeroed (uninitialised) account.
        let zeroed = [0u8; PRICE_ORACLE_SIZE];
        assert_eq!(
            load::<PriceOracle>(&zeroed).err(),
            Some(MgkError::InvalidAccountDiscriminator)
        );

        // Another account type's discriminator.
        let mut wrong_disc = buf;
        wrong_disc[0] = discriminator::REGISTRY;
        assert_eq!(
            load_mut::<PriceOracle>(&mut wrong_disc).err(),
            Some(MgkError::InvalidAccountDiscriminator)
        );

        // Unsupported layout version.
        let mut wrong_ver = buf;
        wrong_ver[1] = 2;
        assert_eq!(
            load::<PriceOracle>(&wrong_ver).err(),
            Some(MgkError::UnsupportedLayoutVersion)
        );
    }

    #[test]
    fn test_price_oracle_creation() {
        let authority = Pubkey::default();
        let instrument = Pubkey::default();
        let oracle = PriceOracle::new(authority, instrument, 60_000_000_000, 0);

        assert_eq!(oracle.header, AccountHeader::of::<PriceOracle>());
        assert_eq!(oracle.price, 60_000_000_000);
        assert_eq!(oracle.authority, authority);
        assert_eq!(oracle.instrument, instrument);
    }

    #[test]
    fn test_price_update() {
        let authority = Pubkey::default();
        let instrument = Pubkey::default();
        let mut oracle = PriceOracle::new(authority, instrument, 60_000_000_000, 0);

        oracle.update_price(61_000_000_000, 1234567890, 100_000);

        assert_eq!(oracle.price, 61_000_000_000);
        assert_eq!(oracle.timestamp, 1234567890);
        assert_eq!(oracle.confidence, 100_000);
    }

    #[test]
    fn test_activate_deactivate() {
        let authority = Pubkey::default();
        let instrument = Pubkey::default();
        let mut oracle = PriceOracle::new(authority, instrument, 60_000_000_000, 0);

        assert!(!oracle.is_active);
        oracle.activate();
        assert!(oracle.is_active);
        oracle.deactivate();
        assert!(!oracle.is_active);
    }

    #[test]
    fn test_set_authority() {
        let authority = Pubkey::default();
        let instrument = Pubkey::default();
        let mut oracle = PriceOracle::new(authority, instrument, 60_000_000_000, 0);

        let new_authority = Pubkey::from([1u8; 32]);
        oracle.set_authority(new_authority);
        assert_eq!(oracle.authority, new_authority);
    }
}
