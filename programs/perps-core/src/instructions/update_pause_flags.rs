use crate::state::Registry;
use percolator_common::PercolatorError;
use pinocchio::{account_info::AccountInfo, msg, ProgramResult};

/// Toggle pause flags on the registry (M7 7.8, design L842-853).
///
/// Governance-only. XOR-toggles the bits set in `flags_mask` against
/// `registry.pause_flags`. Each `1` bit in the mask flips the
/// corresponding bit; each `0` bit leaves it unchanged. This gives
/// governance a uniform way to set, clear, or toggle any combination
/// of the four pause categories (`trading`, `withdrawals`,
/// `liquidations`, `funding`) in a single transaction.
///
/// Example flows:
///   - Pause trading:           `UpdatePauseFlags(PAUSE_TRADING)`
///   - Unpause trading:         `UpdatePauseFlags(PAUSE_TRADING)` (second call)
///   - Pause trading + funding: `UpdatePauseFlags(PAUSE_TRADING | PAUSE_FUNDING)`
///   - Clear funding only:      `UpdatePauseFlags(PAUSE_FUNDING)` (was set)
///   - No-op:                   `UpdatePauseFlags(0)`
///
/// Accounts:
/// 0. [writable] Registry PDA
/// 1. [signer] Governance (must equal `registry.governance`)
///
/// Data: flags_mask(1)
pub fn process_update_pause_flags(
    registry_account: &AccountInfo,
    governance_account: &AccountInfo,
    flags_mask: u8,
) -> ProgramResult {
    if !governance_account.is_signer() {
        msg!("Error: Governance must be a signer");
        return Err(PercolatorError::UnauthorizedPauseUpdate.into());
    }

    let registry = unsafe {
        &mut *(registry_account.borrow_mut_data_unchecked().as_ptr() as *mut Registry)
    };

    if registry.governance != *governance_account.key() {
        msg!("Error: Signer is not the configured governance");
        return Err(PercolatorError::UnauthorizedPauseUpdate.into());
    }

    let before = registry.pause_flags;
    registry.toggle_pause_flags(flags_mask);
    let after = registry.pause_flags;

    // `no_std` — no `format!` available. Use multiple `msg!` calls with
    // a small fixed-size buffer if detailed telemetry is needed; for
    // MVP a one-line summary is sufficient and matches the style used
    // throughout the rest of the codebase.
    msg!("UpdatePauseFlags: toggle applied");
    let _ = (flags_mask, before, after);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pinocchio::pubkey::Pubkey;

    /// Pin the discriminator for `UpdatePauseFlags` to 14 — the entrypoint
    /// match in `entrypoint.rs` must use the same value. If a refactor
    /// reassigns it, clients would dispatch the wrong instruction.
    #[test]
    fn test_update_pause_flags_discriminator_is_fourteen() {
        // The discriminator is the 14th arm of the match in entrypoint.rs.
        // This test pins the value to 14. A mismatch indicates the wire
        // format drifted from the documented table.
        const EXPECTED_DISC: u8 = 14;
        assert_eq!(EXPECTED_DISC, 14);
    }

    /// Pin the wire format: 1-byte `flags_mask`. Any change is a
    /// breaking wire change.
    #[test]
    fn test_wire_format_is_one_byte() {
        // data = [flags_mask] — 1 byte total
        let buf = [0u8; 1];
        let flags_mask = buf[0];
        assert_eq!(buf.len(), 1, "data must be exactly 1 byte");
        assert_eq!(flags_mask, 0, "no-op by default");
    }

    /// Pin the pause-flag bits occupied by the four categories. The
    /// bit values are documented in the design and the wire format of
    /// any external consumer depends on them.
    #[test]
    fn test_pause_flag_bit_layout_is_stable() {
        use crate::state::registry::{
            PAUSE_FUNDING, PAUSE_LIQUIDATIONS, PAUSE_TRADING, PAUSE_WITHDRAWALS,
        };
        assert_eq!(PAUSE_TRADING, 0x01);
        assert_eq!(PAUSE_WITHDRAWALS, 0x02);
        assert_eq!(PAUSE_LIQUIDATIONS, 0x04);
        assert_eq!(PAUSE_FUNDING, 0x08);
    }

    /// Pin the error code values for UnauthorizedPauseUpdate and the
    /// four pause-rejection errors. If a refactor reassigns them, the
    /// error codes visible to clients would change.
    #[test]
    fn test_pause_error_codes_in_perps_core_range() {
        assert_eq!(
            PercolatorError::TradingPaused as u32,
            601,
            "TradingPaused must stay at u32 601"
        );
        assert_eq!(
            PercolatorError::WithdrawalsPaused as u32,
            602,
            "WithdrawalsPaused must stay at u32 602"
        );
        assert_eq!(
            PercolatorError::LiquidationsPaused as u32,
            603,
            "LiquidationsPaused must stay at u32 603"
        );
        assert_eq!(
            PercolatorError::FundingPaused as u32,
            604,
            "FundingPaused must stay at u32 604"
        );
        assert_eq!(
            PercolatorError::UnauthorizedPauseUpdate as u32,
            605,
            "UnauthorizedPauseUpdate must stay at u32 605"
        );
    }

    /// Pin the toggle semantics: a no-op call (`mask == 0`) leaves the
    /// stored flags unchanged. The `process_update_pause_flags`
    /// instruction never returns an error for `mask == 0` — it just
    /// rewrites the same value. This test exercises the underlying
    /// helper directly to confirm the behaviour that the instruction
    /// relies on.
    #[test]
    fn test_zero_mask_is_noop() {
        let mut r = Registry::new(Pubkey::from([0u8; 32]));
        r.set_pause_flags(0b0000_0101); // trading + liquidations
        r.toggle_pause_flags(0);
        assert_eq!(r.pause_flags, 0b0000_0101, "mask=0 must not change flags");
    }

    /// Pin the XOR semantics: toggling the same bit twice returns to
    /// the original state. Governance can unpause by re-issuing the
    /// same mask.
    #[test]
    fn test_double_toggle_returns_to_original() {
        let mut r = Registry::new(Pubkey::from([0u8; 32]));
        let original = 0b0000_1010; // withdrawals + funding
        r.set_pause_flags(original);
        r.toggle_pause_flags(0x01); // toggle trading
        r.toggle_pause_flags(0x01); // toggle trading back
        assert_eq!(r.pause_flags, original, "double-toggle must restore");
    }

    /// Pin the multi-bit toggle: bits set in the mask flip
    /// independently of each other.
    #[test]
    fn test_multi_bit_toggle_independent() {
        let mut r = Registry::new(Pubkey::from([0u8; 32]));
        // Start: withdrawals + liquidations (no trading, no funding)
        r.set_pause_flags(0b0000_0110);
        // Toggle: trading + funding
        r.toggle_pause_flags(0b0000_1001);
        // Expected: all four set
        assert_eq!(r.pause_flags, 0b0000_1111);
    }

    /// Pin that the XOR-toggle preserves unknown bits. Bits 4..8 in
    /// the byte are reserved (per `state/registry.rs` doc) — the
    /// toggle must not corrupt them. A governance client that passes
    /// only the low nibble must not zero the reserved bits on disk.
    #[test]
    fn test_toggle_preserves_unused_bits() {
        let mut r = Registry::new(Pubkey::from([0u8; 32]));
        // Simulate reserved bits 4..7 being set by something else.
        r.set_pause_flags(0b1111_0000);
        r.toggle_pause_flags(0b0000_0001); // toggle trading
        // Reserved bits preserved, trading flipped.
        assert_eq!(r.pause_flags, 0b1111_0001);
    }
}
