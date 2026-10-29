use crate::state::registry::{PAUSE_RESERVED_MASK, PAUSE_TRADING, PAUSE_WITHDRAWALS};
use crate::state::Registry;
use pinocchio::{account_info::AccountInfo, msg, ProgramResult};

/// Flags after a governance write. The trading and withdrawals bits can be
/// set here but only `Unpause` clears them (it checks the recovery conditions).
pub(crate) fn merge_governance_flags(current: u8, requested: u8) -> u8 {
    (requested | (current & (PAUSE_TRADING | PAUSE_WITHDRAWALS))) & !PAUSE_RESERVED_MASK
}

/// M7 7.8: governance-only instruction to set or clear pause flags.
///
/// Wire format: disc(1) + flags(1) = 2 bytes.
/// Accounts:
///   0. `[writable]` Registry PDA
///   1. `[signer]`   Governance (must equal `registry.governance`)
///
/// Bit layout (see `state::registry` for constants):
///   bit 0 - trading_paused      (blocks posts and clears)
///   bit 1 - withdrawals_paused  (blocks Withdraw)
///   bit 2 - liquidations_paused (blocks LiquidateUser)
///   bit 3 - funding_paused      (skips funding in SettleBatch)
///   bits 4..5 - posts / clears paused
///   bits 6..7 - reserved, masked off on write
///
/// The trading and withdrawals bits can only be raised here. `Unpause`
/// (disc 28) clears them once debt is 0 and the reserve is met.
pub fn process_set_pause_flags(
    registry: &mut Registry,
    governance_account: &AccountInfo,
    flags: u8,
) -> ProgramResult {
    registry.require_governance(governance_account)?;

    registry.set_pause_flags(merge_governance_flags(registry.pause_flags, flags));

    msg!("SetPauseFlags: flags written");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::registry::{
        PAUSE_CLEAR, PAUSE_FUNDING, PAUSE_LIQUIDATIONS, PAUSE_POST, PAUSE_TRADING,
        PAUSE_WITHDRAWALS,
    };
    use pinocchio::pubkey::Pubkey;

    /// Build a Registry with a known governance pubkey. Returns the
    /// registry value; tests construct their own AccountInfo shims.
    fn make_registry(gov_byte: u8) -> Registry {
        Registry::new(Pubkey::from([gov_byte; 32]))
    }

    #[test]
    fn governance_cannot_clear_the_trading_or_withdrawals_pause() {
        let both = PAUSE_TRADING | PAUSE_WITHDRAWALS;
        assert_eq!(merge_governance_flags(both, 0), both);
        assert_eq!(merge_governance_flags(PAUSE_TRADING, PAUSE_FUNDING), PAUSE_TRADING | PAUSE_FUNDING);
        assert_eq!(merge_governance_flags(PAUSE_WITHDRAWALS, PAUSE_POST), PAUSE_WITHDRAWALS | PAUSE_POST);
    }

    #[test]
    fn governance_can_still_set_and_clear_the_other_flags() {
        assert_eq!(merge_governance_flags(0, PAUSE_TRADING), PAUSE_TRADING);
        assert_eq!(merge_governance_flags(0, 0xFF), 0b_0011_1111);
        assert_eq!(merge_governance_flags(PAUSE_LIQUIDATIONS | PAUSE_CLEAR, 0), 0);
        assert_eq!(
            merge_governance_flags(PAUSE_TRADING | PAUSE_FUNDING, PAUSE_LIQUIDATIONS),
            PAUSE_TRADING | PAUSE_LIQUIDATIONS
        );
    }

    #[test]
    fn test_set_pause_flags_zero_clears_all() {
        let mut r = make_registry(1);
        r.pause_flags = 0x3F; // all 6 flags
        r.set_pause_flags(0);
        assert_eq!(r.pause_flags, 0);
    }

    #[test]
    fn test_set_pause_flags_writes_each_bit() {
        let mut r = make_registry(2);
        for bit in [
            PAUSE_TRADING,
            PAUSE_WITHDRAWALS,
            PAUSE_LIQUIDATIONS,
            PAUSE_FUNDING,
            PAUSE_POST,
            PAUSE_CLEAR,
        ] {
            r.set_pause_flags(bit);
            assert_eq!(r.pause_flags, bit);
        }
    }

    #[test]
    fn test_set_pause_flags_masks_reserved_bits() {
        let mut r = make_registry(3);
        r.set_pause_flags(0b_1111_1111);
        assert_eq!(r.pause_flags, 0b_0011_1111); // bits 6..7 masked off
    }

    #[test]
    fn test_set_pause_flags_does_not_alter_other_fields() {
        let mut r = make_registry(4);
        let snap_instrument_count = r.instrument_count;
        let snap_batch_id_counter = r.batch_id_counter;
        let snap_base_deposit = r.base_deposit;
        r.set_pause_flags(PAUSE_TRADING | PAUSE_LIQUIDATIONS);
        let instrument_count = r.instrument_count;
        let batch_id_counter = r.batch_id_counter;
        let base_deposit = r.base_deposit;
        assert_eq!(instrument_count, snap_instrument_count);
        assert_eq!(batch_id_counter, snap_batch_id_counter);
        assert_eq!(base_deposit, snap_base_deposit);
        assert!(r.is_trading_paused());
        assert!(r.is_liquidations_paused());
    }
}
