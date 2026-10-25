use mgk_common::layout::{discriminator, AccountHeader, AccountLayout, LAYOUT_VERSION_1};

/// M7 7.7: insurance + ADL stub ledger.
///
/// Fields:
/// - `balance` — total deposited collateral (SOL lamports)
/// - `insurance_fund` — protocol-owned backstop (deposits, fees, slashes)
/// - `uncovered_bad_debt` — historical accumulator; only ever increases
///   (kept for accounting, never cleared)
/// - `adl_debt` — current ADL backlog (cleared by a future ADL implementation
///   via `clear_adl_pending`)
/// - `adl_pending` — keeper-readable flag: true while `adl_debt > 0`
///
/// Memory layout (pinned by `test_vault_size`; the 8-byte account header
/// fits into what used to be alignment padding before `insurance_fund`, so
/// the size is unchanged):
///   header: 8 bytes   @ 0
///   balance: u64      @ 8
///   insurance: u128   @ 16
///   uncovered: u128   @ 32
///   adl_debt: u128    @ 48
///   adl_pending: bool @ 64
///   bump: u8          @ 65
///   _padding: [u8;6]  @ 66
///   struct size: 80   (u128 has 16-byte alignment on x86_64 host;
///   also 8-byte aligned on SBF — the trailing padding is harmless).
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Vault {
    pub header: AccountHeader,
    pub balance: u64,
    pub insurance_fund: u128,
    pub uncovered_bad_debt: u128,
    pub adl_debt: u128,
    pub adl_pending: bool,
    pub bump: u8,
    pub _padding: [u8; 6],
}

// SAFETY: `repr(C)` plain-old-data with a leading `AccountHeader`.
unsafe impl AccountLayout for Vault {
    const DISCRIMINATOR: u8 = discriminator::VAULT;
    const LAYOUT_VERSION: u8 = LAYOUT_VERSION_1;
}

impl Vault {
    pub fn initialize_in_place(&mut self, bump: u8) {
        self.header = AccountHeader::of::<Self>();
        self.balance = 0;
        self.insurance_fund = 0;
        self.uncovered_bad_debt = 0;
        self.adl_debt = 0;
        self.adl_pending = false;
        self.bump = bump;
        self._padding = [0; 6];
    }

    #[cfg(test)]
    pub fn new() -> Self {
        let mut v = Self {
            header: AccountHeader::of::<Self>(),
            balance: 0,
            insurance_fund: 0,
            uncovered_bad_debt: 0,
            adl_debt: 0,
            adl_pending: false,
            bump: 0,
            _padding: [0; 6],
        };
        v.initialize_in_place(0);
        v
    }

    /// M7 7.7: record new auto-deleveraging debt. Saturates at `u128::MAX`
    /// rather than wrapping; sets the keeper-observable flag.
    pub fn mark_adl_pending(&mut self, debt: u128) {
        self.adl_pending = true;
        self.adl_debt = self.adl_debt.saturating_add(debt);
    }

    /// M7 7.7: clear the ADL backlog once a future ADL implementation has
    /// absorbed the debt. Does NOT touch `uncovered_bad_debt` (the
    /// historical accumulator persists for accounting).
    pub fn clear_adl_pending(&mut self) {
        self.adl_pending = false;
        self.adl_debt = 0;
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

    #[test]
    fn test_vault_new() {
        let v = Vault::new();
        assert_eq!(v.balance, 0);
        assert_eq!(v.bump, 0);
    }

    #[test]
    fn test_vault_initialize() {
        let mut v = Vault {
            header: AccountHeader::default(),
            balance: u64::MAX,
            insurance_fund: u128::MAX,
            uncovered_bad_debt: u128::MAX,
            adl_debt: u128::MAX,
            adl_pending: true,
            bump: 255,
            _padding: [0; 6],
        };
        v.initialize_in_place(42);
        assert_eq!(v.balance, 0);
        assert_eq!(v.adl_debt, 0);
        assert!(!v.adl_pending);
        assert_eq!(v.bump, 42);
    }

    #[test]
    fn test_mark_adl_pending_sets_flag_and_debt() {
        let mut v = Vault::new();
        v.mark_adl_pending(500);
        assert!(v.adl_pending);
        assert_eq!(v.adl_debt, 500);
    }

    #[test]
    fn test_mark_adl_pending_accumulates() {
        let mut v = Vault::new();
        v.mark_adl_pending(500);
        v.mark_adl_pending(300);
        assert!(v.adl_pending);
        assert_eq!(v.adl_debt, 800);
    }

    #[test]
    fn test_mark_adl_pending_saturates_at_overflow() {
        let mut v = Vault::new();
        v.mark_adl_pending(u128::MAX);
        v.mark_adl_pending(1);
        assert_eq!(v.adl_debt, u128::MAX);
        assert!(v.adl_pending);
    }

    #[test]
    fn test_clear_adl_pending_resets() {
        let mut v = Vault::new();
        v.mark_adl_pending(500);
        v.clear_adl_pending();
        assert!(!v.adl_pending);
        assert_eq!(v.adl_debt, 0);
    }

    #[test]
    fn test_initialize_in_place_resets_adl_fields() {
        let mut v = Vault::new();
        v.mark_adl_pending(999);
        v.initialize_in_place(7);
        assert!(!v.adl_pending);
        assert_eq!(v.adl_debt, 0);
        assert_eq!(v.bump, 7);
    }

    #[test]
    fn test_vault_header_stamped_and_checked_on_load() {
        use mgk_common::layout::{discriminator, load, LAYOUT_VERSION_1};
        use mgk_common::MgkError;
        let v = Vault::new();
        assert_eq!(v.header.discriminator, discriminator::VAULT);
        assert_eq!(v.header.layout_version, LAYOUT_VERSION_1);

        let mut buf = [0u128; 8];
        let bytes: &mut [u8] = unsafe {
            core::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut u8, core::mem::size_of::<Vault>())
        };
        mgk_common::layout::init_mut::<Vault>(bytes).unwrap();
        assert!(load::<Vault>(bytes).is_ok());
        bytes[0] = discriminator::REGISTRY;
        assert_eq!(
            load::<Vault>(bytes).err(),
            Some(MgkError::InvalidAccountDiscriminator)
        );
        bytes[0] = discriminator::VAULT;
        bytes[1] = 9;
        assert_eq!(
            load::<Vault>(bytes).err(),
            Some(MgkError::UnsupportedLayoutVersion)
        );
    }

    /// The header fills the old 8 bytes of padding in front of the u128s, so
    /// balance moves 0 -> 8 and the u128 offsets are unchanged.
    #[test]
    fn test_vault_header_fits_in_existing_padding() {
        assert_eq!(core::mem::offset_of!(Vault, balance), 8);
        assert_eq!(core::mem::offset_of!(Vault, insurance_fund), 16);
    }

    #[test]
    fn test_vault_size() {
        // Pinned to 80 on host (u128 16-byte alignment). On SBF, u128
        // alignment is 8, but the struct layout offsets stay the same and
        // the on-chain size is also 80 (trailing padding is harmless).
        assert_eq!(core::mem::size_of::<Vault>(), 80);
    }
}
