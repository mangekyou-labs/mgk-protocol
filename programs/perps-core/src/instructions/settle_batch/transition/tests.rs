use super::*;

pub(in crate::instructions::settle_batch) struct TypedStates<'a, 'b, T>(pub &'a mut [&'b mut T]);
impl<T> States<T> for TypedStates<'_, '_, T> {
    fn len(&self) -> usize {
        self.0.len()
    }
    fn get_mut(&mut self, index: usize) -> &mut T {
        self.0[index]
    }
}

pub(in crate::instructions::settle_batch) struct Host {
    pub registry: Registry,
    pub vault: Vault,
    pub next: Batch,
    pub slot: u64,
    pub timestamp: i64,
    pub oracle: Option<(i64, i64, bool)>,
    pub book_error: Option<ProgramError>,
    pub next_size: usize,
    pub clock_reads: core::cell::Cell<usize>,
}
impl Host {
    pub fn new() -> Self {
        let mut registry = Registry::new([0; 32]);
        registry.t_max_slots = 20;
        Self {
            registry,
            vault: Vault::new(),
            next: Batch::new(0),
            slot: 100,
            timestamp: 1000,
            oracle: None,
            book_error: None,
            next_size: core::mem::size_of::<Batch>(),
            clock_reads: core::cell::Cell::new(0),
        }
    }
    pub fn settle(
        &mut self,
        batch: &mut Batch,
        instrument: &mut Instrument,
        results: &[u8],
        commitments: &mut [&mut Commitment],
        portfolios: &mut [&mut Portfolio],
    ) -> ProgramResult {
        super::settle(
            batch,
            instrument,
            results,
            &mut TypedStates(commitments),
            &mut TypedStates(portfolios),
            self,
        )
    }
}
impl Environment for Host {
    fn registry(&self) -> Registry {
        self.registry
    }
    fn vault(&mut self) -> &mut Vault {
        &mut self.vault
    }
    fn validate_book(&self, _: u16) -> ProgramResult {
        self.book_error.map_or(Ok(()), Err)
    }
    fn clock(&self) -> Result<Clock, ProgramError> {
        self.clock_reads.set(self.clock_reads.get() + 1);
        Ok(Clock {
            slot: self.slot,
            epoch_start_timestamp: 0,
            epoch: 0,
            leader_schedule_epoch: 0,
            unix_timestamp: self.timestamp,
        })
    }
    fn oracle(&self, _: &Pubkey) -> Option<(i64, i64, bool)> {
        self.oracle
    }
    fn set_batch_counter(&mut self, value: u64) {
        self.registry.batch_id_counter = value;
    }
    fn next_batch_size(&self) -> usize {
        self.next_size
    }
    fn next_batch(&mut self) -> &mut Batch {
        &mut self.next
    }
}

#[test]
fn full_transition_settles_and_opens_next_batch() {
    let mut host = Host::new();
    let mut batch = Batch::new(7);
    batch.status = BatchStatus::Clearing;
    let mut instrument = Instrument::new(0, 1, 1, 100, 50);
    instrument.mark_price = 90;
    host.settle(&mut batch, &mut instrument, &[0, 0], &mut [], &mut [])
        .unwrap();
    assert_eq!(batch.status, BatchStatus::Settled);
    assert_eq!(instrument.mark_price, 90);
    assert_eq!(host.next.batch_id, 8);
    assert_eq!(host.next.status, BatchStatus::Committing);
    assert_eq!(host.next.commit_deadline_slot, 120);
    assert_eq!(host.next.reveal_deadline_slot, 0);
    assert_eq!(host.clock_reads.get(), 2);
    let counter = host.registry.batch_id_counter;
    assert_eq!(counter, 1);
}

fn clearing_batch() -> Batch {
    let mut batch = Batch::new(7);
    batch.status = BatchStatus::Clearing;
    batch
}

fn fills(entries: &[(u8, u64, i64, bool, u8)]) -> Vec<u8> {
    let mut bytes = vec![0; 34 + entries.len() * 58];
    bytes[32..34].copy_from_slice(&(entries.len() as u16).to_le_bytes());
    for (i, &(user, qty, price, maker, auction)) in entries.iter().enumerate() {
        let off = 34 + i * 58;
        bytes[off..off + 32].fill(user);
        bytes[off + 40..off + 48].copy_from_slice(&qty.to_le_bytes());
        bytes[off + 48..off + 56].copy_from_slice(&price.to_le_bytes());
        bytes[off + 56] = u8::from(maker);
        bytes[off + 57] = auction;
    }
    bytes
}

