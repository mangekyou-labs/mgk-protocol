use mgk_common::layout::{discriminator, AccountHeader, AccountLayout};
use mgk_common::MgkError;

/// Required reserve per lot of larger-side open interest: 0.4 x 0.001 SOL.
pub const RESERVE_LAMPORTS_PER_LOT: u128 = 400_000;
/// Max absolute position per portfolio: 10 SOL in 0.001 SOL lots.
pub const PORTFOLIO_EXPOSURE_LIMIT_LOTS: u64 = 10_000;
/// Max open interest per side: 50 SOL in 0.001 SOL lots.
pub const MARKET_EXPOSURE_LIMIT_LOTS: u64 = 50_000;

/// Vault accounting ledger (ADR 0003).
///
/// The vault holds the real lamports. It must never be under-backed:
/// `vault lamports - rent >= balance + insurance_fund - uncovered_bad_debt`.
/// Anyone can credit the PDA, so unsolicited surplus is tolerated; each
/// instruction's lamport delta must still equal its ledger delta exactly
/// (`VaultSnapshot::check_flow`).
///
/// Fields:
/// - `balance` - running total of trader collateral (SOL lamports)
/// - `insurance_fund` - cash-backed counterparty to realized PnL; never below 0
/// - `uncovered_bad_debt` - running balance of payouts the fund could not
///   cover; every inflow repays it before the fund grows
/// - `open_interest_long` / `open_interest_short` - sum of long and of short
///   position quantity in lots across all portfolios
///
/// Memory layout (layout version 2; pinned by `test_vault_offsets_are_pinned`
/// and the compile-time asserts below on every target):
///   header: 8 bytes          @ 0
///   balance: u64             @ 8
///   insurance: u128          @ 16
///   uncovered: u128          @ 32
///   open_interest_long: u64  @ 48
///   open_interest_short: u64 @ 56
///   bump: u8                 @ 64
///   _padding: [u8;7]         @ 65
///   _pad_tail: [u8;8]        @ 72
///   struct size: 80   (u128 has 16-byte alignment on the host but only
///   8 on SBF, so `_pad_tail` makes the SBF size match the host's 80).
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Vault {
    pub header: AccountHeader,
    pub balance: u64,
    pub insurance_fund: u128,
    pub uncovered_bad_debt: u128,
    pub open_interest_long: u64,
    pub open_interest_short: u64,
    pub bump: u8,
    pub _padding: [u8; 7],
    /// Explicit tail padding so the size is 80 on every target (SBF would otherwise be 72).
    pub _pad_tail: [u8; 8],
}

// Host (u128 align 16) and SBF (u128 align 8) must agree on this layout:
// every 128-bit field is 16-aligned and the size is a multiple of 16.
const _: () = {
    use core::mem::{offset_of, size_of};
    assert!(offset_of!(Vault, balance) == 8);
    assert!(offset_of!(Vault, insurance_fund) == 16);
    assert!(offset_of!(Vault, uncovered_bad_debt) == 32);
    assert!(offset_of!(Vault, open_interest_long) == 48);
    assert!(offset_of!(Vault, open_interest_short) == 56);
    assert!(offset_of!(Vault, bump) == 64);
    assert!(size_of::<Vault>() == 80);
};

/// Layout version 2: cash-backed fund ledger plus long/short open-interest counters.
pub const VAULT_LAYOUT_VERSION: u8 = 2;

// SAFETY: `repr(C)` plain-old-data with a leading `AccountHeader`.
unsafe impl AccountLayout for Vault {
    const DISCRIMINATOR: u8 = discriminator::VAULT;
    const LAYOUT_VERSION: u8 = VAULT_LAYOUT_VERSION;
}

/// Vault lamports and ledger backing before an instruction (see
/// `Vault::snapshot`).
#[derive(Clone, Copy, Debug)]
pub struct VaultSnapshot {
    lamports: u64,
    backing: i128,
}

