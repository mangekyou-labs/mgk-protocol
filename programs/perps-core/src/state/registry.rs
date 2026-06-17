use pinocchio::pubkey::Pubkey;

/// PauseFlags bitmask (M7 7.8, design L842-853).
///
/// All four categories are independent. A `1` bit pauses the category;
/// a `0` bit allows it. Bits 4..8 are reserved for future use (must be 0
/// on disk; XOR-toggle on a reserved bit is silently ignored because the
/// governance instruction only flips the mask it receives — the caller
/// controls which bits are set, the struct just stores the result).
pub const PAUSE_TRADING: u8 = 1 << 0;
pub const PAUSE_WITHDRAWALS: u8 = 1 << 1;
pub const PAUSE_LIQUIDATIONS: u8 = 1 << 2;
pub const PAUSE_FUNDING: u8 = 1 << 3;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Registry {
    pub governance: Pubkey,
    pub instrument_count: u16,
    pub volatility_multiplier: u16,
    pub batch_id_counter: u64,
    pub base_deposit: u64,
    pub n_min: u32,
    pub t_min_slots: u64,
    pub t_max_slots: u64,
    pub t_reveal_slots: u64,
    pub bump: u8,
    pub pause_flags: u8,
    pub _padding: [u8; 4],
}

impl Registry {
    #[allow(clippy::too_many_arguments)]
    pub fn initialize_in_place(
        &mut self,
        governance: Pubkey,
        base_deposit: u64,
        n_min: u32,
        t_min_slots: u64,
        t_max_slots: u64,
        t_reveal_slots: u64,
        bump: u8,
    ) {
        self.governance = governance;
        self.instrument_count = 0;
        self.volatility_multiplier = 10_000; // 1.0x default
        self.batch_id_counter = 0;
        self.base_deposit = base_deposit;
        self.n_min = n_min;
        self.t_min_slots = t_min_slots;
        self.t_max_slots = t_max_slots;
        self.t_reveal_slots = t_reveal_slots;
        self.bump = bump;
        self.pause_flags = 0;
        self._padding = [0; 4];
    }

    pub fn deposit_amount(&self) -> u64 {
        let deposit = self.base_deposit as u128;
        let multiplier = self.volatility_multiplier as u128;
        ((deposit * multiplier) / 10_000) as u64
    }

    /// Returns `true` if `CommitOrder` and `RevealOrder` should be rejected.
    #[inline]
    pub fn is_trading_paused(&self) -> bool {
        (self.pause_flags & PAUSE_TRADING) != 0
    }

    /// Returns `true` if `Withdraw` should be rejected.
    #[inline]
    pub fn is_withdrawals_paused(&self) -> bool {
        (self.pause_flags & PAUSE_WITHDRAWALS) != 0
    }

    /// Returns `true` if `LiquidateUser` should be rejected.
    #[inline]
    pub fn is_liquidations_paused(&self) -> bool {
        (self.pause_flags & PAUSE_LIQUIDATIONS) != 0
    }

    /// Returns `true` if `SettleBatch` should skip the funding-rate
    /// accrual step. Settlement of positions/insurance/deposits still
    /// proceeds (design L853: "in-flight batches complete normally").
    #[inline]
    pub fn is_funding_paused(&self) -> bool {
        (self.pause_flags & PAUSE_FUNDING) != 0
    }

    /// XOR-toggle the given mask bits in `pause_flags`. Each `1` bit in
    /// `mask` flips the corresponding bit in the stored flags. Used by
    /// the `UpdatePauseFlags` instruction (M7 7.8).
    #[inline]
    pub fn toggle_pause_flags(&mut self, mask: u8) {
        self.pause_flags ^= mask;
    }

    /// Direct set (test-only convenience — production callers should use
    /// `toggle_pause_flags` via the governance instruction).
    #[cfg(test)]
    pub fn set_pause_flags(&mut self, flags: u8) {
        self.pause_flags = flags;
    }

