use mgk_common::layout::{discriminator, AccountHeader, AccountLayout};
use pinocchio::pubkey::Pubkey;

/// Entry-price units per micro-USD (one unit is 10^-18 USD).
pub const ENTRY_PRICE_SCALE: u64 = 1_000_000_000_000;

pub const MAX_POSITIONS: usize = 32;
pub const MAX_INSTRUMENTS: usize = 32;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Portfolio {
    /// Account discriminator + layout version (spec 13 / issue 16).
    pub header: AccountHeader,
    pub user: Pubkey,
    /// Explicit padding so `equity` is 16-aligned on every target.
    pub _pad_u128: [u8; 8],
    pub equity: i128,
    pub principal: i128,
    /// Cumulative realized micro-USD, rounded down per fill for display only.
    pub realized_usd: i128,
    pub realized_lamports: i128,
    pub fees_paid: i128,
    /// Restricted demo: funding is disabled and this total stays zero.
    pub funding_paid: i128,
    pub im: u128,
    pub mm: u128,
    pub free_collateral: i128,
    pub health: i128,
    pub positions_len: u16,
    pub _pad_positions: [u8; 6],
    pub positions: [Position; MAX_POSITIONS],
    /// Explicit padding so `last_funding_checkpoint` is 16-aligned on every target.
    pub _pad_u128_b: [u8; 8],
    pub last_funding_checkpoint: [i128; MAX_INSTRUMENTS],
    pub last_batch_id: u64,
    pub last_slot: u64,
    pub bump: u8,
    pub _padding: [u8; 7],
    /// Explicit tail padding so the size is a multiple of 16 on every target.
    pub _pad_tail: [u8; 8],
    pub reserved_collateral: u128,
    pub risk_pnl: i128,
    pub orders: [OrderReservation; 12],
}

// Host (u128 align 16) and SBF (u128 align 8) must agree on this layout: every
// 128-bit field sits at a 16-aligned offset by construction, and the struct
// size is a multiple of 16. Checked at compile time for the target being built.
const _: () = {
    use core::mem::{align_of, offset_of, size_of};
    assert!(size_of::<Portfolio>() == 2848);
    assert!(size_of::<Position>() == 40);
    assert!(offset_of!(Portfolio, reserved_collateral) == 2048);
    assert!(offset_of!(Portfolio, risk_pnl) == 2064);
    assert!(offset_of!(Portfolio, orders) == 2080);
    assert!(size_of::<OrderReservation>() == 64);
    // SBF aligns u128 to8; all fields still occupy identical byte offsets.
    assert!(align_of::<OrderReservation>() == align_of::<u128>());
    assert!(offset_of!(OrderReservation, initial_reserve) == 32);
    assert!(offset_of!(OrderReservation, instrument_id) == 48);
    assert!(offset_of!(Portfolio, user) == 8);
    assert!(offset_of!(Portfolio, equity) == 48);
    assert!(offset_of!(Portfolio, principal) == 64);
    assert!(offset_of!(Portfolio, realized_usd) == 80);
    assert!(offset_of!(Portfolio, realized_lamports) == 96);
    assert!(offset_of!(Portfolio, fees_paid) == 112);
    assert!(offset_of!(Portfolio, funding_paid) == 128);
    assert!(offset_of!(Portfolio, positions_len) == 208);
    assert!(offset_of!(Portfolio, positions) == 216);
    assert!(offset_of!(Portfolio, last_funding_checkpoint) == 1504);
    assert!(offset_of!(Portfolio, last_batch_id) == 2016);
    assert!(offset_of!(Portfolio, last_slot) == 2024);
    assert!(offset_of!(Portfolio, bump) == 2032);
    assert!(offset_of!(Position, qty) == 8);
    assert!(offset_of!(Position, entry_vwap) == 16);
    assert!(offset_of!(Position, entry_remainder) == 24);
    assert!(offset_of!(Position, entry_denominator) == 32);
    assert!(offset_of!(Portfolio, equity) & 15 == 0);
    assert!(offset_of!(Portfolio, principal) & 15 == 0);
    assert!(offset_of!(Portfolio, realized_usd) & 15 == 0);
    assert!(offset_of!(Portfolio, im) & 15 == 0);
    assert!(offset_of!(Portfolio, mm) & 15 == 0);
    assert!(offset_of!(Portfolio, free_collateral) & 15 == 0);
    assert!(offset_of!(Portfolio, health) & 15 == 0);
    assert!(offset_of!(Portfolio, last_funding_checkpoint) & 15 == 0);
    assert!(size_of::<Portfolio>() & 15 == 0);
};

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Position {
    pub instrument_id: u16,
    pub qty: i64,
    /// Floor of the stored micro-USD entry price, for display.
    pub entry_vwap: i64,
    /// Stored entry = entry_vwap + entry_remainder / entry_denominator.
    /// Denominator is ENTRY_PRICE_SCALE, or zero for an integer entry.
    pub entry_remainder: u64,
    pub entry_denominator: u64,
}

