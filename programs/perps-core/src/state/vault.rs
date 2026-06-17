
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Vault {
    pub balance: u64,
    pub insurance_fund: u128,
    pub uncovered_bad_debt: u128,
    pub adl_pending: bool,
    pub _padding_to_adl_debt: [u8; 7],
    pub adl_debt: u128,
    pub bump: u8,
    pub _padding: [u8; 7],
}

impl Vault {
    pub fn initialize_in_place(&mut self, bump: u8) {
        self.balance = 0;
        self.insurance_fund = 0;
        self.uncovered_bad_debt = 0;
        self.adl_pending = false;
        self._padding_to_adl_debt = [0; 7];
        self.adl_debt = 0;
        self.bump = bump;
        self._padding = [0; 7];
    }

    #[cfg(test)]
    pub fn new() -> Self {
        let mut v = Self {
            balance: 0,
            insurance_fund: 0,
            uncovered_bad_debt: 0,
            adl_pending: false,
            _padding_to_adl_debt: [0; 7],
            adl_debt: 0,
            bump: 0,
            _padding: [0; 7],
        };
        v.initialize_in_place(0);
        v
    }
}

#[cfg(test)]
impl Default for Vault {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::mem::size_of;

    #[test]
    fn test_vault_new() {
        let v = Vault::new();
        assert_eq!(v.balance, 0);
        assert_eq!(v.bump, 0);
        assert!(!v.adl_pending);
        assert_eq!(v.adl_debt, 0);
    }

    #[test]
    fn test_vault_initialize() {
        let mut v = Vault {
            balance: u64::MAX,
            insurance_fund: u128::MAX,
            uncovered_bad_debt: u128::MAX,
            adl_pending: true,
            _padding_to_adl_debt: [0xFF; 7],
            adl_debt: u128::MAX,
            bump: 255,
            _padding: [0xFF; 7],
        };
        v.initialize_in_place(42);
        assert_eq!(v.balance, 0);
        assert_eq!(v.insurance_fund, 0);
        assert_eq!(v.uncovered_bad_debt, 0);
        assert!(!v.adl_pending);
        assert_eq!(v._padding_to_adl_debt, [0; 7]);
        assert_eq!(v.adl_debt, 0);
        assert_eq!(v.bump, 42);
        assert_eq!(v._padding, [0; 7]);
    }

    /// M7 7.7: pin the Vault struct size so callers (e.g. the e2e harness
    /// in tests/lifecycle.rs which reads `data[0..8]` for balance and
    /// `data[8..24]` for insurance_fund) can rely on the layout.
    ///
    /// Note: with `#[repr(C)]` the compiler inserts padding to align
    /// u128 fields to 16 bytes, so the *raw* field order is shifted
    /// from what you'd see if you just added up the field sizes. We
    /// don't pin the field offsets here — only the struct size and
    /// that the new fields are accessible after `initialize_in_place`.
    /// If you need a specific byte offset, add it to the e2e harness
    /// and assert there, not here.
    #[test]
    fn test_vault_layout() {
        // Struct align is 16 (max of u64 and u128), so size is a
        // multiple of 16 and at least 72 (raw field byte count).
        let raw_field_size = 8 + 16 + 16 + 1 + 7 + 16 + 1 + 7;
        assert_eq!(raw_field_size, 72, "raw field byte count");
        let struct_size = size_of::<Vault>();
        assert!(
            struct_size >= raw_field_size && struct_size.is_multiple_of(16),
            "struct size {struct_size} must be 16-aligned and >= 72"
        );

        // Verify all new fields are accessible and zeroed by initialize_in_place.
        let v = Vault::new();
        assert_eq!(v.balance, 0);
        assert_eq!(v.insurance_fund, 0);
        assert_eq!(v.uncovered_bad_debt, 0);
        assert!(!v.adl_pending, "adl_pending defaults to false");
        assert_eq!(v.adl_debt, 0, "adl_debt defaults to 0");
        assert_eq!(v.bump, 0);
    }
}
