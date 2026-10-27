//! SetInstrumentFees (disc 22) — governance-only instrument fee retune.

use crate::state::{Instrument, Registry};
use mgk_common::layout::{load_account, load_account_mut};
use mgk_common::MgkError;
use pinocchio::{account_info::AccountInfo, msg, pubkey::Pubkey, ProgramResult};

/// Set instrument taker/maker fees (governance-only, disc 22).
///
/// Wire format (post-disc, 4 bytes):
///   taker_fee_bps(u16 LE) + maker_fee_bps(i16 LE)
///
/// Accounts:
///   0. [writable] Instrument PDA
///   1. []         Registry PDA
///   2. [signer]   Governance (must equal `registry.governance`)
pub fn process_set_instrument_fees(
    _program_id: &Pubkey,
    instrument_account: &AccountInfo,
    registry_account: &AccountInfo,
    governance_account: &AccountInfo,
    taker_fee_bps: u16,
    maker_fee_bps: i16,
) -> ProgramResult {
    if !governance_account.is_signer() {
        msg!("Error: Governance must be a signer");
        return Err(MgkError::Unauthorized.into());
    }

    let registry = unsafe { load_account::<Registry>(registry_account)? };

    if registry.governance != *governance_account.key() {
        msg!("Error: Invalid governance");
        return Err(MgkError::Unauthorized.into());
    }

    if instrument_account.data_len() < core::mem::size_of::<Instrument>() {
        msg!("Error: Instrument account too small");
        return Err(MgkError::InvalidInstruction.into());
    }

    let instrument = unsafe { load_account_mut::<Instrument>(instrument_account)? };
    apply_instrument_fees(instrument, taker_fee_bps, maker_fee_bps)?;

    msg!("SetInstrumentFees: fees updated");
    Ok(())
}

/// Restricted demo schedule: 5 bps taker, zero maker; reject all retunes.
pub fn apply_instrument_fees(
    instrument: &mut Instrument,
    taker_fee_bps: u16,
    maker_fee_bps: i16,
) -> ProgramResult {
    if taker_fee_bps != 5 || maker_fee_bps != 0 {
        return Err(MgkError::InvalidRiskParams.into());
    }
    instrument.taker_fee_bps = taker_fee_bps;
    instrument.maker_fee_bps = maker_fee_bps;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_set_instrument_fees_retunes_maker_to_zero() {
        let mut inst = Instrument::new(0, 1, 1, 100, 50);
        inst.maker_fee_bps = -2;
        inst.taker_fee_bps = 5;
        apply_instrument_fees(&mut inst, 5, 0).unwrap();
        assert_eq!(inst.taker_fee_bps, 5);
        assert_eq!(inst.maker_fee_bps, 0);
    }

    #[test]
    fn restricted_demo_rejects_every_other_fee_schedule() {
        let mut inst = Instrument::new(0, 1, 1, 100, 50);
        for (taker, maker) in [(5, -2), (7, 0), (5, 3)] {
            assert!(apply_instrument_fees(&mut inst, taker, maker).is_err());
            assert_eq!((inst.taker_fee_bps, inst.maker_fee_bps), (5, 0));
        }
    }

    #[test]
    fn test_set_instrument_fees_discriminator_is_22() {
        assert_eq!(
            crate::instructions::CoreInstruction::SetInstrumentFees as u8,
            22
        );
    }

    #[test]
    fn test_fee_field_offsets() {
        // Spec 13 / issue 16: +8 for the account header (was 52 / 54).
        assert_eq!(core::mem::offset_of!(Instrument, taker_fee_bps), 60);
        assert_eq!(core::mem::offset_of!(Instrument, maker_fee_bps), 62);
    }
}
