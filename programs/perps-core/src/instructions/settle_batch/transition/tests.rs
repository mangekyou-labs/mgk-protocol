use super::*;

pub(in crate::instructions::settle_batch) struct TypedStates<'a, 'b, T>(pub &'a mut [&'b mut T]);
impl<T> States<T> for TypedStates<'_, '_, T> {
    fn len(&self) -> usize {
        self.0.len()
    }
    fn get_mut(&mut self, index: usize) -> Result<&mut T, ProgramError> {
        Ok(self.0[index])
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
            // A fresh next-batch account is zeroed, header included.
            next: Batch {
                header: Default::default(),
                ..Batch::new(0)
            },
            slot: 100,
            timestamp: 1000,
            oracle: Some((100_000_000, 1000, true)),
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
    fn require_reservations(&self) -> bool {
        false
    }
    fn cancel_order(&mut self, _: u64) -> ProgramResult {
        Ok(())
    }
    fn registry(&self) -> Result<Registry, ProgramError> {
        Ok(self.registry)
    }
    fn vault(&mut self) -> Result<&mut Vault, ProgramError> {
        Ok(&mut self.vault)
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
    fn set_batch_counter(&mut self, value: u64) -> ProgramResult {
        self.registry.batch_id_counter = value;
        Ok(())
    }
    fn next_batch_size(&self) -> usize {
        self.next_size
    }
    fn next_batch(&mut self) -> &mut Batch {
        &mut self.next
    }
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
fn position_open_moves_no_notional_and_charges_sol_fee() {
    let mut host = Host::new();
    host.oracle = Some((100_000_000, 1000, true));
    let mut batch = clearing_batch();
    let mut instrument = Instrument::new(0, 1, 1, 100, 50);
    let mut portfolio = Portfolio::new([1; 32]);
    portfolio.equity = 1_000_000_000;
    host.settle(
        &mut batch,
        &mut instrument,
        &fills(&[(1, 1000, 100_000_000, false, 1)]),
        &mut [],
        &mut [&mut portfolio],
    )
    .unwrap();
    assert_eq!(portfolio.equity, 999_500_000);
    assert_eq!(host.vault.insurance_fund, 500_000);
    assert_eq!(portfolio.positions[0].qty, 1000);
}

fn clearing_batch() -> Batch {
    let mut batch = Batch::new(7);
    batch.status = BatchStatus::Cleared;
    batch
}

fn run_fills(
    portfolio: &mut Portfolio,
    entries: &[(u8, u64, i64, bool, u8)],
    conversion: i64,
) -> (Batch, Host) {
    let mut host = Host::new();
    host.oracle = Some((conversion, 1000, true));
    host.vault.insurance_fund = 1_000_000_000_000_000_000;
    let mut batch = clearing_batch();
    let mut instrument = Instrument::new(0, 1, 1, 100, 50);
    host.settle(
        &mut batch,
        &mut instrument,
        &fills(entries),
        &mut [],
        &mut [portfolio],
    )
    .unwrap();
    (batch, host)
}

#[test]
fn precision_weighted_entry_survives_reduce_then_flip_and_close() {
    let mut p = Portfolio::new([1; 32]);
    p.equity = 1_000_000_000;
    run_fills(
        &mut p,
        &[
            (1, 1000, 100_000_000, true, 0),
            (1, 1001, 100_000_001, true, 0),
        ],
        100_000_000,
    );
    assert_eq!(
        (
            p.positions[0].entry_vwap,
            p.positions[0].entry_remainder,
            p.positions[0].entry_denominator
        ),
        (100_000_000, 500_249_875_063, ENTRY_PRICE_SCALE)
    );
    run_fills(&mut p, &[(1, 2001, 101_000_000, true, 1)], 100_000_000);
    // Independent Python Fraction reference vector: integer VWAP overpays 11 lamports.
    assert_eq!(p.realized_lamports, 20_009_989);
    assert_eq!(p.positions_len, 0);
    assert_eq!(p.realized_usd, 2_000_998);
    run_fills(
        &mut p,
        &[
            (1, 1000, 100_000_000, true, 0),
            (1, 400, 110_000_000, true, 1),
        ],
        100_000_000,
    );
    assert_eq!(p.positions[0].qty, 600);
    assert_eq!(p.positions[0].entry_vwap, 100_000_000);
    run_fills(&mut p, &[(1, 1000, 120_000_000, true, 1)], 100_000_000);
    assert_eq!(p.positions[0].qty, -400);
    assert_eq!(p.positions[0].entry_vwap, 120_000_000);
    run_fills(&mut p, &[(1, 400, 110_000_000, true, 0)], 100_000_000);
    assert_eq!(p.positions_len, 0);
    assert_eq!(p.realized_lamports, 220_009_989);
}

#[test]
fn opposing_fills_apply_in_results_order_instead_of_netting() {
    let mut p = Portfolio::new([1; 32]);
    run_fills(
        &mut p,
        &[
            (1, 1000, 100_000_000, true, 0),
            (1, 1000, 110_000_000, true, 1),
            (1, 1000, 120_000_000, true, 0),
        ],
        100_000_000,
    );
    assert_eq!(p.positions[0].qty, 1000);
    assert_eq!(p.positions[0].entry_vwap, 120_000_000);
    assert_eq!(p.realized_lamports, 100_000_000);
}

#[test]
fn fractional_micro_usd_is_converted_before_display_rounding() {
    let mut p = Portfolio::new([1; 32]);
    run_fills(
        &mut p,
        &[(1, 1, 100_000_000, true, 0), (1, 1, 100_000_001, true, 1)],
        100_000_000,
    );
    assert_eq!(p.realized_usd, 0); // 0.001 microUSD display rounds down.
    assert_eq!(p.realized_lamports, 0);
    run_fills(
        &mut p,
        &[(1, 1, 100_000_001, true, 0), (1, 1, 100_000_000, true, 1)],
        100_000_000,
    );
    assert_eq!(p.realized_usd, -1);
    assert_eq!(p.realized_lamports, -1);
}

#[test]
fn fees_round_up_per_fill_and_fund_equals_actual_charges() {
    let mut p = Portfolio::new([1; 32]);
    let (_, host) = run_fills(
        &mut p,
        &[(1, 1, 1, false, 1), (1, 1, 1, false, 1)],
        100_000_000,
    );
    assert_eq!(p.equity, -2);
    assert_eq!(p.fees_paid, 2);
    assert_eq!(host.vault.insurance_fund, 1_000_000_000_000_000_002);
}

#[test]
fn invalid_conversion_rejects_before_any_transition_write_and_can_retry() {
    for oracle in [
        None,
        Some((0, 1000, true)),
        Some((-1, 1000, true)),
        Some((100, 939, true)),
        Some((100, 1001, true)),
        Some((100, 1000, false)),
    ] {
        let mut host = Host::new();
        host.oracle = oracle;
        let mut batch = clearing_batch();
        let mut inst = Instrument::new(0, 1, 1, 100, 50);
        let mut p = Portfolio::new([1; 32]);
        p.equity = 1_000_000_000;
        let result = fills(&[(1, 1000, 100_000_000, false, 1)]);
        assert!(host
            .settle(&mut batch, &mut inst, &result, &mut [], &mut [&mut p])
            .is_err());
        assert_eq!(p.equity, 1_000_000_000);
        assert_eq!(p.positions_len, 0);
        assert_eq!(batch.status, BatchStatus::Cleared);
        assert_eq!(host.vault.insurance_fund, 0);
        let counter = host.registry.batch_id_counter;
        assert_eq!(counter, 0);
        host.oracle = Some((100_000_000, 940, true));
        host.settle(&mut batch, &mut inst, &result, &mut [], &mut [&mut p])
            .unwrap();
        assert_eq!(p.equity, 999_500_000);
    }
}

#[test]
fn funding_never_accrues_even_when_registry_unpaused() {
    let mut host = Host::new();
    let mut batch = clearing_batch();
    batch.mark_valid = 1;
    batch.clearing_price = 110_000_000;
    let mut inst = Instrument::new(0, 1, 1, 100, 50);
    inst.funding_interval_slots = 1;
    inst.funding_coefficient_bps = 100;
    let mut p = Portfolio::new([1; 32]);
    host.settle(&mut batch, &mut inst, &fills(&[]), &mut [], &mut [&mut p])
        .unwrap();
    assert_eq!(inst.cum_funding, 0);
    assert_eq!(inst.last_funding_slot, 0);
    assert_eq!(p.funding_paid, 0);
    assert!(p.last_funding_checkpoint.iter().all(|&x| x == 0));
}

#[test]
fn malformed_or_overflowing_fills_fail_instead_of_saturating() {
    for entry in [
        (1, u64::MAX, 100, true, 0),
        (1, 1, -1, true, 0),
        (1, 1, 100, true, 2),
    ] {
        let mut host = Host::new();
        let mut batch = clearing_batch();
        let mut inst = Instrument::new(0, 1, 1, 100, 50);
        let mut p = Portfolio::new([1; 32]);
        assert!(host
            .settle(
                &mut batch,
                &mut inst,
                &fills(&[entry]),
                &mut [],
                &mut [&mut p]
            )
            .is_err());
    }
}

proptest::proptest! {
    #[test]
    fn balanced_roundtrip_never_mints_lamports(qty in 1u64..10_001, open in 1_000_000i64..1_000_000_000, close in 1_000_000i64..1_000_000_000, conversion in 1_000_000i64..1_000_000_000) {
        let mut long=Portfolio::new([1;32]);
        let mut short=Portfolio::new([1;32]);
        let initial=10_000_000_000_000i128;
        long.equity=initial; short.equity=initial;
        run_fills(&mut long,&[(1,qty,open,true,0),(1,qty,close,true,1)],conversion);
        run_fills(&mut short,&[(1,qty,open,true,1),(1,qty,close,true,0)],conversion);
        proptest::prop_assert_eq!(long.positions_len,0);
        proptest::prop_assert_eq!(short.positions_len,0);
        let net=long.realized_lamports+short.realized_lamports;
        proptest::prop_assert!(net==0 || net == -1);
        proptest::prop_assert_eq!(long.equity+short.equity,2*initial+net);
        proptest::prop_assert_eq!(long.fees_paid+short.fees_paid,0);
    }
    #[test]
    fn partial_reduce_retains_exact_entry(qty in 2u64..10_000, extra in 1u64..10_000, price in 1_000_000i64..1_000_000_000) {
        let mut p=Portfolio::new([1;32]);
        run_fills(&mut p,&[(1,qty,price,true,0),(1,extra,price+1,true,0)],price);
        let before=p.positions[0];
        run_fills(&mut p,&[(1,1,price,true,1)],price);
        proptest::prop_assert_eq!(p.positions[0].qty,(qty+extra-1) as i64);
        proptest::prop_assert_eq!(p.positions[0].entry_vwap,before.entry_vwap);
        proptest::prop_assert_eq!(p.positions[0].entry_remainder,before.entry_remainder);
        proptest::prop_assert_eq!(p.positions[0].entry_denominator,before.entry_denominator);
    }
}

#[test]
fn exhausted_fund_rejects_payout_without_creating_debt() {
    let mut p = Portfolio::new([1; 32]);
    run_fills(&mut p, &[(1, 1000, 100_000_000, true, 0)], 100_000_000);
    let mut host = Host::new();
    let mut batch = clearing_batch();
    let mut instrument = Instrument::new(0, 1, 1, 100, 50);
    assert_eq!(
        host.settle(
            &mut batch,
            &mut instrument,
            &fills(&[(1, 1000, 110_000_000, true, 1)]),
            &mut [],
            &mut [&mut p]
        ),
        Err(MgkError::InsufficientFunds.into())
    );
    assert_eq!(host.vault.insurance_fund, 0);
    assert_eq!(host.vault.uncovered_bad_debt, 0);
    // This pure adapter deliberately does not emulate Solana transaction rollback.
    assert_eq!(batch.status, BatchStatus::Cleared);
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
    assert_eq!(batch.status, BatchStatus::Cleared);
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
    assert_eq!(portfolio.im, 400_000);
    assert_eq!(portfolio.positions[0].qty, 2);
    assert_eq!(portfolio.equity, -1);
    assert_eq!(host.vault.insurance_fund, 21);
    assert_eq!(batch.slashed_deposits, 20);
    assert_eq!(batch.total_settled, 1);
}

#[test]
fn ordinary_grow_reduce_lifecycles_remain_settleable() {
    for side in [0, 1] {
        let mut p = Portfolio::new([1; 32]);
        p.equity = 1_000_000_000;
        run_fills(&mut p, &[(1, 1, 100_000_000, true, side)], 100_000_000);
        for cycle in 0..1024 {
            // Alternation never reaches an exact integer weighted entry.
            let price = 100_000_001 + cycle % 2;
            let before = p.positions[0];
            let scale = ENTRY_PRICE_SCALE as i128;
            let numerator = before.entry_vwap as i128 * scale
                + before.entry_remainder as i128
                + price as i128 * scale;
            let expected = numerator / 2 + i128::from(side == 0 && numerator % 2 != 0);
            run_fills(
                &mut p,
                &[(1, 1, price, true, side), (1, 1, price, true, 1 - side)],
                100_000_000,
            );
            let after = p.positions[0];
            assert_eq!(after.qty.abs(), 1);
            assert!(after.entry_denominator == 0 || after.entry_denominator == ENTRY_PRICE_SCALE);
            assert_eq!(
                after.entry_vwap as i128 * scale + after.entry_remainder as i128,
                expected
            );
            // Each grow's rounding error is below one scale unit, toward the fund.
            let error_twice = expected * 2 - numerator;
            assert!(if side == 0 {
                (0..2).contains(&error_twice)
            } else {
                (-1..=0).contains(&error_twice)
            });
        }
        run_fills(&mut p, &[(1, 1, 100_000_000, true, 1 - side)], 100_000_000);
        assert_eq!(p.positions_len, 0);
    }
}

#[test]
fn off_grid_position_entry_rejects_instead_of_reinterpreting() {
    for (remainder, denominator) in [(1, 0), (1, 3), (ENTRY_PRICE_SCALE, ENTRY_PRICE_SCALE)] {
        let mut p = Portfolio::new([1; 32]);
        run_fills(&mut p, &[(1, 1, 100_000_000, true, 0)], 100_000_000);
        p.positions[0].entry_remainder = remainder;
        p.positions[0].entry_denominator = denominator;
        assert_eq!(
            super::apply_fill(&mut p, 0, -1, 100_000_000, true, 100_000_000),
            Err(MgkError::InvalidAccount.into())
        );
    }
}

#[test]
fn duplicate_portfolio_identity_rejects_before_applying_any_fill() {
    let mut host = Host::new();
    let mut batch = clearing_batch();
    let mut instrument = Instrument::new(0, 1, 1, 100, 50);
    let mut first = Portfolio::new([1; 32]);
    let mut duplicate = Portfolio::new([1; 32]);
    first.equity = 1_000_000_000;
    duplicate.equity = 1_000_000_000;
    let result = host.settle(
        &mut batch,
        &mut instrument,
        &fills(&[(1, 1000, 100_000_000, false, 1)]),
        &mut [],
        &mut [&mut first, &mut duplicate],
    );
    assert_eq!(result, Err(MgkError::InvalidPortfolio.into()));
    assert_eq!(first.equity, 1_000_000_000);
    assert_eq!(first.positions_len, 0);
}

#[test]
fn oracle_risk_counts_losses_but_gains_only_for_maintenance() {
    let mut p = Portfolio::new([1; 32]);
    p.equity = 1_000_000_000;
    apply_fill(&mut p, 0, 1000, 100_000_000, true, 100_000_000).unwrap();
    assert_eq!(
        (p.im, p.mm, p.free_collateral, p.health),
        (200_000_000, 100_000_000, 800_000_000, 900_000_000)
    );
    apply_fill(&mut p, 0, 1000, 200_000_000, true, 200_000_000).unwrap();
    // 2 SOL at $150 entry: +0.5 SOL unrealized, excluded from withdrawability.
    assert_eq!(
        (p.im, p.mm, p.free_collateral, p.health),
        (400_000_000, 200_000_000, 600_000_000, 1_300_000_000)
    );
    apply_fill(&mut p, 0, 1000, 100_000_000, true, 100_000_000).unwrap();
    // 3 SOL at $133.33 entry: -1 SOL unrealized, exactly to the lamport.
    assert_eq!(
        (p.im, p.mm, p.free_collateral, p.health),
        (600_000_000, 300_000_000, -600_000_001, -300_000_001)
    );
}

#[test]
fn concurrent_reduce_only_closes_clip_and_cancel_excess_without_flipping() {
    let mut host = Host::new();
    let mut batch = clearing_batch();
    let mut instrument = Instrument::new(0, 1, 1, 100, 50);
    let mut seller = Portfolio::new([1; 32]);
    let mut buyer = Portfolio::new([2; 32]);
    seller.equity = 1_000_000_000;
    buyer.equity = 1_000_000_000;
    buyer.recalc_margin();
    apply_fill(&mut seller, 0, 1000, 100_000_000, true, 100_000_000).unwrap();
    for id in 0..2 {
        crate::risk::open(
            &mut seller,
            crate::state::portfolio::OrderReservation {
                order_id: id,
                original_qty: 750,
                remaining_qty: 750,
                price: 100_000_000,
                initial_reserve: 375_000,
                reduce_only: 1,
                side: 1,
                ..Default::default()
            },
        )
        .unwrap();
    }
    crate::risk::open(
        &mut buyer,
        crate::state::portfolio::OrderReservation {
            order_id: 2,
            original_qty: 1500,
            remaining_qty: 1500,
            price: 100_000_000,
            initial_reserve: 300_750_000,
            ..Default::default()
        },
    )
    .unwrap();
    let mut results = fills(&[
        (1, 750, 100_000_000, true, 1),
        (1, 750, 100_000_000, true, 1),
        (2, 1500, 100_000_000, false, 1),
    ]);
    results[34 + 58 + 32..34 + 58 + 40].copy_from_slice(&1u64.to_le_bytes());
    results[34 + 116 + 32..34 + 116 + 40].copy_from_slice(&2u64.to_le_bytes());
    host.settle(
        &mut batch,
        &mut instrument,
        &results,
        &mut [],
        &mut [&mut seller, &mut buyer],
    )
    .unwrap();
    assert_eq!(seller.positions_len, 0);
    assert_eq!(buyer.positions[0].qty, 1000);
    assert_eq!(seller.reserved_collateral, 0);
    assert_eq!(buyer.reserved_collateral, 0);
    assert_eq!(buyer.fees_paid, 500_000);
}

#[test]
fn concurrent_short_closes_clip_taker_buys_without_opening_a_long() {
    let mut host = Host::new();
    let mut batch = clearing_batch();
    let mut instrument = Instrument::new(0, 1, 1, 2000, 1000);
    let mut closer = Portfolio::new([1; 32]);
    let mut seller = Portfolio::new([2; 32]);
    closer.equity = 1_000_000_000;
    seller.equity = 1_000_000_000;
    seller.recalc_margin();
    apply_fill(&mut closer, 0, -1000, 100_000_000, true, 100_000_000).unwrap();
    for id in 1..=2 {
        crate::risk::open(
            &mut closer,
            crate::state::portfolio::OrderReservation {
                order_id: id,
                original_qty: 750,
                remaining_qty: 750,
                price: 100_000_000,
                initial_reserve: 375_000,
                reduce_only: 1,
                side: 0,
                ..Default::default()
            },
        )
        .unwrap();
    }
    crate::risk::open(
        &mut seller,
        crate::state::portfolio::OrderReservation {
            order_id: 0,
            original_qty: 1500,
            remaining_qty: 1500,
            price: 100_000_000,
            initial_reserve: 300_750_000,
            side: 1,
            ..Default::default()
        },
    )
    .unwrap();
    let mut results = fills(&[
        (2, 1500, 100_000_000, true, 1),
        (1, 750, 100_000_000, false, 1),
        (1, 750, 100_000_000, false, 1),
    ]);
    for (index, id) in [0u64, 1, 2].into_iter().enumerate() {
        let offset = 34 + index * 58 + 32;
        results[offset..offset + 8].copy_from_slice(&id.to_le_bytes());
    }
    host.settle(
        &mut batch,
        &mut instrument,
        &results,
        &mut [],
        &mut [&mut closer, &mut seller],
    )
    .unwrap();
    assert_eq!(closer.positions_len, 0);
    assert_eq!(seller.positions[0].qty, -1000);
    assert_eq!(closer.fees_paid, 500_000);
    assert_eq!(closer.reserved_collateral, 0);
    assert_eq!(seller.reserved_collateral, 0);
}

#[test]
fn second_auction_clips_against_positions_after_first_auction_tail_trimming() {
    let mut host = Host::new();
    let mut batch = clearing_batch();
    let mut instrument = Instrument::new(0, 1, 1, 2000, 1000);
    let mut long = Portfolio::new([1; 32]);
    let mut short = Portfolio::new([2; 32]);
    let mut buyer = Portfolio::new([3; 32]);
    for p in [&mut long, &mut short, &mut buyer] {
        p.equity = 1_000_000_000;
        p.recalc_margin();
    }
    apply_fill(&mut long, 0, 1000, 100_000_000, true, 100_000_000).unwrap();
    apply_fill(&mut short, 0, -500, 100_000_000, true, 100_000_000).unwrap();
    // The first auction can close only the short's 500 lots. Tail trimming
    // leaves the long with 500 lots available to close in the second auction.
    for (owner, id, side, reduce_only) in [(0, 0, 1, 1), (1, 1, 0, 1), (0, 2, 1, 1), (2, 3, 0, 0)] {
        let p = match owner {
            0 => &mut long,
            1 => &mut short,
            _ => &mut buyer,
        };
        crate::risk::open(
            p,
            crate::state::portfolio::OrderReservation {
                order_id: id,
                original_qty: 750,
                remaining_qty: 750,
                price: 100_000_000,
                initial_reserve: if reduce_only == 1 {
                    375_000
                } else {
                    150_375_000
                },
                side,
                reduce_only,
                ..Default::default()
            },
        )
        .unwrap();
    }
    let mut results = fills(&[
        (2, 750, 100_000_000, true, 0),
        (1, 750, 100_000_000, false, 0),
        (1, 750, 100_000_000, true, 1),
        (3, 750, 100_000_000, false, 1),
    ]);
    for (index, id) in [1u64, 0, 2, 3].into_iter().enumerate() {
        let offset = 34 + index * 58 + 32;
        results[offset..offset + 8].copy_from_slice(&id.to_le_bytes());
    }
    host.settle(
        &mut batch,
        &mut instrument,
        &results,
        &mut [],
        &mut [&mut long, &mut short, &mut buyer],
    )
    .unwrap();
    assert_eq!(long.positions_len, 0);
    assert_eq!(short.positions_len, 0);
    assert_eq!(buyer.positions[0].qty, 500);
    for p in [&long, &short, &buyer] {
        assert_eq!(p.reserved_collateral, 0);
        assert!(p.orders.iter().all(|order| order.remaining_qty == 0));
    }
}

#[test]
fn wide_oracle_risk_settles_affordable_fills_with_conservative_signed_rounding() {
    for (entry, conversion, expected) in [
        (
            1_000_000_000_000_000_000,
            2_000_000_000_000_000_000,
            500_000_000,
        ),
        (
            1_000_000_000_000_000_003,
            2_000_000_000_000_000_001,
            499_999_999,
        ),
    ] {
        for side in [1i64, -1] {
            let mut host = Host::new();
            host.oracle = Some((conversion, 1000, true));
            let mut batch = clearing_batch();
            let mut instrument = Instrument::new(0, 1, 1, 2000, 1000);
            let mut portfolio = Portfolio::new([1; 32]);
            portfolio.equity = 2_000_000_000;
            // Open at the limit while the current conversion price is higher.
            // This costs only 0.2 SOL IM and has an exactly representable PnL.
            host.settle(
                &mut batch,
                &mut instrument,
                &fills(&[(1, 1000, entry, true, u8::from(side < 0))]),
                &mut [],
                &mut [&mut portfolio],
            )
            .unwrap();
            let expected = if side > 0 {
                expected
            } else if conversion % 2 == 0 {
                -expected
            } else {
                -expected - 1
            };
            assert_eq!(portfolio.risk_pnl, expected);
            assert_eq!(portfolio.im, 200_000_000);
            assert_eq!(portfolio.free_collateral, 1_800_000_000 + expected.min(0));
            assert_eq!(portfolio.health, 1_900_000_000 + expected);
        }
    }
}