impl VaultSnapshot {
    /// The vault is never under-backed and the instruction's lamport delta
    /// equals its ledger-backing delta exactly. Surplus that arrived before
    /// the instruction stays in the vault and is ignored; a net-zero
    /// instruction (settle, liquidate) passes `lamports_after` unchanged.
    pub fn check_flow(
        &self,
        after: &Vault,
        lamports_after: u64,
        rent: u64,
    ) -> Result<(), MgkError> {
        let lamport_delta = (lamports_after as i128) - (self.lamports as i128);
        let backing_delta = after
            .backing()?
            .checked_sub(self.backing)
            .ok_or(MgkError::Overflow)?;
        if lamport_delta != backing_delta {
            return Err(MgkError::VaultInvariantViolated);
        }
        after.check_backed(lamports_after, rent)
    }
}

impl Vault {
    pub fn initialize_in_place(&mut self, bump: u8) {
        self.header = AccountHeader::of::<Self>();
        self.balance = 0;
        self.insurance_fund = 0;
        self.uncovered_bad_debt = 0;
        self.open_interest_long = 0;
        self.open_interest_short = 0;
        self.bump = bump;
        self._padding = [0; 7];
        self._pad_tail = [0; 8];
    }

    #[cfg(test)]
    pub fn new() -> Self {
        let mut v = Self {
            header: AccountHeader::of::<Self>(),
            balance: 0,
            insurance_fund: 0,
            uncovered_bad_debt: 0,
            open_interest_long: 0,
            open_interest_short: 0,
            bump: 0,
            _padding: [0; 7],
            _pad_tail: [0; 8],
        };
        v.initialize_in_place(0);
        v
    }

    /// Reserve the fund must hold against `lots` of larger-side open interest.
    pub const fn reserve_for(lots: u128) -> u128 {
        lots * RESERVE_LAMPORTS_PER_LOT
    }

    /// Required reserve: 0.4 x the larger side of open interest.
    pub fn required_reserve(&self) -> u128 {
        Self::reserve_for(self.open_interest_long.max(self.open_interest_short) as u128)
    }

    /// Fund lamports above the required reserve that the admin may withdraw.
    /// Zero while any bad debt is outstanding.
    pub fn fund_surplus(&self) -> u128 {
        if self.uncovered_bad_debt > 0 {
            return 0;
        }
        self.insurance_fund.saturating_sub(self.required_reserve())
    }

    /// Recovery conditions for unpause: no debt and the reserve is met.
    pub fn recovery_ready(&self) -> bool {
        self.uncovered_bad_debt == 0 && self.insurance_fund >= self.required_reserve()
    }

    /// Credit `amount` lamports that really entered the vault (top-up,
    /// collected loss, fee). Outstanding debt is repaid first.
    pub fn inflow(&mut self, amount: u128) -> Result<(), MgkError> {
        let repay = amount.min(self.uncovered_bad_debt);
        let to_fund = amount - repay;
        let fund = self
            .insurance_fund
            .checked_add(to_fund)
            .ok_or(MgkError::Overflow)?;
        self.uncovered_bad_debt -= repay;
        self.insurance_fund = fund;
        Ok(())
    }

    /// Pay `amount` lamports owed to a counterparty out of the fund. The fund
    /// never goes below 0: whatever it cannot cover becomes uncovered debt.
    /// Returns the shortfall so the caller can pause trading and withdrawals.
    pub fn outflow(&mut self, amount: u128) -> Result<u128, MgkError> {
        let paid = amount.min(self.insurance_fund);
        let shortfall = amount - paid;
        let debt = self
            .uncovered_bad_debt
            .checked_add(shortfall)
            .ok_or(MgkError::Overflow)?;
        self.insurance_fund -= paid;
        self.uncovered_bad_debt = debt;
        Ok(shortfall)
    }

    /// Track open interest across a portfolio position change `old -> new`
    /// (signed lots). Longs and shorts are counted per side.
    pub fn apply_position_change(&mut self, old: i64, new: i64) -> Result<(), MgkError> {
        let side = |q: i64| {
            if q >= 0 {
                (q as u64, 0)
            } else {
                (0, q.unsigned_abs())
            }
        };
        let (old_long, old_short) = side(old);
        let (new_long, new_short) = side(new);
        let long = self
            .open_interest_long
            .checked_sub(old_long)
            .ok_or(MgkError::Underflow)?
            .checked_add(new_long)
            .ok_or(MgkError::Overflow)?;
        let short = self
            .open_interest_short
            .checked_sub(old_short)
            .ok_or(MgkError::Underflow)?
            .checked_add(new_short)
            .ok_or(MgkError::Overflow)?;
        self.open_interest_long = long;
        self.open_interest_short = short;
        Ok(())
    }

