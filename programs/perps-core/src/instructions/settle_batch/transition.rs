//! Full settlement transition. Account access is supplied by adapters; the
//! ordering of state writes and late errors is part of the existing behavior.
use crate::state::{
    batch::{Batch, BatchStatus, Commitment, CommitmentStatus},
    funding::{accrue_cum_funding, compute_d7_funding_rate},
    instrument::Instrument,
    portfolio::Portfolio,
    registry::Registry,
    vault::Vault,
};
use mgk_common::{math::calculate_funding_payment, MgkError};
use pinocchio::{
    msg, program_error::ProgramError, pubkey::Pubkey, sysvars::clock::Clock, ProgramResult,
};

/// M6 6i.2: CLOB results wire format. num_fills(2) header, then 49 bytes per
/// fill: user(32) + filled_qty(8) + notional(8) + is_maker(1).
pub(super) const RESULTS_HEADER_BYTES: usize = 2;
pub(super) const RESULTS_BYTES_PER_FILL: usize = 49;
pub(super) const BPS_DENOM: i128 = 10_000;
/// DFBA results: 34-byte header (prices/qty + num_fills at 32) then 58-byte fills.
pub(super) const DFBA_RESULT_HEADER_BYTES: usize = 34;
pub(super) const DFBA_FILL_WIRE_BYTES: usize = 58;

/// Access one state in place; neither adapter copies portfolios onto the stack.
pub(super) trait States<T> {
    fn len(&self) -> usize;
    fn get_mut(&mut self, index: usize) -> Result<&mut T, ProgramError>;
}

/// Runtime operations whose timing matters to settlement (including late errors).
pub(super) trait Environment {
    fn registry(&self) -> Result<Registry, ProgramError>;
    fn vault(&mut self) -> Result<&mut Vault, ProgramError>;
    fn validate_book(&self, instrument_id: u16) -> ProgramResult;
    fn clock(&self) -> Result<Clock, ProgramError>;
    fn oracle(&self, expected_addr: &Pubkey) -> Option<(i64, i64, bool)>;
    fn set_batch_counter(&mut self, value: u64) -> ProgramResult;
    fn next_batch_size(&self) -> usize;
    fn next_batch(&mut self) -> &mut Batch;
}

