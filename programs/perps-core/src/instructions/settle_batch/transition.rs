//! Settlement arithmetic. Fills are applied in cleared-results order; collateral
//! changes only for realized PnL and fees, in lamports at the validated oracle.
use crate::cash::settle_cash;
use crate::state::{
    batch::{Batch, BatchStatus, Commitment, CommitmentStatus},
    instrument::Instrument,
    portfolio::{Portfolio, Position, ENTRY_PRICE_SCALE},
    registry::Registry,
    vault::Vault,
};
use mgk_common::MgkError;
use pinocchio::{
    program_error::ProgramError, pubkey::Pubkey, sysvars::clock::Clock, ProgramResult,
};

pub(super) const RESULTS_HEADER_BYTES: usize = 2;
pub(super) const RESULTS_BYTES_PER_FILL: usize = 49;
pub(super) const DFBA_RESULT_HEADER_BYTES: usize = 34;
pub(super) const DFBA_FILL_WIRE_BYTES: usize = 58;
const LOTS_PER_SOL: i128 = 1_000;
const LAMPORTS_PER_SOL: i128 = 1_000_000_000;

pub(super) trait States<T> {
    fn len(&self) -> usize;
    fn get_mut(&mut self, index: usize) -> Result<&mut T, ProgramError>;
}
pub(super) trait Environment {
    fn registry(&self) -> Result<Registry, ProgramError>;
    fn vault(&mut self) -> Result<&mut Vault, ProgramError>;
    fn validate_book(&self, instrument_id: u16) -> ProgramResult;
    fn clock(&self) -> Result<Clock, ProgramError>;
    /// Adapter returns a price only after owner, binding, confidence and layout validation.
    fn oracle(&self, expected_addr: &Pubkey) -> Option<(i64, i64, bool)>;
    fn set_batch_counter(&mut self, value: u64) -> ProgramResult;
    fn next_batch_size(&self) -> usize;
    /// Runtime requires authenticated reservation provenance; arithmetic-only fixtures may opt out.
    fn require_reservations(&self) -> bool {
        true
    }
    fn cancel_order(&mut self, order_id: u64) -> ProgramResult;
    fn next_batch(&mut self) -> &mut Batch;
    /// Set the trading and withdrawals pause bits after the insurance fund
    /// could not cover a counterparty payout.
    fn pause_trading_and_withdrawals(&mut self) -> ProgramResult;
}