    /// Net lamports the vault must hold above rent: trader collateral plus
    /// the fund, less the fund's unpaid payouts. Negative while debt exceeds
    /// both.
    pub fn backing(&self) -> Result<i128, MgkError> {
        let assets = (self.balance as u128)
            .checked_add(self.insurance_fund)
            .ok_or(MgkError::Overflow)?;
        let assets = i128::try_from(assets).map_err(|_| MgkError::Overflow)?;
        let debt = i128::try_from(self.uncovered_bad_debt).map_err(|_| MgkError::Overflow)?;
        Ok(assets - debt)
    }

    /// Record the ledger backing and lamports before an instruction moves
    /// either, for `VaultSnapshot::check_flow` afterwards.
    pub fn snapshot(&self, vault_lamports: u64) -> Result<VaultSnapshot, MgkError> {
        Ok(VaultSnapshot {
            lamports: vault_lamports,
            backing: self.backing()?,
        })
    }

    /// Solvency: the vault holds at least rent plus the ledger backing.
    /// Unsolicited lamports (a plain transfer to the PDA) are surplus and
    /// pass. Evaluated as `lamports + debt >= rent + balance + fund` so
    /// neither side can underflow.
    pub fn check_backed(&self, vault_lamports: u64, rent: u64) -> Result<(), MgkError> {
        let lhs = (vault_lamports as u128)
            .checked_add(self.uncovered_bad_debt)
            .ok_or(MgkError::Overflow)?;
        let rhs = (rent as u128)
            .checked_add(self.balance as u128)
            .and_then(|v| v.checked_add(self.insurance_fund))
            .ok_or(MgkError::Overflow)?;
        if lhs >= rhs {
            Ok(())
        } else {
            Err(MgkError::VaultInvariantViolated)
        }
    }

    /// Exposure limits and risk-off gate for an exposure-adding post or modify.
    /// `held` is the portfolio's signed position, `resting_same_side` the
    /// quantity already resting on the order's side. Checks, in order: the
    /// 10 SOL portfolio exposure limit, the 50 SOL per-side market exposure limit, then the
    /// risk-off rule (fund >= 0.4 x (larger side + order quantity)).
    pub fn check_exposure_order(
        &self,
        is_buy: bool,
        quantity: u64,
        held: i64,
        resting_same_side: u64,
    ) -> Result<(), MgkError> {
        let worst_case_added = (resting_same_side as i128) + (quantity as i128);
        let signed_added = if is_buy { worst_case_added } else { -worst_case_added };
        let exposure = (held as i128) + signed_added;
        if exposure.unsigned_abs() > PORTFOLIO_EXPOSURE_LIMIT_LOTS as u128 {
            return Err(MgkError::PortfolioExposureLimitExceeded);
        }
        let side_oi = if is_buy {
            self.open_interest_long
        } else {
            self.open_interest_short
        };
        let side_after = (side_oi as u128) + (quantity as u128);
        if side_after > MARKET_EXPOSURE_LIMIT_LOTS as u128 {
            return Err(MgkError::MarketExposureLimitExceeded);
        }
        let larger = self.open_interest_long.max(self.open_interest_short) as u128;
        if self.insurance_fund < Self::reserve_for(larger + quantity as u128) {
            return Err(MgkError::RiskOffFundBelowReserve);
        }
        Ok(())
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

    const RENT: u64 = 1_113_600;

    fn vault(balance: u64, fund: u128, debt: u128) -> Vault {
        let mut v = Vault::new();
        v.balance = balance;
        v.insurance_fund = fund;
        v.uncovered_bad_debt = debt;
        v
    }

    #[test]
    fn test_vault_new() {
        let v = Vault::new();
        assert_eq!(v.balance, 0);
        assert_eq!(v.bump, 0);
    }

    #[test]
    fn test_vault_initialize_zeroes_every_ledger_field() {
        let mut v = Vault {
            header: AccountHeader::default(),
            balance: u64::MAX,
            insurance_fund: u128::MAX,
            uncovered_bad_debt: u128::MAX,
            open_interest_long: u64::MAX,
            open_interest_short: u64::MAX,
            bump: 255,
            _padding: [0xff; 7],
            _pad_tail: [0xff; 8],
        };
        v.initialize_in_place(42);
        assert_eq!(v.balance, 0);
        assert_eq!(v.insurance_fund, 0);
        assert_eq!(v.uncovered_bad_debt, 0);
        assert_eq!((v.open_interest_long, v.open_interest_short), (0, 0));
        assert_eq!(v.bump, 42);
        assert_eq!(v.header.layout_version, 2);
    }

    #[test]
    fn test_vault_header_stamped_and_checked_on_load() {
        use mgk_common::layout::{discriminator, load};
        let v = Vault::new();
        assert_eq!(v.header.discriminator, discriminator::VAULT);
        assert_eq!(v.header.layout_version, <Vault as AccountLayout>::LAYOUT_VERSION);

        let mut buf = [0u128; 8];
        let bytes: &mut [u8] = unsafe {
            core::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut u8, core::mem::size_of::<Vault>())
        };
        mgk_common::layout::init_mut::<Vault>(bytes).unwrap();
        assert!(load::<Vault>(bytes).is_ok());
        bytes[0] = discriminator::REGISTRY;
        assert_eq!(load::<Vault>(bytes).err(), Some(MgkError::InvalidAccountDiscriminator));
        bytes[0] = discriminator::VAULT;
        bytes[1] = 9;
        assert_eq!(load::<Vault>(bytes).err(), Some(MgkError::UnsupportedLayoutVersion));
    }

