//! Shared conversion-price validity rules for the restricted demo.
use crate::{
    layout::{check_header, discriminator, LAYOUT_VERSION_1},
    MgkError,
};
use pinocchio::{account_info::AccountInfo, pubkey::Pubkey};

/// Maximum age includes the exact 60-second boundary.
pub const MAX_PRICE_AGE_SECONDS: i64 = 60;

/// Validate the versioned oracle payload without casting untrusted bytes to a struct.
/// Confidence is an absolute price dispersion in the same 1e6 scale as price.
pub fn validate_price_data(data: &[u8], instrument: &Pubkey, now: i64) -> Result<i64, MgkError> {
    if data.len() < 128 {
        return Err(MgkError::InvalidAccount);
    }
    check_header(data, discriminator::PRICE_ORACLE, LAYOUT_VERSION_1)?;
    if data[10] != 1 || &data[48..80] != instrument {
        return Err(MgkError::InvalidAccount);
    }
    let price = i64::from_le_bytes(
        data[80..88]
            .try_into()
            .map_err(|_| MgkError::InvalidAccount)?,
    );
    let timestamp = i64::from_le_bytes(
        data[88..96]
            .try_into()
            .map_err(|_| MgkError::InvalidAccount)?,
    );
    let confidence = i64::from_le_bytes(
        data[96..104]
            .try_into()
            .map_err(|_| MgkError::InvalidAccount)?,
    );
    if price <= 0 || confidence < 0 || (confidence as i128) * 100 > price as i128 {
        return Err(MgkError::InvalidPrice);
    }
    let age = now.checked_sub(timestamp).ok_or(MgkError::StalePrice)?;
    if timestamp <= 0 || !(0..=MAX_PRICE_AGE_SECONDS).contains(&age) {
        return Err(MgkError::StalePrice);
    }
    Ok(price)
}

/// Read a conversion price only from the configured oracle, owned by the oracle program.
/// Callers supply the trusted instrument account key and the runtime clock time.
pub fn read_price(
    account: &AccountInfo,
    expected_oracle: &Pubkey,
    instrument: &Pubkey,
    now: i64,
) -> Result<i64, pinocchio::program_error::ProgramError> {
    if account.key() != expected_oracle {
        return Err(MgkError::InvalidAccount.into());
    }
    if account.owner() != &crate::program_ids::mgk_oracle_program_id() {
        return Err(MgkError::InvalidAccountOwner.into());
    }
    let data = account.try_borrow_data()?;
    validate_price_data(&data, instrument, now).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> [u8; 128] {
        let mut data = [0; 128];
        data[0] = discriminator::PRICE_ORACLE;
        data[1] = LAYOUT_VERSION_1;
        data[10] = 1;
        data[48..80].copy_from_slice(&[7; 32]);
        data[80..88].copy_from_slice(&100_000_000i64.to_le_bytes());
        data[88..96].copy_from_slice(&1000i64.to_le_bytes());
        data[96..104].copy_from_slice(&1_000_000i64.to_le_bytes());
        data
    }
    #[test]
    fn conversion_price_accepts_exactly_sixty_seconds_and_one_percent() {
        assert_eq!(
            validate_price_data(&fixture(), &[7; 32], 1060),
            Ok(100_000_000)
        );
    }
    #[test]
    fn rejects_stale_future_zero_and_overflowing_timestamps() {
        for timestamp in [999i64, 1061, 0, i64::MIN] {
            let mut data = fixture();
            data[88..96].copy_from_slice(&timestamp.to_le_bytes());
            assert_eq!(
                validate_price_data(&data, &[7; 32], 1060),
                Err(MgkError::StalePrice)
            );
        }
    }
    #[test]
    fn rejects_excess_confidence_and_nonpositive_prices_without_overflow() {
        for (price, confidence) in [
            (100_000_000i64, 1_000_001i64),
            (0, 0),
            (-1, 0),
            (100, -1),
            (i64::MAX, i64::MAX),
        ] {
            let mut data = fixture();
            data[80..88].copy_from_slice(&price.to_le_bytes());
            data[96..104].copy_from_slice(&confidence.to_le_bytes());
            assert_eq!(
                validate_price_data(&data, &[7; 32], 1060),
                Err(MgkError::InvalidPrice)
            );
        }
        let mut data = fixture();
        data[80..88].copy_from_slice(&i64::MAX.to_le_bytes());
        data[96..104].copy_from_slice(&(i64::MAX / 100).to_le_bytes());
        assert_eq!(validate_price_data(&data, &[7; 32], 1060), Ok(i64::MAX));
    }
    #[test]
    fn rejects_inactive_foreign_instrument_and_malformed_layouts() {
        let data = fixture();
        assert!(validate_price_data(&data[..127], &[7; 32], 1060).is_err());
        assert!(validate_price_data(&data, &[8; 32], 1060).is_err());
        for (offset, value) in [(0, 0), (1, 2), (10, 0), (10, 2)] {
            let mut data = fixture();
            data[offset] = value;
            assert!(validate_price_data(&data, &[7; 32], 1060).is_err());
        }
    }
}
