use mgk_common::layout::{load_account, load_account_mut};
use crate::state::{Batch, BatchStatus, Registry};
use mgk_common::MgkError;
use pinocchio::{
    account_info::AccountInfo,
    msg,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

/// Decide whether a batch may leave the collection window at `slot`.
///
/// A batch closes once it holds at least one commitment and either the
/// commit deadline has passed or `n_min` commitments are in (`n_min == 0`
/// means time-only). An empty batch never closes (issue 74): it stays open
/// and its deadline restarts on the first post.
pub fn close_gate(batch: &Batch, registry: &Registry, slot: u64) -> Result<(), MgkError> {
    if batch.status != BatchStatus::Committing {
        msg!("Error: Batch not in committing phase");
        return Err(MgkError::InvalidInstruction);
    }
    if batch.total_commitments == 0 {
        msg!("Error: Cannot close an empty batch");
        return Err(MgkError::BatchEmpty);
    }
    let past_deadline = slot >= batch.commit_deadline_slot;
    let enough_posts = registry.n_min == 0 || batch.total_commitments >= registry.n_min;
    if !past_deadline && !enough_posts {
        msg!("Error: Cannot close batch — deadline not reached and insufficient posts");
        return Err(MgkError::InvalidInstruction);
    }
    Ok(())
}

pub fn process_close_committing(
    _program_id: &Pubkey,
    batch_account: &AccountInfo,
    registry_account: &AccountInfo,
) -> ProgramResult {
    let batch = unsafe { load_account_mut::<Batch>(batch_account)? };
    let registry =
        unsafe { load_account::<Registry>(registry_account)? };

    // A trading pause blocks only new exposure; clearing has its own flag.
    if registry.is_clears_paused() {
        msg!("Error: Clears are paused");
        return Err(MgkError::OperationPaused.into());
    }

    // Entrypoint authenticates the canonical current batch before delegation.
    let current_slot = Clock::get()?.slot;
    close_gate(batch, registry, current_slot)?;

    // DFBA: skip reveal — go straight to Clearing for DfbaClear crank.
    batch.status = BatchStatus::Clearing;
    batch.reveal_deadline_slot = current_slot; // unused in DFBA
    batch.total_revealed = 0;
    batch.close_slot = current_slot;
    batch.shuffle_seed = 0;
    batch.mark_valid = 0;
    batch.liq_paused = 1;

    msg!("CloseCollecting: Batch transitioned to Clearing (DFBA)");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry(n_min: u32) -> Registry {
        let mut r: Registry = unsafe { core::mem::zeroed() };
        r.n_min = n_min;
        r
    }

    fn committing(total_commitments: u32, deadline: u64) -> Batch {
        let mut b = Batch::new(7);
        b.status = BatchStatus::Committing;
        b.commit_deadline_slot = deadline;
        b.total_commitments = total_commitments;
        b
    }

    #[test]
    fn empty_batch_cannot_close_even_past_deadline() {
        let r = registry(0);
        assert_eq!(close_gate(&committing(0, 100), &r, 500), Err(MgkError::BatchEmpty));
    }

    #[test]
    fn batch_with_one_post_closes_past_deadline() {
        assert_eq!(close_gate(&committing(1, 100), &registry(5), 100), Ok(()));
    }

    #[test]
    fn batch_closes_before_deadline_once_n_min_reached() {
        assert_eq!(close_gate(&committing(3, 100), &registry(3), 10), Ok(()));
    }

    #[test]
    fn batch_below_n_min_before_deadline_stays_open() {
        assert_eq!(
            close_gate(&committing(2, 100), &registry(3), 10),
            Err(MgkError::InvalidInstruction)
        );
    }

    #[test]
    fn non_committing_batch_is_rejected() {
        let mut b = committing(1, 0);
        b.status = BatchStatus::Clearing;
        assert_eq!(close_gate(&b, &registry(0), 10), Err(MgkError::InvalidInstruction));
    }
}