pub(super) fn settle(
    batch: &mut Batch,
    instrument: &mut Instrument,
    results_data: &[u8],
    commitments: &mut impl States<Commitment>,
    portfolios: &mut impl States<Portfolio>,
    environment: &mut impl Environment,
) -> ProgramResult {
    if batch.status != BatchStatus::Clearing {
        msg!("Error: Batch not in clearing phase");
        return Err(MgkError::InvalidInstruction.into());
    }

    let registry = environment.registry()?;

    const DFBA_HDR: usize = DFBA_RESULT_HEADER_BYTES;
    const DFBA_FILL: usize = DFBA_FILL_WIRE_BYTES;
    let dfba_mode = results_data.len() >= DFBA_HDR
        && (batch.matched_bid_qty > 0
            || batch.matched_ask_qty > 0
            || batch.mark_valid != 0
            || results_data.len() >= DFBA_HDR + DFBA_FILL);

    let (num_fills, fill_stride, fill_base) = if dfba_mode {
        if results_data.len() < DFBA_HDR {
            return Err(ProgramError::AccountDataTooSmall);
        }
        let n = u16::from_le_bytes(results_data[32..34].try_into().unwrap()) as usize;
        let need = DFBA_HDR + n * DFBA_FILL;
        if results_data.len() < need {
            return Err(ProgramError::AccountDataTooSmall);
        }
        (n, DFBA_FILL, DFBA_HDR)
    } else {
        if results_data.len() < RESULTS_HEADER_BYTES {
            msg!("Error: Results account too small");
            return Err(ProgramError::AccountDataTooSmall);
        }
        let n =
            u16::from_le_bytes(results_data[0..RESULTS_HEADER_BYTES].try_into().unwrap()) as usize;
        let need = RESULTS_HEADER_BYTES + n * RESULTS_BYTES_PER_FILL;
        if results_data.len() < need {
            return Err(ProgramError::AccountDataTooSmall);
        }
        (n, RESULTS_BYTES_PER_FILL, RESULTS_HEADER_BYTES)
    };
    let _ = (num_fills, fill_stride, fill_base); // used below in DFBA-aware settle

    // Settle each commitment based on aggregated fill results.
    // A user can have multiple fills (one taker + N makers) at different
    // maker prices. We sum up qty and notional per user; the effective
    // price (notional / qty) becomes the entry_vwap.
    //
    // M6 6i.3: per-user fee/rebate aggregation. We split notional by
    // is_maker so the rebate (negative maker_fee_bps) only applies to
    // the maker-side portion of the user's fills.
    let mut total_settled: u32 = 0;
    let mut total_volume: u64 = 0;
    let mut total_notional: u128 = 0;
    let mut total_maker_notional: u128 = 0;
    let mut total_taker_notional: u128 = 0;
    let mut slashed: u128 = 0;

    // DFBA: optional commitment accounts (posts rest on book; no slash path).
    let commitment_limit = if batch.total_commitments == 0 {
        0
    } else {
        batch.total_commitments as usize
    };

    // DFBA fill apply: update portfolios from results (dual format).
    // Creates positions when missing; applies equity cash flow + fees.
    if dfba_mode && num_fills > 0 {
        for i in 0..num_fills {
            let off = fill_base + i * fill_stride;
            let user = Pubkey::from(
                <[u8; 32]>::try_from(&results_data[off..off + 32]).unwrap_or([0u8; 32]),
            );
            let fill_qty = u64::from_le_bytes(results_data[off + 40..off + 48].try_into().unwrap());
            let fill_price =
                i64::from_le_bytes(results_data[off + 48..off + 56].try_into().unwrap());
            let is_maker = results_data[off + 56] != 0;
            let auction = results_data[off + 57]; // 0=bid 1=ask
            if fill_qty == 0 {
                continue;
            }
            let notional = (fill_qty as u128).saturating_mul(fill_price.unsigned_abs() as u128);
            total_volume = total_volume.saturating_add(fill_qty);
            total_notional = total_notional.saturating_add(notional);
            if is_maker {
                total_maker_notional = total_maker_notional.saturating_add(notional);
            } else {
                total_taker_notional = total_taker_notional.saturating_add(notional);
            }
            for index in 0..portfolios.len() {
                let portfolio = portfolios.get_mut(index)?;
                if portfolio.user != user {
                    continue;
                }
                apply_one_dfba_fill(
                    portfolio, instrument, fill_qty, fill_price, is_maker, auction,
                );
                total_settled = total_settled.saturating_add(1);
                break;
            }
        }
    }

    for index in 0..commitments.len().min(commitment_limit) {
        let commitment = commitments.get_mut(index)?;

        if commitment.status == CommitmentStatus::Pending {
            // Non-revealed commitment — slash deposit.
            // M7 7.2: `commitment.deposit_lamports` stores the value
            // returned by `Registry::deposit_amount()` (i.e. `base_deposit *
            // volatility_multiplier / 10_000`, default = 10_000_000). It is
            // already in the same unit as `portfolio.equity` and
            // `vault.insurance_fund`, so no scale conversion is applied
            // here. (The previous `* 1_000_000` multiplier inflated the
            // insurance credit by 1e6 and was a unit-conversion bug.)
            commitment.status = CommitmentStatus::Slashed;
            slashed = slashed.saturating_add(commitment.deposit_lamports as u128);
            // Return the im lock even though the deposit was slashed —
            // the user's free collateral should reflect that the order
            // never executed. The slashed deposit itself is forwarded to
            // `vault.insurance_fund` below.
            return_deposit(portfolios, &commitment.user, commitment.deposit_lamports)?;
            continue;
        }

        if commitment.status != CommitmentStatus::Revealed {
            continue;
        }

        let user = &commitment.user;
        let mut user_filled_qty: u64 = 0;
        let mut user_notional: u64 = 0;
        let mut user_maker_notional: u64 = 0;
        let mut user_taker_notional: u64 = 0;

        for f_idx in 0..num_fills {
            let offset = RESULTS_HEADER_BYTES + f_idx * RESULTS_BYTES_PER_FILL;
            let fill_user_bytes: [u8; 32] = results_data[offset..offset + 32].try_into().unwrap();
            let fill_user = Pubkey::from(fill_user_bytes);

            if fill_user == *user {
                let fq =
                    u64::from_le_bytes(results_data[offset + 32..offset + 40].try_into().unwrap());
                let fn_ =
                    u64::from_le_bytes(results_data[offset + 40..offset + 48].try_into().unwrap());
                let is_maker = results_data[offset + 48] != 0;
                user_filled_qty = user_filled_qty.saturating_add(fq);
                user_notional = user_notional.saturating_add(fn_);
                if is_maker {
                    user_maker_notional = user_maker_notional.saturating_add(fn_);
                } else {
                    user_taker_notional = user_taker_notional.saturating_add(fn_);
                }
            }
        }

        // Find matching portfolio
        for index in 0..portfolios.len() {
            let portfolio = portfolios.get_mut(index)?;

            if portfolio.user == *user {
                if user_filled_qty > 0 {
                    // Apply aggregated fill — update position.
                    let side = commitment.revealed.side as u8; // 0=Buy, 1=Sell
                    let instrument_id = commitment.revealed.instrument_id;
                    let qty_delta: i64 = if side == 0 {
                        user_filled_qty as i64 // Buy: positive qty
                    } else {
                        -(user_filled_qty as i64) // Sell: negative qty
                    };

                    // Effective price = notional / qty (price-time CLOB fills
                    // at multiple maker prices, so there's no single clearing
                    // price — VWAP is the natural choice for entry_vwap).
                    let effective_price: i64 =
                        user_notional.checked_div(user_filled_qty).unwrap_or(0) as i64;

                    let existing = portfolio.find_position(instrument_id);
                    if let Some((idx, pos)) = existing {
                        let new_qty = pos.qty.saturating_add(qty_delta);
                        portfolio.positions[idx].qty = new_qty;
                    } else {
                        if (portfolio.positions_len as usize) < portfolio.positions.len() {
                            let idx = portfolio.positions_len as usize;
                            portfolio.positions[idx].instrument_id = instrument_id;
                            portfolio.positions[idx].qty = qty_delta;
                            portfolio.positions[idx].entry_vwap = effective_price;
                            portfolio.positions_len += 1;
                        }
                    }

                    // Position notional: settled cash flow from the trade.
                    // For buys: equity decreases (spent); for sells: increases
                    // (received).
                    let notional_delta = user_notional as i128;
                    if side == 0 {
                        portfolio.equity = portfolio.equity.saturating_sub(notional_delta);
                    } else {
                        portfolio.equity = portfolio.equity.saturating_add(notional_delta);
                    }

                    // M6 6i.3: per-user maker rebate / taker fee.
                    // maker_rebate is signed: negative when maker_fee_bps<0
                    // (rebate paid to maker), positive when maker_fee_bps>0
                    // (rare — maker pays fee).
                    let maker_rebate: i128 = (user_maker_notional as i128
                        * instrument.maker_fee_bps as i128)
                        / BPS_DENOM;
                    let taker_fee: i128 = (user_taker_notional as i128
                        * instrument.taker_fee_bps as i128)
                        / BPS_DENOM;

                    // Net fee impact on this user (positive = cost, negative = rebate):
                    //   net = maker_rebate + taker_fee
                    // Apply to equity: equity -= net (rebates increase equity).
                    let net_fee = maker_rebate + taker_fee;
                    portfolio.equity = portfolio.equity.saturating_sub(net_fee);

                    portfolio.recalc_margin();
                }

                // M7 7.2: return the commitment deposit. The deposit was
                // locked against `portfolio.im` in `CommitOrder`; without
                // this, funds would be permanently locked. `recalc_margin`
                // is called inside `return_deposit`.
                return_deposit(portfolios, user, commitment.deposit_lamports)?;

                commitment.status = CommitmentStatus::Settled;
                total_settled += 1;
                total_volume = total_volume.saturating_add(user_filled_qty);
                total_notional = total_notional.saturating_add(user_notional as u128);
                total_maker_notional =
                    total_maker_notional.saturating_add(user_maker_notional as u128);
                total_taker_notional =
                    total_taker_notional.saturating_add(user_taker_notional as u128);
                break;
            }
        }
    }

    // Credit slashed deposits and net protocol fees to insurance fund.
    //
    // Insurance flow per user:
    //   + taker_fee  (taker paid)
    //   + maker_rebate  (negative: rebate paid out, reduces insurance)
    let protocol_fee_delta: i128 =
        (total_taker_notional as i128 * instrument.taker_fee_bps as i128) / BPS_DENOM
            + (total_maker_notional as i128 * instrument.maker_fee_bps as i128) / BPS_DENOM;

    if slashed > 0 || protocol_fee_delta != 0 {
        let vault = environment.vault()?;
        // Slashed deposits (positive) always credit insurance.
        if slashed > 0 {
            vault.insurance_fund = vault.insurance_fund.saturating_add(slashed);
        }
        // Net fee delta can be negative (rebates outpace fees). Saturate
        // to avoid underflow on insurance_fund (the protocol takes the
        // loss as uncovered_bad_debt if insurance runs out — tracked
        // separately, not subtracted here).
        if protocol_fee_delta > 0 {
            vault.insurance_fund = vault
                .insurance_fund
                .saturating_add(protocol_fee_delta as u128);
        } else if protocol_fee_delta < 0 {
            let rebate_out = (-protocol_fee_delta) as u128;
            if rebate_out <= vault.insurance_fund {
                vault.insurance_fund = vault.insurance_fund.saturating_sub(rebate_out);
            } else {
                // Insurance fund cannot cover the rebate — track the
                // shortfall as uncovered_bad_debt. For MVP we record the
                // deficit without crashing; downstream funding/insurance
                // top-up logic (out of scope) handles replenishment.
                vault.uncovered_bad_debt = vault
                    .uncovered_bad_debt
                    .saturating_add(rebate_out - vault.insurance_fund);
                vault.insurance_fund = 0;
            }
        }
    }

    // Preserve DFBA dual mid when set by ClearBatch; else VWAP fallback.
    if batch.mark_valid == 0 && total_volume > 0 {
        let effective = total_notional
            .checked_div(total_volume as u128)
            .unwrap_or(0) as i64;
        batch.clearing_price = effective;
    }
    batch.total_settled = total_settled;
    if total_volume > 0 {
        batch.total_volume = total_volume;
    }
    batch.total_notional = total_notional;
    batch.slashed_deposits = batch.slashed_deposits.saturating_add(slashed);
    batch.status = BatchStatus::Settled;

    environment.validate_book(instrument.instrument_id)?;
    let clock = environment.clock()?;
    let current_slot = clock.slot;
    let current_unix_ts = clock.unix_timestamp;

    let oracle_info = environment.oracle(&instrument.oracle_addr);
    let oracle_price = oracle_info.map(|(p, _, _)| p);
    let prev_mark_price = instrument.mark_price;

    // T9.10.6: Settlement-mark selector.
    // No oracle or book seeding — the mark comes from the DFBA clearing price
    // only; invalid/missing clears carry or zero the mark respectively.
    //
    // 1. Valid dual clear → use the clearing price.
    // 2. Invalid clear but prior mark exists → carry forward.
    // 3. Invalid clear and no prior mark (first batch) → zero.
    let new_mark_price = if batch.mark_valid != 0 {
        batch.clearing_price
    } else if prev_mark_price != 0 {
        prev_mark_price
    } else {
        0
    };
    instrument.mark_price = new_mark_price;

    // D7 / T9.10.5: Funding rate accrual (coefficient-based, replaces SMA).
    // Skip entirely when:
    //   - governance `funding_paused` (soft skip; next non-paused catches up),
    //   - `!mark_valid` (no dual DFBA clear → no auction mid), or
    //   - oracle stale, future-dated, or inactive (stale index cannot produce valid rate).
    // Skips leave cumulative funding and its cursor untouched.
    let funding_paused = registry.is_funding_paused();
    // T9.10.3: Oracle freshness check. Compare oracle timestamp with Clock::unix_timestamp;
    // freshness includes the exact 60-second boundary.
    const ORACLE_STALENESS_WINDOW_SECS: i64 = mgk_common::oracle::MAX_PRICE_AGE_SECONDS;
    let oracle_fresh = if let Some((_price, ts, active)) = oracle_info {
        active
            && ts > 0
            && current_unix_ts >= ts
            && current_unix_ts.checked_sub(ts).is_some_and(|age| age <= ORACLE_STALENESS_WINDOW_SECS)
    } else {
        false
    };
    if !funding_paused && batch.mark_valid != 0 && oracle_fresh {
        let _d7_rate =
            apply_funding_to_instrument(instrument, new_mark_price, oracle_price, current_slot);
        let post_funding_cum = instrument.cum_funding;
        let instrument_id_for_funding = instrument.instrument_id;
        for index in 0..portfolios.len() {
            let portfolio = portfolios.get_mut(index)?;
            apply_funding_to_portfolio(portfolio, instrument_id_for_funding, post_funding_cum);
        }
    } else {
        // Preserve the existing zero-rate helper call. accrue_cum_funding
        // returns the old cursor for zero rate, so skips do not advance it.
        if !funding_paused && instrument.funding_interval_slots > 0 {
            let (delta, new_last) = accrue_cum_funding(
                current_slot,
                instrument.last_funding_slot,
                instrument.funding_interval_slots,
                0, // zero rate
            );
            let _ = delta;
            instrument.last_funding_slot = new_last;
        }
    }

    // M7 7.6 (decision D2): post-hoc margin check. After all fills +
    // funding are applied, flag any underwater portfolios for the
    // keeper. Fills are NOT reverted (per D2) — the existing
    // `LiquidateUser` instruction handles liquidation in a separate
    // transaction and already enforces `health >= 0 → reject`. This
    // check is purely observational: it makes underwater portfolios
    // visible to off-chain monitors without changing the batch outcome.
    for index in 0..portfolios.len() {
        let portfolio = portfolios.get_mut(index)?;
        if portfolio.needs_liquidation() {
            msg!("Warning: portfolio underwater post-settle, eligible for liquidation");
        }
    }

    // Increment batch counter in registry.
    // Raw byte write at offset 36 — SBF field assignment has been observed to
    // corrupt neighboring fields (same fix as create_batch / initialize).
    let next_counter = registry.batch_id_counter.saturating_add(1);
    environment.set_batch_counter(next_counter)?;

    // M7 7.1: embed next-batch creation (design decision D1 — see
    // docs/ai/planning/2026-06-16-m7-design-decisions.md). After settling
    // the current batch, write the next batch's PDA in place so there is
    // no idle gap where no batch is in Committing.
    //
    // NOTE: PDA validation removed — Solana 4.x breaks createAccount for PDA
    // addresses (new accounts must sign their own Allocate). Batch is now
    // created by keeper via Keypair.generate() + createAccount, not via PDA.
    // The bump value is stored as metadata only (no invoke_signed signing).
    let next_batch_id = batch.batch_id.saturating_add(1);
    let next_bump: u8 = 0; // bump unused when batch is keypair-controlled

    // 2. Defensive size check — the caller must pre-allocate the account
    //    at exactly size_of::<Batch>(). The PDA was created via system
    //    program in the same TX (or pre-created by the keeper) and
    //    assigned to core. If the size is wrong, refuse to write rather
    //    than corrupt the account.
    let next_batch_size = environment.next_batch_size();
    if next_batch_size != core::mem::size_of::<Batch>() {
        msg!("Error: next_batch account size mismatch");
        return Err(MgkError::InvalidAccount.into());
    }

    // 3. Reject double-create: the account must be all-zero (batch_id == 0
    //    + status == Committing == 0 are ambiguous on their own, so we
    //    check batch_id != 0 as the canonical "already initialized" signal).
    {
        let next_batch_probe = environment.next_batch();
        if next_batch_probe.batch_id != 0
            || next_batch_probe.header.discriminator != mgk_common::layout::discriminator::UNINITIALIZED
        {
            msg!("Error: next_batch account already initialized");
            return Err(MgkError::AlreadyInitialized.into());
        }
    }

    // 4. Read the current slot and write the new batch in place.
    let current_slot = environment.clock()?.slot;
    let commit_deadline = current_slot.saturating_add(registry.t_max_slots);
    let next_batch = environment.next_batch();
    // Reveal deadline is 0 here; CloseCommitting sets it on transition
    // out of Committing (design L153). Status, close_slot, shuffle_seed,
    // clearing_price, all counters default to 0 — the fresh state of a
    // brand-new batch in Committing.
    next_batch.initialize_in_place(next_batch_id, commit_deadline, 0, next_bump);

    msg!("SettleBatch: Batch settled; next batch created");
    Ok(())
}

