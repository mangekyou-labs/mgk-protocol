//! Invocation-local market identity; legacy addresses remain byte-for-byte stable.
use pinocchio::{
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
};

/// Immutable identity carried explicitly through dispatch and CPI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarketContext {
    Legacy,
    Scoped { market_seed: [u8; 32] },
}

impl MarketContext {
    pub fn registry_pda(&self, core_program: &Pubkey) -> (Pubkey, u8) {
        match self {
            Self::Legacy => find_program_address(&[b"registry"], core_program),
            Self::Scoped { market_seed } => {
                find_program_address(&[b"registry", market_seed], core_program)
            }
        }
    }

    /// Derive a child; the registry key scopes children owned by either program.
    /// `extra` contains only the instruction's fixed, protocol-defined seeds.
    pub fn child_pda(&self, tag: &[u8], extra: &[&[u8]], owner: &Pubkey) -> (Pubkey, u8) {
        let registry = self.registry_pda(&crate::program_ids::PERPS_CORE_ID).0;
        let mut seeds: [&[u8]; 16] = [&[]; 16];
        seeds[0] = tag;
        let start = match self {
            Self::Legacy => 1,
            Self::Scoped { .. } => {
                seeds[1] = &registry;
                2
            }
        };
        assert!(extra.len() <= 16 - start);
        seeds[start..start + extra.len()].copy_from_slice(extra);
        find_program_address(&seeds[..start + extra.len()], owner)
    }
}

/// Decode exactly one envelope. Empty, truncated and nested envelopes fail closed.
pub fn decode(data: &[u8], outer: u8) -> Result<(MarketContext, &[u8]), ProgramError> {
    let first = *data.first().ok_or(ProgramError::InvalidInstructionData)?;
    if first != outer {
        return Ok((MarketContext::Legacy, data));
    }
    if data.len() < 34 || data[33] == outer {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut market_seed = [0; 32];
    market_seed.copy_from_slice(&data[1..33]);
    Ok((MarketContext::Scoped { market_seed }, &data[33..]))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn envelopes_bind_one_namespace_and_reject_nesting() {
        let mut wire = [7u8; 35];
        wire[0] = 29;
        wire[33] = 2;
        assert_eq!(
            decode(&wire, 29),
            Ok((
                MarketContext::Scoped {
                    market_seed: [7; 32]
                },
                &wire[33..]
            ))
        );
        assert_eq!(
            decode(&[2, 1], 29),
            Ok((MarketContext::Legacy, &[2, 1][..]))
        );
        assert!(decode(&wire[..33], 29).is_err());
        wire[33] = 29;
        assert!(decode(&wire, 29).is_err());
    }
}