    /// Pinned byte offsets; SDK and runtime-harness decoders depend on these.
    #[test]
    fn test_vault_offsets_are_pinned() {
        use core::mem::offset_of;
        assert_eq!(offset_of!(Vault, balance), 8);
        assert_eq!(offset_of!(Vault, insurance_fund), 16);
        assert_eq!(offset_of!(Vault, uncovered_bad_debt), 32);
        assert_eq!(offset_of!(Vault, open_interest_long), 48);
        assert_eq!(offset_of!(Vault, open_interest_short), 56);
        assert_eq!(offset_of!(Vault, bump), 64);
        assert_eq!(core::mem::size_of::<Vault>(), 80);
    }

    #[test]
    fn test_inflow_repays_debt_before_the_fund() {
        let mut v = vault(0, 0, 300);
        v.inflow(100).unwrap();
        assert_eq!((v.insurance_fund, v.uncovered_bad_debt), (0, 200));
        v.inflow(500).unwrap();
        assert_eq!((v.insurance_fund, v.uncovered_bad_debt), (300, 0));
        v.inflow(7).unwrap();
        assert_eq!(v.insurance_fund, 307);
    }

    #[test]
    fn test_inflow_overflow_is_an_error_and_changes_nothing() {
        let mut v = vault(0, u128::MAX, 0);
        assert_eq!(v.inflow(1), Err(MgkError::Overflow));
        assert_eq!(v.insurance_fund, u128::MAX);
    }

    #[test]
    fn test_outflow_pays_from_fund_then_records_shortfall_as_debt() {
        let mut v = vault(0, 100, 0);
        assert_eq!(v.outflow(60), Ok(0));
        assert_eq!((v.insurance_fund, v.uncovered_bad_debt), (40, 0));
        assert_eq!(v.outflow(100), Ok(60));
        assert_eq!((v.insurance_fund, v.uncovered_bad_debt), (0, 60));
        assert_eq!(v.outflow(5), Ok(5));
        assert_eq!(v.uncovered_bad_debt, 65);
    }

    #[test]
    fn test_open_interest_follows_position_changes_per_side() {
        let mut v = Vault::new();
        v.apply_position_change(0, 5).unwrap();
        assert_eq!((v.open_interest_long, v.open_interest_short), (5, 0));
        v.apply_position_change(5, -3).unwrap();
        assert_eq!((v.open_interest_long, v.open_interest_short), (0, 3));
        v.apply_position_change(0, 4).unwrap();
        v.apply_position_change(-3, 0).unwrap();
        assert_eq!((v.open_interest_long, v.open_interest_short), (4, 0));
        v.apply_position_change(4, 2).unwrap();
        assert_eq!((v.open_interest_long, v.open_interest_short), (2, 0));
    }