pub(super) fn settle(
    batch: &mut Batch,
    instrument: &mut Instrument,
    results: &[u8],
    commitments: &mut impl States<Commitment>,
    portfolios: &mut impl States<Portfolio>,
    env: &mut impl Environment,
) -> ProgramResult {
    if batch.status != BatchStatus::Cleared {
        return Err(MgkError::InvalidInstruction.into());
    }
    let clock = env.clock()?;
    let conversion = match env.oracle(&instrument.oracle_addr) {
        Some((price, ts, true))
            if price > 0
                && ts > 0
                && ts <= clock.unix_timestamp
                && clock
                    .unix_timestamp
                    .checked_sub(ts)
                    .is_some_and(|age| age <= 60) =>
        {
            price
        }
        _ => return Err(MgkError::StalePrice.into()),
    };
    // Restricted demo fee schedule: no governance retune or maker rebates.
    Instrument::validate_demo_fees(instrument.taker_fee_bps, instrument.maker_fee_bps)?;
    let registry = env.registry()?;
    let dfba = results.len() >= DFBA_RESULT_HEADER_BYTES
        && (batch.matched_bid_qty > 0
            || batch.matched_ask_qty > 0
            || batch.mark_valid != 0
            || results.len() >= DFBA_RESULT_HEADER_BYTES + DFBA_FILL_WIRE_BYTES);
    let (base, stride, n) = if dfba {
        (
            DFBA_RESULT_HEADER_BYTES,
            DFBA_FILL_WIRE_BYTES,
            u16::from_le_bytes(results[32..34].try_into().unwrap()) as usize,
        )
    } else {
        if results.len() < RESULTS_HEADER_BYTES {
            return Err(ProgramError::AccountDataTooSmall);
        }
        (
            RESULTS_HEADER_BYTES,
            RESULTS_BYTES_PER_FILL,
            u16::from_le_bytes(results[..2].try_into().unwrap()) as usize,
        )
    };
    if results.len() < base + n * stride {
        return Err(ProgramError::AccountDataTooSmall);
    }
    // Validate the complete portfolio set before the first accounting write.
    // Runtime also checks canonical account addresses, ownership and writability.
    if portfolios.len() > mgk_common::matcher::MAX_SETTLEMENT_ORDERS {
        return Err(MgkError::InvalidPortfolio.into());
    }
    for i in 0..portfolios.len() {
        let user = portfolios.get_mut(i)?.user;
        for j in 0..i {
            if portfolios.get_mut(j)?.user == user {
                return Err(MgkError::InvalidPortfolio.into());
            }
        }
    }
    for i in 0..n {
        let off = base + i * stride;
        let user: Pubkey = results[off..off + 32].try_into().unwrap();
        let mut found = false;
        for j in 0..portfolios.len() {
            if portfolios.get_mut(j)?.user == user {
                found = true;
                break;
            }
        }
        if !found {
            return Err(MgkError::InvalidPortfolio.into());
        }
    }
    let mut effective = [0u64; mgk_common::matcher::MAX_SETTLEMENT_ORDERS];
    let has_reservations = if dfba {
        (0..portfolios.len()).any(|j| {
            portfolios
                .get_mut(j)
                .is_ok_and(|p| p.orders.iter().any(|o| o.remaining_qty != 0))
        })
    } else {
        false
    };
    let reserved_path = dfba && (env.require_reservations() || has_reservations);
    if reserved_path {
        clip_auctions(
            results,
            portfolios,
            instrument.instrument_id,
            n,
            &mut effective,
        )?;
    }
    let mut total_settled = 0u32;
    let mut total_volume = 0u64;
    let mut total_notional = 0u128;
    for i in 0..n {
        let off = base + i * stride;
        let user: Pubkey = results[off..off + 32].try_into().unwrap();
        let (mut qty, price, maker, side) = if dfba {
            let qty = u64::from_le_bytes(results[off + 40..off + 48].try_into().unwrap());
            let price = i64::from_le_bytes(results[off + 48..off + 56].try_into().unwrap());
            let maker_byte = results[off + 56];
            let auction = results[off + 57];
            if maker_byte > 1 || auction > 1 {
                return Err(MgkError::InvalidOrder.into());
            }
            let maker = maker_byte != 0;
            (
                qty,
                price,
                maker,
                if (auction == 0) == maker { 1i64 } else { -1 },
            )
        } else {
            let qty = u64::from_le_bytes(results[off + 32..off + 40].try_into().unwrap());
            if qty == 0 {
                continue;
            }
            let notional = u64::from_le_bytes(results[off + 40..off + 48].try_into().unwrap());
            let maker = results[off + 48] != 0;
            let mut side = None;
            for j in 0..commitments.len().min(batch.total_commitments as usize) {
                let commitment = commitments.get_mut(j)?;
                if commitment.user == user && commitment.status == CommitmentStatus::Revealed {
                    side = Some(if commitment.revealed.side as u8 == 0 {
                        1
                    } else {
                        -1
                    });
                    break;
                }
            }
            let side = side.ok_or(MgkError::InvalidCommitment)?;
            if notional % qty != 0 {
                return Err(MgkError::InvalidPrice.into());
            }
            (
                qty,
                i64::try_from(notional / qty).map_err(|_| MgkError::Overflow)?,
                maker,
                side,
            )
        };
        if reserved_path {
            let order_id = u64::from_le_bytes(results[off + 32..off + 40].try_into().unwrap());
            let accepted = effective.get(i).copied().ok_or(MgkError::InvalidOrder)?;
            for j in 0..portfolios.len() {
                let p = portfolios.get_mut(j)?;
                if p.user != user {
                    continue;
                }
                let index = p
                    .orders
                    .iter()
                    .position(|o| o.remaining_qty != 0 && o.order_id == order_id)
                    .ok_or(MgkError::InvalidOrder)?;
                let reduce_only = p.orders[index].reduce_only != 0;
                crate::risk::release(p, index, qty)?;
                if reduce_only && accepted < qty {
                    if p.orders[index].remaining_qty != 0 {
                        crate::risk::release(p, index, p.orders[index].remaining_qty)?;
                    }
                    env.cancel_order(order_id)?;
                }
                break;
            }
            qty = accepted;
        }
        if qty == 0 {
            continue;
        }
        let signed = i64::try_from(qty)
            .map_err(|_| MgkError::Overflow)?
            .checked_mul(side)
            .ok_or(MgkError::Overflow)?;
        let mut found = false;
        for j in 0..portfolios.len() {
            let portfolio = portfolios.get_mut(j)?;
            if portfolio.user != user {
                continue;
            }
            let old_qty = position_qty(portfolio, instrument.instrument_id);
            let (realized, fee) = apply_fill(
                portfolio,
                instrument.instrument_id,
                signed,
                price,
                maker,
                conversion,
            )?;
            let new_qty = position_qty(portfolio, instrument.instrument_id);
            let vault = env.vault()?;
            vault.apply_position_change(old_qty, new_qty)?;
            let shortfall = settle_cash(portfolio, vault, realized, fee)?;
            crate::risk::refresh(portfolio, instrument.instrument_id, conversion)?;
            if shortfall > 0 {
                env.pause_trading_and_withdrawals()?;
            }
            found = true;
            total_settled = total_settled.checked_add(1).ok_or(MgkError::Overflow)?;
            break;
        }
        if !found {
            return Err(MgkError::InvalidPortfolio.into());
        }
        total_volume = total_volume.checked_add(qty).ok_or(MgkError::Overflow)?;
        total_notional = total_notional
            .checked_add(
                (qty as u128)
                    .checked_mul(price as u128)
                    .ok_or(MgkError::Overflow)?,
            )
            .ok_or(MgkError::Overflow)?;
    }
    for j in 0..portfolios.len() {
        let p = portfolios.get_mut(j)?;
        if reserved_path {
            for k in 0..p.orders.len() {
                let o = p.orders[k];
                if o.remaining_qty == 0 || o.reduce_only == 0 {
                    continue;
                }
                let qty = p
                    .find_position(o.instrument_id)
                    .map_or(0, |(_, pos)| pos.qty);
                if qty == 0 || (qty > 0) == (o.side == 0) {
                    crate::risk::release(p, k, o.remaining_qty)?;
                    env.cancel_order(o.order_id)?;
                }
            }
        }
        crate::risk::refresh(p, instrument.instrument_id, conversion)?;
    }
    // The legacy deposit lifecycle remains until retired by the restricted path ticket.
    let mut slashed = 0u128;
    for i in 0..commitments.len().min(batch.total_commitments as usize) {
        let commitment = commitments.get_mut(i)?;
        if !matches!(
            commitment.status,
            CommitmentStatus::Pending | CommitmentStatus::Revealed
        ) {
            continue;
        }
        if commitment.status == CommitmentStatus::Pending {
            commitment.status = CommitmentStatus::Slashed;
            slashed = slashed
                .checked_add(commitment.deposit_lamports as u128)
                .ok_or(MgkError::Overflow)?;
        } else {
            commitment.status = CommitmentStatus::Settled;
        }
        for j in 0..portfolios.len() {
            let portfolio = portfolios.get_mut(j)?;
            if portfolio.user == commitment.user {
                crate::risk::refresh(portfolio, instrument.instrument_id, conversion)?;
                break;
            }
        }
    }
    // A slashed legacy deposit is bookkeeping only: `commit_order` never moved
    // lamports into the vault, so crediting the fund would be unbacked cash.
    if batch.mark_valid == 0 && total_volume > 0 {
        batch.clearing_price =
            i64::try_from(total_notional / total_volume as u128).map_err(|_| MgkError::Overflow)?;
    }
    batch.total_settled = total_settled;
    if total_volume > 0 || reserved_path {
        batch.total_volume = total_volume;
    }
    batch.total_notional = total_notional;
    batch.slashed_deposits = batch
        .slashed_deposits
        .checked_add(slashed)
        .ok_or(MgkError::Overflow)?;
    batch.status = BatchStatus::Settled;
    env.validate_book(instrument.instrument_id)?;
    if batch.mark_valid != 0 {
        instrument.mark_price = batch.clearing_price;
    }
    // Funding is unconditionally disabled, including cursor/checkpoint writes.
    env.set_batch_counter(
        registry
            .batch_id_counter
            .checked_add(1)
            .ok_or(MgkError::Overflow)?,
    )?;
    if env.next_batch_size() != core::mem::size_of::<Batch>() {
        return Err(MgkError::InvalidAccount.into());
    }
    let next = env.next_batch();
    if next.batch_id != 0
        || next.header.discriminator != mgk_common::layout::discriminator::UNINITIALIZED
    {
        return Err(MgkError::AlreadyInitialized.into());
    }
    next.initialize_in_place(
        batch.batch_id.checked_add(1).ok_or(MgkError::Overflow)?,
        clock
            .slot
            .checked_add(registry.t_max_slots)
            .ok_or(MgkError::Overflow)?,
        0,
        0,
    );
    Ok(())
}