    #[cfg(test)]
    pub fn new(governance: Pubkey) -> Self {
        let mut r = Self {
            governance,
            instrument_count: 0,
            volatility_multiplier: 10_000,
            batch_id_counter: 0,
            base_deposit: 10_000_000,
            n_min: 5,
            t_min_slots: 10,
            t_max_slots: 150,
            t_reveal_slots: 25,
            bump: 0,
            pause_flags: 0,
            _padding: [0; 4],
        };
        r.initialize_in_place(governance, 10_000_000, 5, 10, 150, 25, 0);
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_registry_new() {
        let gov = Pubkey::from([1u8; 32]);
        let r = Registry::new(gov);
        assert_eq!(r.governance, gov);
        assert_eq!(r.instrument_count, 0);
        assert_eq!(r.base_deposit, 10_000_000);
        assert_eq!(r.n_min, 5);
        assert_eq!(r.pause_flags, 0, "registry must initialize with no pauses");
    }

    // --- M7 7.8 PauseFlags tests ---

    #[test]
    fn test_pause_flag_constants_are_independent_bits() {
        // Each constant must be exactly one bit, and they must not overlap.
        assert_eq!(PAUSE_TRADING, 0b0000_0001);
        assert_eq!(PAUSE_WITHDRAWALS, 0b0000_0010);
        assert_eq!(PAUSE_LIQUIDATIONS, 0b0000_0100);
        assert_eq!(PAUSE_FUNDING, 0b0000_1000);
        let all = PAUSE_TRADING | PAUSE_WITHDRAWALS | PAUSE_LIQUIDATIONS | PAUSE_FUNDING;
        assert_eq!(all, 0b0000_1111, "the four flags must occupy the low nibble");
    }

    #[test]
    fn test_pause_query_helpers_default_to_unpaused() {
        let r = Registry::new(Pubkey::from([0u8; 32]));
        assert!(!r.is_trading_paused());
        assert!(!r.is_withdrawals_paused());
        assert!(!r.is_liquidations_paused());
        assert!(!r.is_funding_paused());
    }

    #[test]
    fn test_pause_query_helpers_independent() {
        // Setting trading_paused must not affect the others.
        let mut r = Registry::new(Pubkey::from([0u8; 32]));
        r.set_pause_flags(PAUSE_TRADING);
        assert!(r.is_trading_paused());
        assert!(!r.is_withdrawals_paused());
        assert!(!r.is_liquidations_paused());
        assert!(!r.is_funding_paused());
    }

    #[test]
    fn test_pause_query_helpers_all_four_set() {
        let mut r = Registry::new(Pubkey::from([0u8; 32]));
        r.set_pause_flags(0b0000_1111);
        assert!(r.is_trading_paused());
        assert!(r.is_withdrawals_paused());
        assert!(r.is_liquidations_paused());
        assert!(r.is_funding_paused());
    }

    #[test]
    fn test_toggle_pause_flags_xor_semantics() {
        let mut r = Registry::new(Pubkey::from([0u8; 32]));
        // toggle PAUSE_TRADING once -> set
        r.toggle_pause_flags(PAUSE_TRADING);
        assert!(r.is_trading_paused());
        // toggle PAUSE_TRADING again -> cleared
        r.toggle_pause_flags(PAUSE_TRADING);
        assert!(!r.is_trading_paused());
        // multi-bit toggle: set trading + funding, then clear trading only
        r.toggle_pause_flags(PAUSE_TRADING | PAUSE_FUNDING);
        assert!(r.is_trading_paused());
        assert!(r.is_funding_paused());
        r.toggle_pause_flags(PAUSE_TRADING);
        assert!(!r.is_trading_paused());
        assert!(r.is_funding_paused(), "funding must remain set after clearing trading");
    }

    #[test]
    fn test_initialize_in_place_clears_pause_flags() {
        // After initialize_in_place, pause_flags must be 0 even if the
        // backing memory had been mutated (e.g., for an attack that
        // initialized a fresh Registry over a pre-existing account).
        let mut r = Registry::new(Pubkey::from([0u8; 32]));
        r.set_pause_flags(0xFF);
        r.initialize_in_place(Pubkey::from([2u8; 32]), 1, 1, 1, 1, 1, 0);
        assert_eq!(r.pause_flags, 0, "initialize_in_place must clear pauses");
    }
}