/// M7 7.2: Return the locked commitment deposit to the user's portfolio.
/// Decrements `portfolio.im` by `deposit_lamports` and recomputes
/// `free_collateral` / `health`. Used in both the Settled and Slashed
/// branches of `process_settle_batch` so that `CommitOrder`'s
/// `portfolio.im += deposit` lock is always reversed.
///
/// Returns `true` if the matching portfolio was found, `false` otherwise.
/// A `false` return signals a keeper TX bug (missing portfolio account) —
/// we do not crash because the deposit is still slashed to insurance in
/// that path; the im lock just persists until the keeper retries with the
/// correct account list.
fn return_deposit(
    portfolios: &mut impl States<Portfolio>,
    user: &Pubkey,
    deposit_lamports: u64,
) -> Result<bool, ProgramError> {
    for index in 0..portfolios.len() {
        let portfolio = portfolios.get_mut(index)?;
        if portfolio.user == *user {
            portfolio.im = portfolio.im.saturating_sub(deposit_lamports as u128);
            portfolio.recalc_margin();
            return Ok(true);
        }
    }
    Ok(false)
}

/// D7: Compute the funding rate from mark price and oracle index,
/// then accrue `cum_funding` on the instrument.
///
/// Uses the D7 formula:
///   rate_bps = clamp(((mark - index) * coefficient_bps) / index, ±max_rate_bps)
///
/// Reads `instrument.cum_funding` / `last_funding_slot` and writes
/// back the updated values. Does NOT apply payments to portfolios —
/// that happens in `apply_funding_to_portfolio` below.
///
/// Returns the rate used (for logging/verification). If the oracle
/// price is invalid, the function is a no-op (carry-forward).
pub(super) fn apply_funding_to_instrument(
    instrument: &mut Instrument,
    mark_price: i64,
    oracle_price: Option<i64>,
    current_slot: u64,
) -> i64 {
    // D7: Use current valid DFBA mark and fresh bound oracle index.
    // Skip if oracle is unavailable or mark is invalid (zero).
    let index = match oracle_price {
        Some(p) if p > 0 => p,
        _ => {
            // Oracle unavailable or invalid — carry forward.
            return 0;
        }
    };
    if mark_price <= 0 {
        // Invalid mark — carry forward.
        return 0;
    }

    let rate = match compute_d7_funding_rate(
        mark_price,
        index,
        instrument.funding_coefficient_bps,
        instrument.max_funding_rate_bps,
    ) {
        Some(r) => r,
        None => {
            // Invalid parameters — carry forward.
            return 0;
        }
    };

    // Accrue `cum_funding` by `rate × funding_period`. Advances
    // `last_funding_slot` by the same number of intervals so the next
    // batch doesn't double-count the remainder.
    let (delta, new_last) = accrue_cum_funding(
        current_slot,
        instrument.last_funding_slot,
        instrument.funding_interval_slots,
        rate,
    );
    instrument.cum_funding = instrument.cum_funding.saturating_add(delta);
    instrument.last_funding_slot = new_last;
    rate
}