/// The allocator removes self liquidity before allocation, so a user has one
/// direction within each auction. Clip in results order, then trim the surplus
/// side from its tail. Prefixes stay intact; the next auction sees final positions.
fn clip_auctions(
    results: &[u8],
    portfolios: &mut impl States<Portfolio>,
    instrument_id: u16,
    n: usize,
    effective: &mut [u64; mgk_common::matcher::MAX_SETTLEMENT_ORDERS],
) -> ProgramResult {
    if n > effective.len() {
        return Err(MgkError::InvalidOrder.into());
    }
    let mut projected = [0i64; mgk_common::matcher::MAX_SETTLEMENT_ORDERS];
    let mut owners = [[0u8; 32]; mgk_common::matcher::MAX_SETTLEMENT_ORDERS];
    for j in 0..portfolios.len() {
        let p = portfolios.get_mut(j)?;
        owners[j] = p.user;
        projected[j] = p.find_position(instrument_id).map_or(0, |(_, pos)| pos.qty);
    }
    let mut previous_auction = 0;
    for auction in 0..2u8 {
        let before = projected;
        let mut direction = [0i64; mgk_common::matcher::MAX_SETTLEMENT_ORDERS];
        let mut totals = [0u64; 2];
        for (i, quantity) in effective.iter_mut().enumerate().take(n) {
            let off = DFBA_RESULT_HEADER_BYTES + i * DFBA_FILL_WIRE_BYTES;
            let leg = results[off + 57];
            if auction == 0 {
                if leg > 1 || leg < previous_auction {
                    return Err(MgkError::InvalidOrder.into());
                }
                previous_auction = leg;
            }
            if leg != auction {
                continue;
            }
            let maker = results[off + 56];
            if maker > 1 {
                return Err(MgkError::InvalidOrder.into());
            }
            let side = if (leg == 0) == (maker != 0) { 1i64 } else { -1 };
            let user: Pubkey = results[off..off + 32].try_into().unwrap();
            let j = owners[..portfolios.len()]
                .iter()
                .position(|u| u == &user)
                .ok_or(MgkError::InvalidPortfolio)?;
            if direction[j] != 0 && direction[j] != side {
                return Err(MgkError::InvalidOrder.into());
            }
            direction[j] = side;
            let id = u64::from_le_bytes(results[off + 32..off + 40].try_into().unwrap());
            let raw_qty = u64::from_le_bytes(results[off + 40..off + 48].try_into().unwrap());
            let price = i64::from_le_bytes(results[off + 48..off + 56].try_into().unwrap());
            let p = portfolios.get_mut(j)?;
            let order = p
                .orders
                .iter()
                .find(|o| o.remaining_qty != 0 && o.order_id == id)
                .ok_or(MgkError::InvalidOrder)?;
            if order.instrument_id != instrument_id
                || order.side != u8::from(side < 0)
                || raw_qty > order.remaining_qty
                || price <= 0
                || (side > 0 && price > order.price)
                || (side < 0 && price < order.price)
            {
                return Err(MgkError::InvalidOrder.into());
            }
            // One authenticated result per order, including across auctions.
            for earlier in 0..i {
                let prev = DFBA_RESULT_HEADER_BYTES + earlier * DFBA_FILL_WIRE_BYTES;
                if results[prev + 32..prev + 40] == results[off + 32..off + 40] {
                    return Err(MgkError::InvalidOrder.into());
                }
            }
            let qty = if order.reduce_only != 0 {
                if projected[j].signum() == -side {
                    raw_qty.min(projected[j].unsigned_abs())
                } else {
                    0
                }
            } else {
                raw_qty
            };
            let signed = i64::try_from(qty)
                .map_err(|_| MgkError::Overflow)?
                .checked_mul(side)
                .ok_or(MgkError::Overflow)?;
            projected[j] = projected[j].checked_add(signed).ok_or(MgkError::Overflow)?;
            *quantity = qty;
            let which = usize::from(side < 0);
            totals[which] = totals[which].checked_add(qty).ok_or(MgkError::Overflow)?;
        }
        let surplus_side = usize::from(totals[1] > totals[0]);
        let mut excess = totals[0].abs_diff(totals[1]);
        for i in (0..n).rev() {
            let off = DFBA_RESULT_HEADER_BYTES + i * DFBA_FILL_WIRE_BYTES;
            if results[off + 57] != auction {
                continue;
            }
            let buy = (auction == 0) == (results[off + 56] != 0);
            if usize::from(!buy) != surplus_side {
                continue;
            }
            let cancel = excess.min(effective[i]);
            effective[i] -= cancel;
            excess -= cancel;
        }
        projected = before;
        for (i, &qty) in effective.iter().enumerate().take(n) {
            let off = DFBA_RESULT_HEADER_BYTES + i * DFBA_FILL_WIRE_BYTES;
            if results[off + 57] != auction {
                continue;
            }
            let user: Pubkey = results[off..off + 32].try_into().unwrap();
            let j = owners[..portfolios.len()]
                .iter()
                .position(|u| u == &user)
                .ok_or(MgkError::InvalidPortfolio)?;
            let side = if (auction == 0) == (results[off + 56] != 0) {
                1i64
            } else {
                -1
            };
            projected[j] = projected[j]
                .checked_add(i64::try_from(qty).map_err(|_| MgkError::Overflow)? * side)
                .ok_or(MgkError::Overflow)?;
        }
    }
    Ok(())
}