#[test]
fn lookup_uses_first_portfolio_and_totals_include_missing_users() {
    let mut host = Host::new();
    let mut batch = clearing_batch();
    let mut instrument = Instrument::new(0, 1, 1, 100, 50);
    let mut first = Portfolio::new([1; 32]);
    let mut duplicate = Portfolio::new([1; 32]);
    let results = fills(&[
        (1, 2, 100, true, 0),
        (2, 3, 100, false, 1),
        (1, 0, 100, true, 0),
    ]);
    host.settle(
        &mut batch,
        &mut instrument,
        &results,
        &mut [],
        &mut [&mut first, &mut duplicate],
    )
    .unwrap();
    assert_eq!(first.positions[0].qty, 2);
    assert_eq!(duplicate.positions_len, 0);
    assert_eq!(batch.total_settled, 1);
    assert_eq!(batch.total_volume, 5);
    assert_eq!(batch.total_notional, 500);
    assert_eq!(batch.clearing_price, 100);
    assert_eq!(instrument.mark_price, 0); // VWAP fallback does not seed the mark.
}

#[test]
fn aggregate_protocol_fee_rounding_differs_from_individual_fills() {
    let mut host = Host::new();
    let mut batch = clearing_batch();
    let mut instrument = Instrument::new(0, 1, 1, 100, 50);
    let mut portfolio = Portfolio::new([1; 32]);
    let results = fills(&[(1, 1, 1000, false, 0), (1, 1, 1000, false, 0)]);
    host.settle(
        &mut batch,
        &mut instrument,
        &results,
        &mut [],
        &mut [&mut portfolio],
    )
    .unwrap();
    assert_eq!(portfolio.equity, 2000); // Each 0.5 fee truncates to zero.
    assert_eq!(host.vault.insurance_fund, 1); // Aggregate 2000 * 5 bps.
}

#[test]
fn rebates_exhaust_insurance_and_record_shortfall() {
    let mut host = Host::new();
    host.vault.insurance_fund = 1;
    let mut batch = clearing_batch();
    let mut instrument = Instrument::new(0, 1, 1, 100, 50);
    instrument.maker_fee_bps = -2;
    let mut portfolio = Portfolio::new([1; 32]);
    host.settle(
        &mut batch,
        &mut instrument,
        &fills(&[(1, 1, 10000, true, 0)]),
        &mut [],
        &mut [&mut portfolio],
    )
    .unwrap();
    assert_eq!(portfolio.equity, -9998);
    assert_eq!(host.vault.insurance_fund, 0);
    assert_eq!(host.vault.uncovered_bad_debt, 1);
}

#[test]
fn legacy_commitments_release_deposits_and_slash_pending_only_within_limit() {
    let mut host = Host::new();
    let mut batch = clearing_batch();
    batch.total_commitments = 2;
    let mut instrument = Instrument::new(0, 1, 1, 100, 50);
    let mut portfolio = Portfolio::new([1; 32]);
    portfolio.im = 30;
    let mut revealed = Commitment::new(7, [1; 32]);
    revealed.status = CommitmentStatus::Revealed;
    revealed.deposit_lamports = 10;
    let mut pending = Commitment::new(7, [1; 32]);
    pending.deposit_lamports = 20;
    let mut extra = Commitment::new(7, [1; 32]);
    extra.deposit_lamports = 99;
    // A short legacy result with no DFBA metadata selects the legacy path.
    let mut results = vec![0; 51];
    results[..2].copy_from_slice(&1u16.to_le_bytes());
    results[2..34].copy_from_slice(&portfolio.user);
    results[34..42].copy_from_slice(&2u64.to_le_bytes());
    results[42..50].copy_from_slice(&20000u64.to_le_bytes());
    host.settle(
        &mut batch,
        &mut instrument,
        &results,
        &mut [&mut revealed, &mut pending, &mut extra],
        &mut [&mut portfolio],
    )
    .unwrap();
    assert_eq!(revealed.status, CommitmentStatus::Settled);
    assert_eq!(pending.status, CommitmentStatus::Slashed);
    assert_eq!(extra.status, CommitmentStatus::Pending);
    assert_eq!(portfolio.im, 0);
    assert_eq!(portfolio.positions[0].qty, 2);
    assert_eq!(portfolio.equity, -20010);
    assert_eq!(host.vault.insurance_fund, 30);
    assert_eq!(batch.slashed_deposits, 20);
    assert_eq!(batch.total_settled, 1);
}

#[test]
fn funding_freshness_pause_and_cursor_behavior_use_full_transition() {
    for (oracle, paused, valid, expected_cum, expected_slot) in [
        (Some((100, 1000, true)), false, true, 20, 100),
        (Some((100, 401, true)), false, true, 20, 100),
        (Some((100, 400, true)), false, true, 0, 0),
        (Some((100, 1001, true)), false, true, 0, 0),
        (Some((100, 1000, false)), false, true, 0, 0),
        (None, false, true, 0, 0),
        (Some((100, 1000, true)), true, true, 0, 0),
        (Some((100, 1000, true)), false, false, 0, 0),
    ] {
        let mut host = Host::new();
        host.oracle = oracle;
        if paused {
            host.registry.pause_flags = crate::state::registry::PAUSE_FUNDING;
        }
        let mut batch = clearing_batch();
        batch.mark_valid = u8::from(valid);
        batch.clearing_price = 110;
        let mut instrument = Instrument::new(0, 1, 1, 100, 50);
        instrument.funding_interval_slots = 50;
        instrument.funding_coefficient_bps = 100;
        instrument.max_funding_rate_bps = 100;
        let mut portfolio = Portfolio::new([1; 32]);
        portfolio.positions_len = 1;
        portfolio.positions[0].instrument_id = 0;
        portfolio.positions[0].qty = 2;
        host.settle(
            &mut batch,
            &mut instrument,
            &[0; 34],
            &mut [],
            &mut [&mut portfolio],
        )
        .unwrap();
        assert_eq!(
            instrument.cum_funding, expected_cum,
            "oracle={oracle:?} pause={paused} valid={valid}"
        );
        assert_eq!(instrument.last_funding_slot, expected_slot);
        assert_eq!(portfolio.last_funding_checkpoint[0], expected_cum);
        assert_eq!(portfolio.pnl, 2 * expected_cum);
    }
}

