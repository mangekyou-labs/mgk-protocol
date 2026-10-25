//! Account discriminator and layout-version header (spec 13, issue 16).
//!
//! Every account owned by an MGK program starts with an [`AccountHeader`]:
//!
//! ```text
//! offset 0  u8       discriminator   which account type this is (0 = uninitialised)
//! offset 1  u8       layout_version  which byte layout of that type
//! offset 2  [u8; 6]  reserved        zero; keeps the body 8-byte aligned
//! ```
//!
//! The header sits at offset 0 so an indexer can `memcmp`-filter
//! `getProgramAccounts` on the first byte(s). Programs reject an account whose
//! discriminator is not the one they expect (`InvalidAccountDiscriminator`)
//! and an account whose layout version they do not understand
//! (`UnsupportedLayoutVersion`) before reading any field.

use crate::error::MgkError;

/// Size in bytes of [`AccountHeader`].
pub const ACCOUNT_HEADER_LEN: usize = 8;

/// Current layout version of every account type. Bump per type, in lock step
/// with any size or offset change, when a layout migration is introduced.
pub const LAYOUT_VERSION_1: u8 = 1;

/// Account discriminators. `0` is reserved for "uninitialised / zeroed".
pub mod discriminator {
    pub const UNINITIALIZED: u8 = 0;
    pub const REGISTRY: u8 = 1;
    pub const BATCH: u8 = 2;
    pub const COMMITMENT: u8 = 3;
    pub const PORTFOLIO: u8 = 4;
    pub const VAULT: u8 = 5;
    pub const INSTRUMENT: u8 = 6;
    pub const ORDER_BOOK: u8 = 7;
    pub const BATCH_RESULTS: u8 = 8;
    pub const PRICE_ORACLE: u8 = 9;
    pub const SLAB: u8 = 10;
}

/// The 8-byte header at the start of every MGK account.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AccountHeader {
    pub discriminator: u8,
    pub layout_version: u8,
    pub _reserved: [u8; 6],
}

impl AccountHeader {
    pub const LEN: usize = ACCOUNT_HEADER_LEN;

    #[inline]
    pub const fn new(discriminator: u8, layout_version: u8) -> Self {
        Self {
            discriminator,
            layout_version,
            _reserved: [0; 6],
        }
    }

    /// Header for the current layout of `T`.
    #[inline]
    pub const fn of<T: AccountLayout>() -> Self {
        Self::new(T::DISCRIMINATOR, T::LAYOUT_VERSION)
    }
}

/// An account body type that begins with an [`AccountHeader`].
///
/// # Safety
/// Implementors must be `#[repr(C)]` (or `repr(C, packed)`) plain-old-data
/// whose first field is an `AccountHeader` at offset 0, valid for any bit
/// pattern the owning program accepts after the header check, and no larger
/// than the account's data.
pub unsafe trait AccountLayout: Copy {
    const DISCRIMINATOR: u8;
    const LAYOUT_VERSION: u8;
}

/// Validate the header of raw account data without reading the body.
///
/// Errors:
/// * `InvalidAccount`: shorter than a header.
/// * `InvalidAccountDiscriminator`: not the expected account type (this
///   includes zeroed, uninitialised accounts).
/// * `UnsupportedLayoutVersion`: right type, version this build cannot read.
#[inline]
pub fn check_header(data: &[u8], discriminator: u8, layout_version: u8) -> Result<(), MgkError> {
    if data.len() < ACCOUNT_HEADER_LEN {
        return Err(MgkError::InvalidAccount);
    }
    if data[0] != discriminator {
        return Err(MgkError::InvalidAccountDiscriminator);
    }
    if data[1] != layout_version {
        return Err(MgkError::UnsupportedLayoutVersion);
    }
    Ok(())
}

/// Write a fresh header at the start of `data` (used by `init` paths).
#[inline]
pub fn write_header(
    data: &mut [u8],
    discriminator: u8,
    layout_version: u8,
) -> Result<(), MgkError> {
    if data.len() < ACCOUNT_HEADER_LEN {
        return Err(MgkError::InvalidAccount);
    }
    data[0] = discriminator;
    data[1] = layout_version;
    data[2..ACCOUNT_HEADER_LEN].fill(0);
    Ok(())
}

/// Validate the header and return the bytes after it. For accounts that are
/// raw byte buffers (e.g. batch results) rather than `repr(C)` structs.
#[inline]
pub fn body(data: &[u8], discriminator: u8, layout_version: u8) -> Result<&[u8], MgkError> {
    check_header(data, discriminator, layout_version)?;
    Ok(&data[ACCOUNT_HEADER_LEN..])
}

