//! MGK Oracle Program
//!
//! Minimal price oracle for Surfpool testing. Provides price feeds for instruments.
//!
//! ## Instructions
//!
//! - **Initialize** (0): Create a new price oracle for an instrument
//! - **UpdatePrice** (1): Update the price data (authority only)
//! - **SetAuthority** (2): Transfer authority to a new key (current authority only)
//! - **Activate** (3): Enable price reads (authority only)
//! - **Deactivate** (4): Disable price reads (authority only)
//!
//! ## Account Structure
//!
//! ```text
//! PriceOracle (128 bytes):
//!   0   header: AccountHeader - discriminator (PRICE_ORACLE = 9) + layout version (1)
//!   8   _unused: u8
//!   9   bump: u8             - PDA bump seed
//!   10  is_active: u8        - Whether price reads are enabled
//!   16  authority: Pubkey    - Who can update prices
//!   48  instrument: Pubkey   - Which instrument
//!   80  price: i64           - Current price (scaled)
//!   88  timestamp: i64       - Last update time
//!   96  confidence: i64      - Price confidence interval
//! ```
//!
//! Every handler other than Initialize checks the header on load. A wrong
//! discriminator is rejected with `MgkError::InvalidAccountDiscriminator` (8)
//! and a wrong layout version with `MgkError::UnsupportedLayoutVersion` (9).

#![cfg_attr(target_os = "solana", no_std)]

// Always expose entrypoint for testing
pub mod entrypoint;

pub mod instructions;
pub mod state;

// Panic handler for no_std builds (only for Solana BPF)
#[cfg(all(target_os = "solana", not(test)))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

pub use state::{PriceOracle, PRICE_ORACLE_SIZE};