    #[test]
    fn test_open_interest_underflow_is_an_error() {
        let mut v = Vault::new();
        assert_eq!(v.apply_position_change(5, 0), Err(MgkError::Underflow));
        assert_eq!(v.apply_position_change(-5, 0), Err(MgkError::Underflow));
        assert_eq!((v.open_interest_long, v.open_interest_short), (0, 0));
    }

    #[test]
    fn test_required_reserve_is_forty_percent_of_larger_side() {
        let mut v = Vault::new();
        v.open_interest_long = 20_000;
        v.open_interest_short = 12_000;
        assert_eq!(v.required_reserve(), 8_000_000_000);
        v.open_interest_short = 30_000;
        assert_eq!(v.required_reserve(), 12_000_000_000);
        assert_eq!(Vault::reserve_for(1), 400_000);
    }

    /// Snapshot, apply a ledger change, then check against the new lamports.
    fn flow(
        before: &Vault,
        lamports_before: u64,
        after: &Vault,
        lamports_after: u64,
    ) -> Result<(), MgkError> {
        before
            .snapshot(lamports_before)
            .unwrap()
            .check_flow(after, lamports_after, RENT)
    }

    #[test]
    fn test_unsolicited_surplus_is_tolerated() {
        let v = vault(700, 300, 50);
        let backed = RENT + 700 + 300 - 50;
        // A plain transfer to the vault adds lamports the ledger never saw.
        let donated = backed + 40;
        assert_eq!(flow(&v, donated, &v, donated), Ok(()));
        // A deposit on top of the donation still balances exactly.
        let after = vault(800, 300, 50);
        assert_eq!(flow(&v, donated, &after, donated + 100), Ok(()));
    }

    #[test]
    fn test_lamport_delta_must_equal_ledger_delta_exactly() {
        let v = vault(700, 300, 50);
        let backed = RENT + 700 + 300 - 50;
        let after = vault(800, 300, 50); // ledger +100
        for lamports_after in [backed + 99, backed + 101] {
            assert_eq!(
                flow(&v, backed, &after, lamports_after),
                Err(MgkError::VaultInvariantViolated)
            );
        }
        // Surplus does not excuse a mismatched delta.
        assert_eq!(
            flow(&v, backed + 40, &after, backed + 40 + 99),
            Err(MgkError::VaultInvariantViolated)
        );
        // Lamports leaving without the ledger following is a mismatch too.
        assert_eq!(
            flow(&v, backed, &v, backed - 1),
            Err(MgkError::VaultInvariantViolated)
        );
    }

    #[test]
    fn test_under_backed_vault_is_refused_even_when_deltas_match() {
        let v = vault(700, 300, 50);
        let backed = RENT + 700 + 300 - 50;
        // Already 1 lamport short before the instruction: stays refused.
        assert_eq!(
            flow(&v, backed - 1, &v, backed - 1),
            Err(MgkError::VaultInvariantViolated)
        );
        // Ledger claims 100 more than the lamports that arrived.
        let after = vault(800, 300, 50);
        assert_eq!(
            flow(&v, backed, &after, backed),
            Err(MgkError::VaultInvariantViolated)
        );
        // Debt larger than collateral plus fund must not underflow the check.
        let owing = vault(0, 0, 10);
        assert_eq!(flow(&owing, RENT - 10, &owing, RENT - 10), Ok(()));
        assert_eq!(
            flow(&owing, RENT - 11, &owing, RENT - 11),
            Err(MgkError::VaultInvariantViolated)
        );
    }