/// Reservation provenance survives tentative matching until settlement consumes it.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct OrderReservation {
    pub order_id: u64,
    pub original_qty: u64,
    pub remaining_qty: u64,
    pub price: i64,
    pub initial_reserve: u128,
    pub instrument_id: u16,
    pub side: u8,
    pub reduce_only: u8,
    pub _padding: [u8; 12],
}
impl OrderReservation {
    pub fn reserved(&self) -> u128 {
        if self.remaining_qty == 0 { return 0; }
        (self.initial_reserve / self.original_qty as u128) * self.remaining_qty as u128
            + ((self.initial_reserve % self.original_qty as u128) * self.remaining_qty as u128)
                .div_ceil(self.original_qty as u128)
    }
}

// SAFETY: `repr(C)` plain-old-data with a leading `AccountHeader`.
unsafe impl AccountLayout for Portfolio {
    const DISCRIMINATOR: u8 = discriminator::PORTFOLIO;
    const LAYOUT_VERSION: u8 = 3;
}

impl Portfolio {
    pub fn initialize_in_place(&mut self, user: Pubkey, bump: u8) {
        self.header = AccountHeader::of::<Self>();
        self.user = user;
        self._pad_u128 = [0; 8];
        self.equity = 0;
        self.principal = 0;
        self.realized_usd = 0;
        self.realized_lamports = 0;
        self.fees_paid = 0;
        self.funding_paid = 0;
        self.im = 0;
        self.mm = 0;
        self.free_collateral = 0;
        self.health = 0;
        self.positions_len = 0;
        self._pad_positions = [0; 6];
        self.positions = [Position::default(); MAX_POSITIONS];
        self._pad_u128_b = [0; 8];
        self.last_funding_checkpoint = [0; MAX_INSTRUMENTS];
        self.last_batch_id = 0;
        self.last_slot = 0;
        self.bump = bump;
        self._padding = [0; 7];
        self._pad_tail = [0; 8];
        self.reserved_collateral = 0;
        self.risk_pnl = 0;
        self.orders = [OrderReservation::default(); 12];
    }

    pub fn recalc_margin(&mut self) {
        self.free_collateral = self.equity.saturating_add(self.risk_pnl.min(0))
            .saturating_sub(self.im as i128).saturating_sub(self.reserved_collateral as i128);
        self.health = self.equity.saturating_add(self.risk_pnl).saturating_sub(self.mm as i128);
    }

    /// Returns `true` if the portfolio is underwater (`health < 0`) and
    /// should be liquidated. M7 7.6 (decision D2): after all fills in a
    /// batch are applied, `SettleBatch` calls this to flag eligible
    /// portfolios for the keeper; the actual liquidation is a separate
    /// `LiquidateUser` transaction (which already enforces `health >= 0`).
    pub fn needs_liquidation(&self) -> bool {
        self.health < 0
    }

    pub fn find_position(&self, instrument_id: u16) -> Option<(usize, &Position)> {
        for i in 0..self.positions_len as usize {
            if self.positions[i].instrument_id == instrument_id {
                return Some((i, &self.positions[i]));
            }
        }
        None
    }

    /// Signed position quantity in lots on `instrument_id`; 0 when flat.
    pub fn position_qty(&self, instrument_id: u16) -> i64 {
        self.find_position(instrument_id).map_or(0, |(_, p)| p.qty)
    }

    /// Quantity resting on `side` of `instrument_id` that could add
    /// exposure (reduce-only orders cannot).
    pub fn resting_exposure_adding(&self, instrument_id: u16, side: u8) -> u64 {
        self.orders
            .iter()
            .filter(|o| {
                o.remaining_qty != 0
                    && o.instrument_id == instrument_id
                    && o.side == side
                    && o.reduce_only == 0
            })
            .fold(0u64, |acc, o| acc.saturating_add(o.remaining_qty))
    }

    pub fn find_position_mut(&mut self, instrument_id: u16) -> Option<(usize, &mut Position)> {
        for i in 0..self.positions_len as usize {
            if self.positions[i].instrument_id == instrument_id {
                return Some((i, &mut self.positions[i]));
            }
        }
        None
    }

