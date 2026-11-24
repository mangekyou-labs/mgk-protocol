//! CloseSettledBatch (disc 30): reclaim rent from a settled batch and its
//! consumed Results account once the batch has aged out of the close window.
use crate::state::{Batch, BatchStatus};
use mgk_common::{market::MarketContext, MgkError};
use pinocchio::{account_info::AccountInfo, instruction::AccountMeta, ProgramResult};

/// A settled batch may be closed only once `CLOSE_WINDOW` newer batches have
/// been created: `batch_id + CLOSE_WINDOW < registry.batch_id_counter`.
/// The counter is `current_batch_id + 1`, so this equals
/// `batch_id <= current_batch_id - CLOSE_WINDOW`.
pub const CLOSE_WINDOW: u64 = 3;

/// Pure close precondition. `results_spent` is whether the matcher Results
/// account for this batch has been consumed by SettleBatch.
pub fn close_settled_gate(
    batch: &Batch,
    batch_id_counter: u64,
    results_spent: bool,
) -> Result<(), MgkError> {
    if batch.status != BatchStatus::Settled {
        return Err(MgkError::BatchNotSettled);
    }
    let aged_out = batch
        .batch_id
        .checked_add(CLOSE_WINDOW)
        .is_some_and(|edge| edge < batch_id_counter);
    if !aged_out || !results_spent {
        return Err(MgkError::BatchNotClosable);
    }
    Ok(())
}

/// Close the matcher Results account (CPI to matcher `CloseResults`, disc 11,
/// registry-signed) and then the Batch PDA, sending both rents to `recipient`.
/// Accounts must already be validated and the gate passed. The CPI runs first:
/// a closed account is zeroed on the next CPI boundary.
pub fn process_close_settled_batch(
    context: MarketContext,
    batch_account: &AccountInfo,
    results_account: &AccountInfo,
    registry_account: &AccountInfo,
    recipient: &AccountInfo,
    matcher_program: &AccountInfo,
    batch_id: u64,
) -> ProgramResult {
    let mut data = [0u8; 9];
    data[0] = 11;
    data[1..].copy_from_slice(&batch_id.to_le_bytes());
    let metas = [
        AccountMeta::readonly_signer(registry_account.key()),
        AccountMeta::writable(results_account.key()),
        AccountMeta::writable(recipient.key()),
    ];
    crate::matcher_cpi::signed(
        context,
        registry_account,
        matcher_program,
        &metas,
        &[registry_account, results_account, recipient],
        &data,
    )?;
    mgk_common::matcher::close_account(batch_account, recipient)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settled(id: u64) -> Batch {
        let mut b = Batch::new(id);
        b.status = BatchStatus::Settled;
        b
    }

    #[test]
    fn settled_spent_batch_closes_once_three_newer_batches_exist() {
        // batch 4, current batch 7 (counter 8): 4 + 3 < 8.
        assert_eq!(close_settled_gate(&settled(4), 8, true), Ok(()));
    }

    #[test]
    fn batch_inside_the_close_window_is_not_closable() {
        // batch 5, current batch 7 (counter 8): 5 + 3 == 8.
        assert_eq!(
            close_settled_gate(&settled(5), 8, true),
            Err(MgkError::BatchNotClosable)
        );
    }

    #[test]
    fn current_batch_is_never_closable() {
        assert_eq!(
            close_settled_gate(&settled(7), 8, true),
            Err(MgkError::BatchNotClosable)
        );
    }

    #[test]
    fn unsettled_batch_is_not_closable() {
        for status in [
            BatchStatus::Committing,
            BatchStatus::Revealing,
            BatchStatus::Clearing,
            BatchStatus::Cleared,
        ] {
            let mut b = settled(1);
            b.status = status;
            assert_eq!(
                close_settled_gate(&b, 100, true),
                Err(MgkError::BatchNotSettled)
            );
        }
    }

    #[test]
    fn unspent_results_keep_the_batch_open() {
        assert_eq!(
            close_settled_gate(&settled(1), 100, false),
            Err(MgkError::BatchNotClosable)
        );
    }

    #[test]
    fn window_check_does_not_overflow_at_u64_max() {
        assert_eq!(
            close_settled_gate(&settled(u64::MAX), u64::MAX, true),
            Err(MgkError::BatchNotClosable)
        );
    }
}