fn mul(a: i128, b: i128) -> Result<i128, ProgramError> {
    a.checked_mul(b).ok_or_else(|| MgkError::Overflow.into())
}
fn add(a: i128, b: i128) -> Result<i128, ProgramError> {
    a.checked_add(b).ok_or_else(|| MgkError::Overflow.into())
}
fn gcd(mut a: i128, mut b: i128) -> i128 {
    while b != 0 {
        let rem = a % b;
        a = b;
        b = rem;
    }
    a
}
/// Floor of an exact signed rational; debits round away from zero.
fn floor_ratio(n: i128, d: i128) -> i128 {
    n.div_euclid(d)
}
/// Cross-cancel before scaling to retain the widest usable input range.
fn lamports(n: i128, d: i128, price: i64) -> Result<i128, ProgramError> {
    let denominator = mul(d, price as i128)?;
    let divisor = gcd(LAMPORTS_PER_SOL, denominator);
    Ok(floor_ratio(
        mul(n, LAMPORTS_PER_SOL / divisor)?,
        denominator / divisor,
    ))
}

fn apply_fill(
    p: &mut Portfolio,
    instrument_id: u16,
    qty: i64,
    price: i64,
    maker: bool,
    conversion: i64,
) -> Result<(i128, i128), ProgramError> {
    if price <= 0 || conversion <= 0 || qty == 0 || qty == i64::MIN {
        return Err(MgkError::InvalidPrice.into());
    }
    let mut usd_n = 0i128;
    let mut usd_d = 1i128;
    if let Some((idx, old)) = p.find_position(instrument_id) {
        let old = *old;
        if old.qty == i64::MIN || old.qty == 0 || old.entry_vwap <= 0 {
            return Err(MgkError::InvalidAccount.into());
        }
        let old_d = old.entry_denominator.max(1) as i128;
        if !matches!(old.entry_denominator, 0 | ENTRY_PRICE_SCALE)
            || old.entry_remainder as i128 >= old_d
        {
            return Err(MgkError::InvalidAccount.into());
        }
        let old_n = add(
            mul(old.entry_vwap as i128, old_d)?,
            old.entry_remainder as i128,
        )?;
        let new_qty = old.qty.checked_add(qty).ok_or(MgkError::Overflow)?;
        if old.qty.signum() == qty.signum() {
            let scale = ENTRY_PRICE_SCALE as i128;
            let old_scaled = add(
                mul(old.entry_vwap as i128, scale)?,
                old.entry_remainder as i128,
            )?;
            let numerator = add(
                mul(old_scaled, old.qty.unsigned_abs() as i128)?,
                mul(mul(price as i128, scale)?, qty.unsigned_abs() as i128)?,
            )?;
            let denominator = new_qty.unsigned_abs() as i128;
            // Long entries round up and short entries down: either direction
            // can only reduce a trader's later realized payoff.
            let scaled = add(
                numerator / denominator,
                i128::from(qty > 0 && numerator % denominator != 0),
            )?;
            p.positions[idx].entry_vwap =
                i64::try_from(scaled / scale).map_err(|_| MgkError::Overflow)?;
            p.positions[idx].entry_remainder = (scaled % scale) as u64;
            p.positions[idx].entry_denominator = if scaled % scale == 0 {
                0
            } else {
                ENTRY_PRICE_SCALE
            };
            p.positions[idx].qty = new_qty;
        } else {
            let closed = old.qty.unsigned_abs().min(qty.unsigned_abs()) as i128;
            let diff = mul(price as i128, old_d)?
                .checked_sub(old_n)
                .ok_or(MgkError::Overflow)?;
            usd_n = mul(mul(closed, diff)?, old.qty.signum() as i128)?;
            usd_d = mul(old_d, LOTS_PER_SOL)?;
            if new_qty == 0 {
                let last = p.positions_len as usize - 1;
                p.positions[idx] = p.positions[last];
                p.positions[last] = Position::default();
                p.positions_len -= 1;
            } else if new_qty.signum() != old.qty.signum() {
                p.positions[idx] = Position {
                    instrument_id,
                    qty: new_qty,
                    entry_vwap: price,
                    ..Position::default()
                };
            } else {
                p.positions[idx].qty = new_qty;
            }
        }
    } else {
        let idx = p.positions_len as usize;
        if idx >= p.positions.len() {
            return Err(MgkError::PoolFull.into());
        }
        p.positions[idx] = Position {
            instrument_id,
            qty,
            entry_vwap: price,
            ..Position::default()
        };
        p.positions_len += 1;
    }
    let realized = lamports(usd_n, usd_d, conversion)?;
    // Fee conversion uses the exact fill notional, with one final ceil.
    let fee = if maker {
        0
    } else {
        -lamports(
            -mul(
                mul(qty.unsigned_abs() as i128, price as i128)?,
                Instrument::DEMO_TAKER_FEE_BPS as i128,
            )?,
            LOTS_PER_SOL * 10_000,
            conversion,
        )?
    };
    p.realized_usd = add(p.realized_usd, floor_ratio(usd_n, usd_d))?;
    crate::risk::refresh(p, instrument_id, conversion)?;
    Ok((realized, fee))
}

fn position_qty(p: &Portfolio, instrument_id: u16) -> i64 {
    p.find_position(instrument_id).map_or(0, |(_, pos)| pos.qty)
}

#[cfg(test)]
pub(super) mod tests;