    #[cfg(test)]
    pub fn new(user: Pubkey) -> Self {
        let mut p = Self {
            header: AccountHeader::of::<Self>(),
            user,
            _pad_u128: [0; 8],
            equity: 0,
            principal: 0,
            realized_usd: 0,
            realized_lamports: 0,
            fees_paid: 0,
            funding_paid: 0,
            im: 0,
            mm: 0,
            free_collateral: 0,
            health: 0,
            positions_len: 0,
            _pad_positions: [0; 6],
            positions: [Position::default(); MAX_POSITIONS],
            _pad_u128_b: [0; 8],
            last_funding_checkpoint: [0; MAX_INSTRUMENTS],
            last_batch_id: 0,
            last_slot: 0,
            bump: 0,
            _padding: [0; 7],
            _pad_tail: [0; 8],
            reserved_collateral: 0,
            risk_pnl: 0,
            orders: [OrderReservation::default(); 12],
        };
        p.recalc_margin();
        p
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_portfolio_header_stamped_and_checked_on_load() {
        use mgk_common::layout::{discriminator, load};
        use mgk_common::MgkError;
        let p = Portfolio::new(Pubkey::from([4u8; 32]));
        assert_eq!(p.header.discriminator, discriminator::PORTFOLIO);
        assert_eq!(p.header.layout_version, 3);

        let words = core::mem::size_of::<Portfolio>().div_ceil(16);
        let mut buf = std::vec![0u128; words];
        let bytes: &mut [u8] = unsafe {
            core::slice::from_raw_parts_mut(
                buf.as_mut_ptr() as *mut u8,
                core::mem::size_of::<Portfolio>(),
            )
        };
        mgk_common::layout::init_mut::<Portfolio>(bytes).unwrap();
        assert!(load::<Portfolio>(bytes).is_ok());
        bytes[0] = discriminator::VAULT;
        assert_eq!(
            load::<Portfolio>(bytes).err(),
            Some(MgkError::InvalidAccountDiscriminator)
        );
        bytes[0] = discriminator::PORTFOLIO;
        bytes[1] = mgk_common::layout::LAYOUT_VERSION_1;
        assert_eq!(
            load::<Portfolio>(bytes).err(),
            Some(MgkError::UnsupportedLayoutVersion)
        );
    }

    #[test]
    fn test_portfolio_initialize_in_place_restamps_header() {
        let mut p = Portfolio::new(Pubkey::default());
        p.header.discriminator = 0;
        p.header.layout_version = 0;
        p.initialize_in_place(Pubkey::from([1u8; 32]), 3);
        assert_eq!(
            p.header,
            mgk_common::layout::AccountHeader::of::<Portfolio>()
        );
    }

    #[test]
    fn test_portfolio_new() {
        let user = Pubkey::default();
        let p = Portfolio::new(user);
        assert_eq!(p.user, user);
        assert_eq!(p.equity, 0);
        assert_eq!(p.free_collateral, 0);
    }

    #[test]
    fn test_recalc_margin() {
        let mut p = Portfolio::new(Pubkey::default());
        p.equity = 1000;
        p.im = 100;
        p.mm = 50;
        p.recalc_margin();
        assert_eq!(p.free_collateral, 900);
        assert_eq!(p.health, 950);
    }

    #[test]
    fn test_needs_liquidation_healthy_portfolio() {
        let mut p = Portfolio::new(Pubkey::default());
        p.equity = 1000;
        p.mm = 50;
        p.recalc_margin();
        assert_eq!(p.health, 950);
        assert!(!p.needs_liquidation());
    }

    #[test]
    fn test_needs_liquidation_underwater_portfolio() {
        // M7 7.6 (D2): post-hoc check. equity < mm → health < 0 → liquidate.
        let mut p = Portfolio::new(Pubkey::default());
        p.equity = 40;
        p.mm = 50;
        p.recalc_margin();
        assert_eq!(p.health, -10);
        assert!(p.needs_liquidation());
    }

    #[test]
    fn test_needs_liquidation_at_boundary() {
        // health == 0 is the boundary: still NOT eligible for liquidation
        // (LiquidateUser rejects health >= 0). M7 7.6 uses strict `< 0`.
        let mut p = Portfolio::new(Pubkey::default());
        p.equity = 50;
        p.mm = 50;
        p.recalc_margin();
        assert_eq!(p.health, 0);
        assert!(!p.needs_liquidation());
    }

    #[test]
    fn reduce_only_and_other_instrument_orders_do_not_count_as_resting_exposure() {
        let order = |order_id: u64, instrument_id: u16, qty: u64, reduce_only: u8| OrderReservation {
            order_id,
            original_qty: qty,
            remaining_qty: qty,
            instrument_id,
            side: 0,
            reduce_only,
            ..Default::default()
        };
        let mut p = Portfolio::new(Pubkey::from([1u8; 32]));
        p.orders[0] = order(1, 0, 400, 1);
        p.orders[1] = order(2, 7, 300, 0);
        p.orders[2] = order(3, 0, 50, 0);
        assert_eq!(p.resting_exposure_adding(0, 0), 50);
        assert_eq!(p.resting_exposure_adding(0, 1), 0);
    }

    #[test]
    fn position_qty_is_signed_and_zero_when_flat() {
        let mut p = Portfolio::new(Pubkey::from([1u8; 32]));
        p.positions[0] = Position { instrument_id: 3, qty: -40, ..Position::default() };
        p.positions_len = 1;
        assert_eq!(p.position_qty(3), -40);
        assert_eq!(p.position_qty(4), 0);
    }

    #[test]
    fn test_find_position() {
        let mut p = Portfolio::new(Pubkey::default());
        p.positions[0] = Position {
            instrument_id: 1,
            qty: 100,
            entry_vwap: 50_000_000,
            ..Position::default()
        };
        p.positions_len = 1;

        let found = p.find_position(1).unwrap();
        assert_eq!(found.1.qty, 100);

        assert!(p.find_position(2).is_none());
    }
}