/// M7 7.4: Apply the current funding rate to a single portfolio's
/// position(s) in the given instrument. Iterates `portfolio.positions`
/// looking for `instrument_id`, computes
/// `qty × (cum_funding − last_funding_checkpoint[instrument_id])` per
/// position (via `mgk_common::math::calculate_funding_payment`),
/// adds the sum to `portfolio.pnl`, and updates the checkpoint.
///
/// `last_funding_checkpoint[instrument_id]` is the
/// `portfolio.last_funding_checkpoint[idx]` where
/// `idx = instrument_id as usize`. Out-of-range `instrument_id`
/// (>= MAX_INSTRUMENTS) is a no-op (defensive — instrument_id is u16,
/// but only MAX_INSTRUMENTS=32 slots are allocated).
pub(super) fn apply_funding_to_portfolio(
    portfolio: &mut Portfolio,
    instrument_id: u16,
    cum_funding: i128,
) {
    let idx = instrument_id as usize;
    if idx >= portfolio.last_funding_checkpoint.len() {
        return;
    }
    let entry = portfolio.last_funding_checkpoint[idx];
    if entry == cum_funding {
        return; // no funding accrued since last checkpoint
    }
    let mut total_payment: i128 = 0;
    for i in 0..portfolio.positions_len as usize {
        if portfolio.positions[i].instrument_id == instrument_id {
            let qty = portfolio.positions[i].qty;
            let payment = calculate_funding_payment(qty, cum_funding, entry);
            total_payment = total_payment.saturating_add(payment);
        }
    }
    if total_payment != 0 {
        portfolio.pnl = portfolio.pnl.saturating_add(total_payment);
        portfolio.recalc_margin();
    }
    portfolio.last_funding_checkpoint[idx] = cum_funding;
}