/// Stamp a fresh header and return the bytes after it, for the program that
/// owns and (re)writes a raw byte-buffer account such as batch results.
#[inline]
pub fn stamp_body_mut(
    data: &mut [u8],
    discriminator: u8,
    layout_version: u8,
) -> Result<&mut [u8], MgkError> {
    write_header(data, discriminator, layout_version)?;
    Ok(&mut data[ACCOUNT_HEADER_LEN..])
}

/// Borrow initialised account data as `&T` after checking size and header.
///
/// Like the raw casts this replaces, no alignment check is made: the runtime
/// hands programs 8-byte aligned account data, and every account body type
/// is laid out for that.
#[inline]
pub fn load<T: AccountLayout>(data: &[u8]) -> Result<&T, MgkError> {
    check_header(data, T::DISCRIMINATOR, T::LAYOUT_VERSION)?;
    if data.len() < core::mem::size_of::<T>() {
        return Err(MgkError::InvalidAccount);
    }
    // SAFETY: `AccountLayout` guarantees `T` is POD with a header at offset 0;
    // size and header were checked above.
    Ok(unsafe { &*(data.as_ptr() as *const T) })
}

/// Mutable counterpart of [`load`].
#[inline]
pub fn load_mut<T: AccountLayout>(data: &mut [u8]) -> Result<&mut T, MgkError> {
    check_header(data, T::DISCRIMINATOR, T::LAYOUT_VERSION)?;
    if data.len() < core::mem::size_of::<T>() {
        return Err(MgkError::InvalidAccount);
    }
    // SAFETY: as in `load`.
    Ok(unsafe { &mut *(data.as_mut_ptr() as *mut T) })
}

/// Stamp the header of a new account and borrow it as `&mut T`, for `init`
/// paths. The body is left as-is (callers run `initialize_in_place`).
#[inline]
pub fn init_mut<T: AccountLayout>(data: &mut [u8]) -> Result<&mut T, MgkError> {
    if data.len() < core::mem::size_of::<T>() {
        return Err(MgkError::InvalidAccount);
    }
    write_header(data, T::DISCRIMINATOR, T::LAYOUT_VERSION)?;
    // SAFETY: as in `load`; size checked and header just written.
    Ok(unsafe { &mut *(data.as_mut_ptr() as *mut T) })
}

/// Load from a pinocchio `AccountInfo` without runtime borrow tracking.
///
/// # Safety
/// Same contract as `AccountInfo::borrow_data_unchecked`: the caller must not
/// create aliasing mutable references to the same account.
#[inline]
pub unsafe fn load_account<T: AccountLayout>(
    account: &pinocchio::account_info::AccountInfo,
) -> Result<&T, MgkError> {
    load::<T>(account.borrow_data_unchecked())
}

/// [`init_mut`] on a pinocchio `AccountInfo`.
///
/// # Safety
/// Same contract as `AccountInfo::borrow_mut_data_unchecked`.
#[inline]
#[allow(clippy::mut_from_ref)]
pub unsafe fn init_account_mut<T: AccountLayout>(
    account: &pinocchio::account_info::AccountInfo,
) -> Result<&mut T, MgkError> {
    init_mut::<T>(account.borrow_mut_data_unchecked())
}