#[test]
fn late_errors_preserve_write_order_without_simulating_runtime_rollback() {
    for bad_book in [true, false] {
        let mut host = Host::new();
        if bad_book {
            host.book_error = Some(MgkError::InvalidAccount.into());
        } else {
            host.next.batch_id = 99;
        }
        let mut batch = clearing_batch();
        batch.mark_valid = 1;
        batch.clearing_price = 110;
        let mut instrument = Instrument::new(0, 1, 1, 100, 50);
        let error = host
            .settle(&mut batch, &mut instrument, &[0; 34], &mut [], &mut [])
            .unwrap_err();
        assert_eq!(batch.status, BatchStatus::Settled);
        if bad_book {
            assert_eq!(error, MgkError::InvalidAccount.into());
            assert_eq!(instrument.mark_price, 0);
        } else {
            assert_eq!(error, MgkError::AlreadyInitialized.into());
            assert_eq!(instrument.mark_price, 110);
        }
        let counter = host.registry.batch_id_counter;
        assert_eq!(counter, u64::from(!bad_book));
    }
}

#[test]
fn malformed_results_fail_before_writes_and_oversized_next_batch_fails_late() {
    let mut host = Host::new();
    let mut batch = clearing_batch();
    batch.mark_valid = 1;
    let mut instrument = Instrument::new(0, 1, 1, 100, 50);
    let mut results = [0; 34];
    results[32..34].copy_from_slice(&1u16.to_le_bytes());
    assert_eq!(
        host.settle(&mut batch, &mut instrument, &results, &mut [], &mut []),
        Err(ProgramError::AccountDataTooSmall)
    );
    assert_eq!(batch.status, BatchStatus::Clearing);
    host.next_size += 1;
    results[32..34].fill(0);
    assert_eq!(
        host.settle(&mut batch, &mut instrument, &results, &mut [], &mut []),
        Err(MgkError::InvalidAccount.into())
    );
    assert_eq!(batch.status, BatchStatus::Settled);
    let counter = host.registry.batch_id_counter;
    assert_eq!(counter, 1);
}

#[test]
fn full_position_table_keeps_cash_flow_without_creating_a_position() {
    let mut host = Host::new();
    let mut batch = clearing_batch();
    let mut instrument = Instrument::new(0, 1, 1, 100, 50);
    let mut portfolio = Portfolio::new([1; 32]);
    portfolio.positions_len = 32;
    for (i, position) in portfolio.positions.iter_mut().enumerate() {
        position.instrument_id = (i + 1) as u16;
    }
    host.settle(
        &mut batch,
        &mut instrument,
        &fills(&[(1, 1, 10000, false, 1)]),
        &mut [],
        &mut [&mut portfolio],
    )
    .unwrap();
    assert_eq!(portfolio.positions_len, 32);
    assert!(portfolio.find_position(0).is_none());
    assert_eq!(portfolio.equity, -10005);
    assert_eq!(batch.total_settled, 1);
    assert_eq!(host.vault.insurance_fund, 5);
}

#[test]
fn dfba_with_revealed_commitment_preserves_legacy_scan_behavior() {
    let mut host = Host::new();
    let mut batch = clearing_batch();
    batch.total_commitments = 1;
    let mut instrument = Instrument::new(0, 1, 1, 100, 50);
    let mut portfolio = Portfolio::new([1; 32]);
    portfolio.im = 10;
    let mut commitment = Commitment::new(7, [1; 32]);
    commitment.status = CommitmentStatus::Revealed;
    commitment.deposit_lamports = 10;
    host.settle(
        &mut batch,
        &mut instrument,
        &fills(&[(1, 1, 100, true, 0)]),
        &mut [&mut commitment],
        &mut [&mut portfolio],
    )
    .unwrap();
    // The retired commitment path still scans legacy offsets in DFBA data.
    // This fixture has no legacy user match; it releases the deposit anyway.
    assert_eq!(commitment.status, CommitmentStatus::Settled);
    assert_eq!(portfolio.positions[0].qty, 1);
    assert_eq!(portfolio.equity, -100);
    assert_eq!(portfolio.im, 0);
    assert_eq!(batch.total_settled, 2);
    assert_eq!(batch.total_notional, 100);
}