    #[test]
    fn test_settlement_moves_no_lamports_and_keeps_backing_constant() {
        // Winner paid from the fund, loser collected into it: net backing 0.
        let before = vault(1_000, 500, 0);
        let backed = RENT + 1_500;
        let paid = vault(1_200, 300, 0); // +200 balance, -200 fund
        assert_eq!(flow(&before, backed, &paid, backed), Ok(()));
        // Fund exhausted: remainder becomes debt, still backing-neutral.
        let exhausted = vault(1_700, 0, 200);
        assert_eq!(flow(&before, backed, &exhausted, backed), Ok(()));
        // Credit conjured out of nothing moves backing and is caught.
        let conjured = vault(1_200, 500, 0);
        assert_eq!(
            flow(&before, backed, &conjured, backed),
            Err(MgkError::VaultInvariantViolated)
        );
    }

    #[test]
    fn test_portfolio_exposure_limit_is_ten_sol() {
        let v = vault(0, u128::MAX / 4, 0);
        assert_eq!(v.check_exposure_order(true, 10_000, 0, 0), Ok(()));
        assert_eq!(
            v.check_exposure_order(true, 10_001, 0, 0),
            Err(MgkError::PortfolioExposureLimitExceeded)
        );
        assert_eq!(
            v.check_exposure_order(false, 10_001, 0, 0),
            Err(MgkError::PortfolioExposureLimitExceeded)
        );
        assert_eq!(v.check_exposure_order(true, 1_000, 9_000, 0), Ok(()));
        assert_eq!(
            v.check_exposure_order(true, 1_001, 9_000, 0),
            Err(MgkError::PortfolioExposureLimitExceeded)
        );
        // Same-side resting exposure counts toward the worst case.
        assert_eq!(v.check_exposure_order(true, 600, 9_000, 400), Ok(()));
        assert_eq!(
            v.check_exposure_order(true, 600, 9_000, 401),
            Err(MgkError::PortfolioExposureLimitExceeded)
        );
        // A short may buy back into the limit without tripping it.
        assert_eq!(v.check_exposure_order(true, 10_000, -10_000, 0), Ok(()));
    }

    #[test]
    fn test_market_exposure_limit_is_fifty_sol_per_side() {
        let mut v = vault(0, u128::MAX / 4, 0);
        v.open_interest_long = 49_999;
        v.open_interest_short = 49_999;
        assert_eq!(v.check_exposure_order(true, 1, 0, 0), Ok(()));
        assert_eq!(
            v.check_exposure_order(true, 2, 0, 0),
            Err(MgkError::MarketExposureLimitExceeded)
        );
        assert_eq!(
            v.check_exposure_order(false, 2, 0, 0),
            Err(MgkError::MarketExposureLimitExceeded)
        );
    }

    #[test]
    fn test_risk_off_needs_fund_for_larger_side_plus_order() {
        let mut v = vault(0, 10_000_000_000, 0);
        v.open_interest_long = 20_000;
        v.open_interest_short = 20_000;
        assert_eq!(v.check_exposure_order(true, 5_000, 0, 0), Ok(()));
        assert_eq!(
            v.check_exposure_order(true, 5_001, 0, 0),
            Err(MgkError::RiskOffFundBelowReserve)
        );
        assert_eq!(
            v.check_exposure_order(false, 5_001, 0, 0),
            Err(MgkError::RiskOffFundBelowReserve)
        );
        v.insurance_fund = 1;
        assert_eq!(
            v.check_exposure_order(true, 1, 0, 0),
            Err(MgkError::RiskOffFundBelowReserve)
        );
    }

    #[test]
    fn test_fund_surplus_is_fund_above_reserve_and_zero_with_debt() {
        let mut v = vault(0, 10_000_000_000, 0);
        v.open_interest_long = 20_000;
        assert_eq!(v.fund_surplus(), 2_000_000_000);
        v.insurance_fund = 7_000_000_000;
        assert_eq!(v.fund_surplus(), 0);
        let owing = vault(0, 0, 5);
        assert_eq!(owing.fund_surplus(), 0);
    }

    #[test]
    fn test_recovery_ready_needs_no_debt_and_reserve_met() {
        let mut v = vault(0, 8_000_000_000, 0);
        v.open_interest_long = 20_000;
        assert!(v.recovery_ready());
        v.insurance_fund -= 1;
        assert!(!v.recovery_ready());
        v.insurance_fund = 8_000_000_000;
        v.uncovered_bad_debt = 1;
        assert!(!v.recovery_ready());
    }
}