/// Bid makers buy, bid takers sell; ask opposite.
fn dfba_signed_qty(auction: u8, is_maker: bool, fill_qty: u64) -> i64 {
    match (auction, is_maker) {
        (0, true) => fill_qty as i64,
        (0, false) => -(fill_qty as i64),
        (1, true) => -(fill_qty as i64),
        (1, false) => fill_qty as i64,
        _ => fill_qty as i64,
    }
}

fn apply_one_dfba_fill(
    portfolio: &mut Portfolio,
    instrument: &Instrument,
    fill_qty: u64,
    fill_price: i64,
    is_maker: bool,
    auction: u8,
) {
    let signed_qty = dfba_signed_qty(auction, is_maker, fill_qty);
    let notional = (fill_qty as u128).saturating_mul(fill_price.unsigned_abs() as u128);
    let id = instrument.instrument_id;
    if let Some((idx, pos)) = portfolio.find_position_mut(id) {
        let old_qty = pos.qty;
        let new_qty = old_qty.saturating_add(signed_qty);
        if new_qty != 0
            && fill_price > 0
            && ((old_qty >= 0 && signed_qty > 0) || (old_qty <= 0 && signed_qty < 0))
        {
            let old_n = (old_qty.unsigned_abs() as u128)
                .saturating_mul(pos.entry_vwap.unsigned_abs() as u128);
            let new_n = old_n.saturating_add(notional);
            let new_abs = new_qty.unsigned_abs() as u128;
            if let Some(vwap) = new_n.checked_div(new_abs) {
                portfolio.positions[idx].entry_vwap = vwap as i64;
            }
        }
        portfolio.positions[idx].qty = new_qty;
    } else if signed_qty != 0 && (portfolio.positions_len as usize) < portfolio.positions.len() {
        let idx = portfolio.positions_len as usize;
        portfolio.positions[idx].instrument_id = id;
        portfolio.positions[idx].qty = signed_qty;
        portfolio.positions[idx].entry_vwap = fill_price.max(0);
        portfolio.positions_len = portfolio.positions_len.saturating_add(1);
    }
    if signed_qty > 0 {
        portfolio.equity = portfolio.equity.saturating_sub(notional as i128);
    } else if signed_qty < 0 {
        portfolio.equity = portfolio.equity.saturating_add(notional as i128);
    }
    let fee: i128 = if is_maker {
        (notional as i128 * instrument.maker_fee_bps as i128) / BPS_DENOM
    } else {
        (notional as i128 * instrument.taker_fee_bps as i128) / BPS_DENOM
    };
    portfolio.equity = portfolio.equity.saturating_sub(fee);
    portfolio.recalc_margin();
}

#[cfg(test)]
pub(super) mod tests;