/// Mutable counterpart of [`load_account`].
///
/// # Safety
/// Same contract as `AccountInfo::borrow_mut_data_unchecked`.
#[inline]
#[allow(clippy::mut_from_ref)]
pub unsafe fn load_account_mut<T: AccountLayout>(
    account: &pinocchio::account_info::AccountInfo,
) -> Result<&mut T, MgkError> {
    load_mut::<T>(account.borrow_mut_data_unchecked())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Probe {
        header: AccountHeader,
        value: u64,
    }

    unsafe impl AccountLayout for Probe {
        const DISCRIMINATOR: u8 = 200;
        const LAYOUT_VERSION: u8 = 3;
    }

    fn probe_bytes(disc: u8, version: u8, value: u64) -> [u8; 16] {
        let mut b = [0u8; 16];
        b[0] = disc;
        b[1] = version;
        b[8..16].copy_from_slice(&value.to_le_bytes());
        b
    }

    #[test]
    fn header_is_eight_bytes_with_disc_then_version_at_front() {
        assert_eq!(core::mem::size_of::<AccountHeader>(), ACCOUNT_HEADER_LEN);
        let h = AccountHeader::new(7, 2);
        let raw: [u8; 8] = unsafe { core::mem::transmute(h) };
        assert_eq!(raw, [7, 2, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn discriminators_are_unique_and_nonzero() {
        use discriminator::*;
        let all = [
            REGISTRY, BATCH, COMMITMENT, PORTFOLIO, VAULT, INSTRUMENT, ORDER_BOOK,
            BATCH_RESULTS, PRICE_ORACLE, SLAB,
        ];
        for (i, a) in all.iter().enumerate() {
            assert_ne!(*a, UNINITIALIZED);
            for b in &all[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }

    #[test]
    fn load_accepts_matching_header() {
        let b = probe_bytes(200, 3, 42);
        let p = load::<Probe>(&b).unwrap();
        assert_eq!(p.value, 42);
    }

    #[test]
    fn load_rejects_wrong_discriminator() {
        let b = probe_bytes(201, 3, 42);
        assert_eq!(
            load::<Probe>(&b).err(),
            Some(MgkError::InvalidAccountDiscriminator)
        );
    }

    #[test]
    fn load_rejects_zeroed_uninitialised_account() {
        let b = [0u8; 16];
        assert_eq!(
            load::<Probe>(&b).err(),
            Some(MgkError::InvalidAccountDiscriminator)
        );
    }

    #[test]
    fn load_rejects_unsupported_layout_version() {
        let b = probe_bytes(200, 4, 42);
        assert_eq!(
            load::<Probe>(&b).err(),
            Some(MgkError::UnsupportedLayoutVersion)
        );
        let b = probe_bytes(200, 2, 42);
        assert_eq!(
            load::<Probe>(&b).err(),
            Some(MgkError::UnsupportedLayoutVersion)
        );
    }

    #[test]
    fn wrong_discriminator_wins_over_wrong_version() {
        let b = probe_bytes(9, 9, 0);
        assert_eq!(
            load::<Probe>(&b).err(),
            Some(MgkError::InvalidAccountDiscriminator)
        );
    }

    #[test]
    fn load_rejects_short_data() {
        assert_eq!(load::<Probe>(&[200, 3]).err(), Some(MgkError::InvalidAccount));
        let b = probe_bytes(200, 3, 1);
        assert_eq!(load::<Probe>(&b[..12]).err(), Some(MgkError::InvalidAccount));
    }

    #[test]
    fn load_mut_checks_and_writes_through() {
        let mut b = probe_bytes(200, 3, 1);
        load_mut::<Probe>(&mut b).unwrap().value = 99;
        assert_eq!(u64::from_le_bytes(b[8..16].try_into().unwrap()), 99);

        let mut bad = probe_bytes(1, 3, 1);
        assert_eq!(
            load_mut::<Probe>(&mut bad).err(),
            Some(MgkError::InvalidAccountDiscriminator)
        );
        let mut old = probe_bytes(200, 1, 1);
        assert_eq!(
            load_mut::<Probe>(&mut old).err(),
            Some(MgkError::UnsupportedLayoutVersion)
        );
    }

    #[test]
    fn write_header_stamps_account_and_clears_reserved() {
        let mut b = [0xFFu8; 16];
        write_header(&mut b, 200, 3).unwrap();
        assert_eq!(&b[..8], &[200, 3, 0, 0, 0, 0, 0, 0]);
        assert_eq!(&b[8..], &[0xFF; 8]);
        assert!(load::<Probe>(&b).is_ok());
        assert_eq!(
            write_header(&mut [0u8; 4], 1, 1),
            Err(MgkError::InvalidAccount)
        );
    }

    #[test]
    fn body_skips_header_after_checking_it() {
        let b = probe_bytes(200, 3, 42);
        assert_eq!(body(&b, 200, 3).unwrap(), &42u64.to_le_bytes());
        assert_eq!(
            body(&b, 201, 3).err(),
            Some(MgkError::InvalidAccountDiscriminator)
        );
        assert_eq!(
            body(&b, 200, 2).err(),
            Some(MgkError::UnsupportedLayoutVersion)
        );
        assert_eq!(body(&[200, 3], 200, 3).err(), Some(MgkError::InvalidAccount));
    }

    #[test]
    fn stamp_body_mut_writes_header_and_returns_body() {
        let mut b = [0u8; 16];
        {
            let body = stamp_body_mut(&mut b, 200, 3).unwrap();
            assert_eq!(body.len(), 8);
            body[0] = 9;
        }
        assert_eq!(&b[..8], &[200, 3, 0, 0, 0, 0, 0, 0]);
        assert_eq!(b[8], 9);
        assert_eq!(
            stamp_body_mut(&mut [0u8; 4], 200, 3).err(),
            Some(MgkError::InvalidAccount)
        );
    }

    #[test]
    fn init_mut_stamps_header_and_returns_typed_body() {
        let mut b = [0xFFu8; 16];
        {
            let p = init_mut::<Probe>(&mut b).unwrap();
            p.value = 5;
        }
        assert_eq!(&b[..8], &[200, 3, 0, 0, 0, 0, 0, 0]);
        assert_eq!(load::<Probe>(&b).unwrap().value, 5);
        assert_eq!(
            init_mut::<Probe>(&mut [0u8; 12]).err(),
            Some(MgkError::InvalidAccount)
        );
    }

    #[test]
    fn header_of_matches_layout_constants() {
        assert_eq!(AccountHeader::of::<Probe>(), AccountHeader::new(200, 3));
    }
}
