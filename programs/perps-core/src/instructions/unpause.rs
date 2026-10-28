//! Unpause (disc 28): admin recovery after the insurance fund was exhausted.

use crate::state::registry::{PAUSE_TRADING, PAUSE_WITHDRAWALS};
use crate::state::{Registry, Vault};
use mgk_common::MgkError;
use pinocchio::{account_info::AccountInfo, msg, ProgramResult};

/// The governance account must sign and match `registry.governance`.
pub(crate) fn require_governance(
    registry: &Registry,
    governance_account: &AccountInfo,
) -> ProgramResult {
    if !governance_account.is_signer() {
        msg!("Error: Governance must be a signer");
        return Err(MgkError::Unauthorized.into());
    }
    if registry.governance != *governance_account.key() {
        msg!("Error: Invalid governance");
        return Err(MgkError::Unauthorized.into());
    }
    Ok(())
}

/// Pure unpause rule. Recovery needs no uncovered bad debt and the fund at or
/// above the required reserve. Withdrawals resume first: trading may resume
/// only when withdrawals are not paused after this call.
pub(crate) fn apply_unpause(
    registry: &mut Registry,
    vault: &Vault,
    resume_withdrawals: bool,
    resume_trading: bool,
) -> Result<(), MgkError> {
    if !vault.recovery_ready() {
        return Err(MgkError::RecoveryConditionsNotMet);
    }
    let mut flags = registry.pause_flags;
    if resume_withdrawals {
        flags &= !PAUSE_WITHDRAWALS;
    }
    if resume_trading {
        if flags & PAUSE_WITHDRAWALS != 0 {
            return Err(MgkError::RecoveryConditionsNotMet);
        }
        flags &= !PAUSE_TRADING;
    }
    registry.set_pause_flags(flags);
    Ok(())
}

/// Lift the exhaustion pause.
///
/// Accounts:
/// 0. [writable] Registry PDA
/// 1. [] Vault PDA
/// 2. [signer] Governance
///
/// Data: resume_withdrawals(1) + resume_trading(1)
pub fn process_unpause(
    registry: &mut Registry,
    vault: &Vault,
    governance_account: &AccountInfo,
    resume_withdrawals: bool,
    resume_trading: bool,
) -> ProgramResult {
    require_governance(registry, governance_account)?;
    apply_unpause(registry, vault, resume_withdrawals, resume_trading).inspect_err(|_| {
        msg!("Error: unpause refused");
    })?;
    msg!("Unpause: flags written");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pinocchio::pubkey::Pubkey;

    fn paused_registry() -> Registry {
        let mut r = Registry::new(Pubkey::from([7u8; 32]));
        r.pause_trading_and_withdrawals();
        r
    }

    fn healthy_vault() -> Vault {
        let mut v = Vault::new();
        v.open_interest_long = 20_000;
        v.insurance_fund = 8_000_000_000;
        v
    }

    #[test]
    fn unpause_is_refused_while_bad_debt_is_outstanding() {
        let mut r = paused_registry();
        let mut v = healthy_vault();
        v.uncovered_bad_debt = 1;
        assert_eq!(
            apply_unpause(&mut r, &v, true, false),
            Err(MgkError::RecoveryConditionsNotMet)
        );
        assert!(r.is_withdrawals_paused() && r.is_trading_paused());
    }

    #[test]
    fn unpause_is_refused_while_the_reserve_is_short() {
        let mut r = paused_registry();
        let mut v = healthy_vault();
        v.insurance_fund -= 1;
        assert_eq!(
            apply_unpause(&mut r, &v, true, false),
            Err(MgkError::RecoveryConditionsNotMet)
        );
        assert!(r.is_withdrawals_paused());
    }

    #[test]
    fn withdrawals_resume_first_and_leave_trading_paused() {
        let mut r = paused_registry();
        apply_unpause(&mut r, &healthy_vault(), true, false).unwrap();
        assert!(!r.is_withdrawals_paused());
        assert!(r.is_trading_paused());
    }

    #[test]
    fn trading_cannot_resume_before_withdrawals() {
        let mut r = paused_registry();
        assert_eq!(
            apply_unpause(&mut r, &healthy_vault(), false, true),
            Err(MgkError::RecoveryConditionsNotMet)
        );
        assert!(r.is_withdrawals_paused() && r.is_trading_paused());
    }

    #[test]
    fn trading_resumes_together_with_or_after_withdrawals() {
        let mut both = paused_registry();
        apply_unpause(&mut both, &healthy_vault(), true, true).unwrap();
        assert_eq!(both.pause_flags, 0);

        let mut staged = paused_registry();
        apply_unpause(&mut staged, &healthy_vault(), true, false).unwrap();
        apply_unpause(&mut staged, &healthy_vault(), false, true).unwrap();
        assert_eq!(staged.pause_flags, 0);
    }

    #[test]
    fn unpause_keeps_every_other_flag() {
        use crate::state::registry::{PAUSE_FUNDING, PAUSE_LIQUIDATIONS};
        let mut r = paused_registry();
        r.set_pause_flags(r.pause_flags | PAUSE_FUNDING | PAUSE_LIQUIDATIONS);
        apply_unpause(&mut r, &healthy_vault(), true, true).unwrap();
        assert_eq!(r.pause_flags, PAUSE_FUNDING | PAUSE_LIQUIDATIONS);
    }
}
