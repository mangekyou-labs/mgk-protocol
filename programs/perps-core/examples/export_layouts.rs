//! Regenerate: cargo run -p mgk-perps-core --example export_layouts > mgk-frontend/packages/layout/program-layouts.json
use core::mem::{offset_of, size_of};
use mgk_common::book::{BookLevel, OrderBook};
use mgk_common::header::SlabHeader;
use mgk_common::layout::AccountLayout;
use mgk_oracle::state::PriceOracle;
use mgk_perps_core::state::*;
use mgk_perps_matcher::state::book::RestingOrder;
use serde_json::{json, Map, Value};
fn main() {
    let mut layouts = Map::new();
    {
        let mut fields = Map::new();
        fields.insert(
            "governance".into(),
            json!([offset_of!(Registry, governance), "pubkey"]),
        );
        fields.insert(
            "instrumentCount".into(),
            json!([offset_of!(Registry, instrument_count), "u16"]),
        );
        fields.insert(
            "volatilityMultiplier".into(),
            json!([offset_of!(Registry, volatility_multiplier), "u16"]),
        );
        fields.insert(
            "batchIdCounter".into(),
            json!([offset_of!(Registry, batch_id_counter), "u64"]),
        );
        fields.insert(
            "baseDeposit".into(),
            json!([offset_of!(Registry, base_deposit), "u64"]),
        );
        fields.insert("nMin".into(), json!([offset_of!(Registry, n_min), "u32"]));
        fields.insert(
            "tMinSlots".into(),
            json!([offset_of!(Registry, t_min_slots), "u64"]),
        );
        fields.insert(
            "tMaxSlots".into(),
            json!([offset_of!(Registry, t_max_slots), "u64"]),
        );
        fields.insert(
            "tRevealSlots".into(),
            json!([offset_of!(Registry, t_reveal_slots), "u64"]),
        );
        fields.insert("bump".into(), json!([offset_of!(Registry, bump), "u8"]));
        fields.insert(
            "pauseFlags".into(),
            json!([offset_of!(Registry, pause_flags), "u8"]),
        );
        fields.insert(
            "maxOrdersPerBatch".into(),
            json!([offset_of!(Registry, max_orders_per_batch), "u8"]),
        );
        fields.insert(
            "marginalSizeCap".into(),
            json!([offset_of!(Registry, marginal_size_cap), "u8"]),
        );
        let mut bytes = vec![0u8; size_of::<Registry>()];
        bytes[0] = Registry::DISCRIMINATOR;
        bytes[1] = Registry::LAYOUT_VERSION;
        bytes[offset_of!(Registry, governance)..offset_of!(Registry, governance) + 32].fill(18);
        bytes[offset_of!(Registry, instrument_count)
            ..offset_of!(Registry, instrument_count) + size_of::<u16>()]
            .copy_from_slice(&(19u16).to_le_bytes());
        bytes[offset_of!(Registry, volatility_multiplier)
            ..offset_of!(Registry, volatility_multiplier) + size_of::<u16>()]
            .copy_from_slice(&(20u16).to_le_bytes());
        bytes[offset_of!(Registry, batch_id_counter)
            ..offset_of!(Registry, batch_id_counter) + size_of::<u64>()]
            .copy_from_slice(&(21u64).to_le_bytes());
        bytes[offset_of!(Registry, base_deposit)
            ..offset_of!(Registry, base_deposit) + size_of::<u64>()]
            .copy_from_slice(&(22u64).to_le_bytes());
        bytes[offset_of!(Registry, n_min)..offset_of!(Registry, n_min) + size_of::<u32>()]
            .copy_from_slice(&(23u32).to_le_bytes());
        bytes[offset_of!(Registry, t_min_slots)
            ..offset_of!(Registry, t_min_slots) + size_of::<u64>()]
            .copy_from_slice(&(24u64).to_le_bytes());
        bytes[offset_of!(Registry, t_max_slots)
            ..offset_of!(Registry, t_max_slots) + size_of::<u64>()]
            .copy_from_slice(&(25u64).to_le_bytes());
        bytes[offset_of!(Registry, t_reveal_slots)
            ..offset_of!(Registry, t_reveal_slots) + size_of::<u64>()]
            .copy_from_slice(&(26u64).to_le_bytes());
        bytes[offset_of!(Registry, bump)..offset_of!(Registry, bump) + size_of::<u8>()]
            .copy_from_slice(&(27u8).to_le_bytes());
        bytes[offset_of!(Registry, pause_flags)
            ..offset_of!(Registry, pause_flags) + size_of::<u8>()]
            .copy_from_slice(&(28u8).to_le_bytes());
        bytes[offset_of!(Registry, max_orders_per_batch)
            ..offset_of!(Registry, max_orders_per_batch) + size_of::<u8>()]
            .copy_from_slice(&(29u8).to_le_bytes());
        bytes[offset_of!(Registry, marginal_size_cap)
            ..offset_of!(Registry, marginal_size_cap) + size_of::<u8>()]
            .copy_from_slice(&(30u8).to_le_bytes());
        layouts.insert("Registry".into(), json!({"size":size_of::<Registry>(),"fields":fields,"fixture":bytes,"discriminator":Registry::DISCRIMINATOR,"version":Registry::LAYOUT_VERSION}));
    }
    {
        let mut fields = Map::new();
        fields.insert(
            "user".into(),
            json!([offset_of!(Portfolio, user), "pubkey"]),
        );
        fields.insert(
            "equity".into(),
            json!([offset_of!(Portfolio, equity), "i128"]),
        );
        fields.insert(
            "principal".into(),
            json!([offset_of!(Portfolio, principal), "i128"]),
        );
        fields.insert(
            "realizedUsd".into(),
            json!([offset_of!(Portfolio, realized_usd), "i128"]),
        );
        fields.insert(
            "realizedLamports".into(),
            json!([offset_of!(Portfolio, realized_lamports), "i128"]),
        );
        fields.insert(
            "feesPaid".into(),
            json!([offset_of!(Portfolio, fees_paid), "i128"]),
        );
        fields.insert(
            "fundingPaid".into(),
            json!([offset_of!(Portfolio, funding_paid), "i128"]),
        );
        fields.insert("im".into(), json!([offset_of!(Portfolio, im), "u128"]));
        fields.insert("mm".into(), json!([offset_of!(Portfolio, mm), "u128"]));
        fields.insert(
            "freeCollateral".into(),
            json!([offset_of!(Portfolio, free_collateral), "i128"]),
        );
        fields.insert(
            "health".into(),
            json!([offset_of!(Portfolio, health), "i128"]),
        );
        fields.insert(
            "positionsLen".into(),
            json!([offset_of!(Portfolio, positions_len), "u16"]),
        );
        fields.insert(
            "positions".into(),
            json!([offset_of!(Portfolio, positions), "[Position; 32]"]),
        );
        fields.insert(
            "lastFundingCheckpoint".into(),
            json!([offset_of!(Portfolio, last_funding_checkpoint), "[i128; 32]"]),
        );
        fields.insert(
            "lastBatchId".into(),
            json!([offset_of!(Portfolio, last_batch_id), "u64"]),
        );
        fields.insert(
            "lastSlot".into(),
            json!([offset_of!(Portfolio, last_slot), "u64"]),
        );
        fields.insert("bump".into(), json!([offset_of!(Portfolio, bump), "u8"]));
        fields.insert(
            "reservedCollateral".into(),
            json!([offset_of!(Portfolio, reserved_collateral), "u128"]),
        );
        fields.insert(
            "riskPnl".into(),
            json!([offset_of!(Portfolio, risk_pnl), "i128"]),
        );
        fields.insert(
            "orders".into(),
            json!([offset_of!(Portfolio, orders), "[OrderReservation; 12]"]),
        );
        let mut bytes = vec![0u8; size_of::<Portfolio>()];
        bytes[0] = Portfolio::DISCRIMINATOR;
        bytes[1] = Portfolio::LAYOUT_VERSION;
        bytes[offset_of!(Portfolio, user)..offset_of!(Portfolio, user) + 32].fill(18);
        bytes[offset_of!(Portfolio, equity)..offset_of!(Portfolio, equity) + size_of::<i128>()]
            .copy_from_slice(&(-((1i128 << 100) + 20)).to_le_bytes());
        bytes[offset_of!(Portfolio, principal)
            ..offset_of!(Portfolio, principal) + size_of::<i128>()]
            .copy_from_slice(&(21i128).to_le_bytes());
        bytes[offset_of!(Portfolio, realized_usd)
            ..offset_of!(Portfolio, realized_usd) + size_of::<i128>()]
            .copy_from_slice(&(22i128).to_le_bytes());
        bytes[offset_of!(Portfolio, realized_lamports)
            ..offset_of!(Portfolio, realized_lamports) + size_of::<i128>()]
            .copy_from_slice(&(23i128).to_le_bytes());
        bytes[offset_of!(Portfolio, fees_paid)
            ..offset_of!(Portfolio, fees_paid) + size_of::<i128>()]
            .copy_from_slice(&(24i128).to_le_bytes());
        bytes[offset_of!(Portfolio, funding_paid)
            ..offset_of!(Portfolio, funding_paid) + size_of::<i128>()]
            .copy_from_slice(&(25i128).to_le_bytes());
        bytes[offset_of!(Portfolio, im)..offset_of!(Portfolio, im) + size_of::<u128>()]
            .copy_from_slice(&(26u128).to_le_bytes());
        bytes[offset_of!(Portfolio, mm)..offset_of!(Portfolio, mm) + size_of::<u128>()]
            .copy_from_slice(&(27u128).to_le_bytes());
        bytes[offset_of!(Portfolio, free_collateral)
            ..offset_of!(Portfolio, free_collateral) + size_of::<i128>()]
            .copy_from_slice(&(28i128).to_le_bytes());
        bytes[offset_of!(Portfolio, health)..offset_of!(Portfolio, health) + size_of::<i128>()]
            .copy_from_slice(&(29i128).to_le_bytes());
        bytes[offset_of!(Portfolio, positions_len)
            ..offset_of!(Portfolio, positions_len) + size_of::<u16>()]
            .copy_from_slice(&(1u16).to_le_bytes());
        bytes[offset_of!(Portfolio, last_batch_id)
            ..offset_of!(Portfolio, last_batch_id) + size_of::<u64>()]
            .copy_from_slice(&(35u64).to_le_bytes());
        bytes
            [offset_of!(Portfolio, last_slot)..offset_of!(Portfolio, last_slot) + size_of::<u64>()]
            .copy_from_slice(&(36u64).to_le_bytes());
        bytes[offset_of!(Portfolio, bump)..offset_of!(Portfolio, bump) + size_of::<u8>()]
            .copy_from_slice(&(37u8).to_le_bytes());
        bytes[offset_of!(Portfolio, reserved_collateral)
            ..offset_of!(Portfolio, reserved_collateral) + size_of::<u128>()]
            .copy_from_slice(&(40u128).to_le_bytes());
        bytes[offset_of!(Portfolio, risk_pnl)..offset_of!(Portfolio, risk_pnl) + size_of::<i128>()]
            .copy_from_slice(&(41i128).to_le_bytes());
        layouts.insert("Portfolio".into(), json!({"size":size_of::<Portfolio>(),"fields":fields,"fixture":bytes,"discriminator":Portfolio::DISCRIMINATOR,"version":Portfolio::LAYOUT_VERSION}));
    }
    {
        let mut fields = Map::new();
        fields.insert(
            "instrumentId".into(),
            json!([offset_of!(Position, instrument_id), "u16"]),
        );
        fields.insert("qty".into(), json!([offset_of!(Position, qty), "i64"]));
        fields.insert(
            "entryVwap".into(),
            json!([offset_of!(Position, entry_vwap), "i64"]),
        );
        fields.insert(
            "entryRemainder".into(),
            json!([offset_of!(Position, entry_remainder), "u64"]),
        );
        fields.insert(
            "entryDenominator".into(),
            json!([offset_of!(Position, entry_denominator), "u64"]),
        );
        let mut bytes = vec![0u8; size_of::<Position>()];
        bytes[offset_of!(Position, instrument_id)
            ..offset_of!(Position, instrument_id) + size_of::<u16>()]
            .copy_from_slice(&(17u16).to_le_bytes());
        bytes[offset_of!(Position, qty)..offset_of!(Position, qty) + size_of::<i64>()]
            .copy_from_slice(&(18i64).to_le_bytes());
        bytes
            [offset_of!(Position, entry_vwap)..offset_of!(Position, entry_vwap) + size_of::<i64>()]
            .copy_from_slice(&(19i64).to_le_bytes());
        bytes[offset_of!(Position, entry_remainder)
            ..offset_of!(Position, entry_remainder) + size_of::<u64>()]
            .copy_from_slice(&(20u64).to_le_bytes());
        bytes[offset_of!(Position, entry_denominator)
            ..offset_of!(Position, entry_denominator) + size_of::<u64>()]
            .copy_from_slice(&(21u64).to_le_bytes());
        layouts.insert("Position".into(), json!({"size":size_of::<Position>(),"fields":fields,"fixture":bytes,"discriminator":null,"version":null}));
    }
    {
        let mut fields = Map::new();
        fields.insert(
            "orderId".into(),
            json!([offset_of!(OrderReservation, order_id), "u64"]),
        );
        fields.insert(
            "originalQty".into(),
            json!([offset_of!(OrderReservation, original_qty), "u64"]),
        );
        fields.insert(
            "remainingQty".into(),
            json!([offset_of!(OrderReservation, remaining_qty), "u64"]),
        );
        fields.insert(
            "price".into(),
            json!([offset_of!(OrderReservation, price), "i64"]),
        );
        fields.insert(
            "initialReserve".into(),
            json!([offset_of!(OrderReservation, initial_reserve), "u128"]),
        );
        fields.insert(
            "instrumentId".into(),
            json!([offset_of!(OrderReservation, instrument_id), "u16"]),
        );
        fields.insert(
            "side".into(),
            json!([offset_of!(OrderReservation, side), "u8"]),
        );
        fields.insert(
            "reduceOnly".into(),
            json!([offset_of!(OrderReservation, reduce_only), "u8"]),
        );
        let mut bytes = vec![0u8; size_of::<OrderReservation>()];
        bytes[offset_of!(OrderReservation, order_id)
            ..offset_of!(OrderReservation, order_id) + size_of::<u64>()]
            .copy_from_slice(&(17u64).to_le_bytes());
        bytes[offset_of!(OrderReservation, original_qty)
            ..offset_of!(OrderReservation, original_qty) + size_of::<u64>()]
            .copy_from_slice(&(18u64).to_le_bytes());
        bytes[offset_of!(OrderReservation, remaining_qty)
            ..offset_of!(OrderReservation, remaining_qty) + size_of::<u64>()]
            .copy_from_slice(&(19u64).to_le_bytes());
        bytes[offset_of!(OrderReservation, price)
            ..offset_of!(OrderReservation, price) + size_of::<i64>()]
            .copy_from_slice(&(20i64).to_le_bytes());
        bytes[offset_of!(OrderReservation, initial_reserve)
            ..offset_of!(OrderReservation, initial_reserve) + size_of::<u128>()]
            .copy_from_slice(&(21u128).to_le_bytes());
        bytes[offset_of!(OrderReservation, instrument_id)
            ..offset_of!(OrderReservation, instrument_id) + size_of::<u16>()]
            .copy_from_slice(&(22u16).to_le_bytes());
        bytes[offset_of!(OrderReservation, side)
            ..offset_of!(OrderReservation, side) + size_of::<u8>()]
            .copy_from_slice(&(23u8).to_le_bytes());
        bytes[offset_of!(OrderReservation, reduce_only)
            ..offset_of!(OrderReservation, reduce_only) + size_of::<u8>()]
            .copy_from_slice(&(24u8).to_le_bytes());
        layouts.insert("OrderReservation".into(), json!({"size":size_of::<OrderReservation>(),"fields":fields,"fixture":bytes,"discriminator":null,"version":null}));
    }
    {
        let mut fields = Map::new();
        fields.insert(
            "instrumentId".into(),
            json!([offset_of!(Instrument, instrument_id), "u16"]),
        );
        fields.insert(
            "baseSymbol".into(),
            json!([offset_of!(Instrument, base_symbol), "[u8; 16]"]),
        );
        fields.insert(
            "contractSize".into(),
            json!([offset_of!(Instrument, contract_size), "u64"]),
        );
        fields.insert(
            "tickSize".into(),
            json!([offset_of!(Instrument, tick_size), "u64"]),
        );
        fields.insert(
            "lotSize".into(),
            json!([offset_of!(Instrument, lot_size), "u64"]),
        );
        fields.insert(
            "imrBps".into(),
            json!([offset_of!(Instrument, imr_bps), "u16"]),
        );
        fields.insert(
            "mmrBps".into(),
            json!([offset_of!(Instrument, mmr_bps), "u16"]),
        );
        fields.insert(
            "takerFeeBps".into(),
            json!([offset_of!(Instrument, taker_fee_bps), "u16"]),
        );
        fields.insert(
            "makerFeeBps".into(),
            json!([offset_of!(Instrument, maker_fee_bps), "i16"]),
        );
        fields.insert(
            "maxLeverage".into(),
            json!([offset_of!(Instrument, max_leverage), "u16"]),
        );
        fields.insert(
            "oracleAddr".into(),
            json!([offset_of!(Instrument, oracle_addr), "pubkey"]),
        );
        fields.insert(
            "cumFunding".into(),
            json!([offset_of!(Instrument, cum_funding), "i128"]),
        );
        fields.insert(
            "lastFundingSlot".into(),
            json!([offset_of!(Instrument, last_funding_slot), "u64"]),
        );
        fields.insert(
            "fundingIntervalSlots".into(),
            json!([offset_of!(Instrument, funding_interval_slots), "u64"]),
        );
        fields.insert(
            "isActive".into(),
            json!([offset_of!(Instrument, is_active), "bool"]),
        );
        fields.insert("bump".into(), json!([offset_of!(Instrument, bump), "u8"]));
        fields.insert(
            "markPrice".into(),
            json!([offset_of!(Instrument, mark_price), "i64"]),
        );
        fields.insert(
            "markReferenceQty".into(),
            json!([offset_of!(Instrument, mark_reference_qty), "u64"]),
        );
        fields.insert(
            "markDecayWindowSlots".into(),
            json!([offset_of!(Instrument, mark_decay_window_slots), "u64"]),
        );
        fields.insert(
            "fundingCoefficientBps".into(),
            json!([offset_of!(Instrument, funding_coefficient_bps), "i64"]),
        );
        fields.insert(
            "maxFundingRateBps".into(),
            json!([offset_of!(Instrument, max_funding_rate_bps), "i64"]),
        );
        let mut bytes = vec![0u8; size_of::<Instrument>()];
        bytes[0] = Instrument::DISCRIMINATOR;
        bytes[1] = Instrument::LAYOUT_VERSION;
        bytes[offset_of!(Instrument, instrument_id)
            ..offset_of!(Instrument, instrument_id) + size_of::<u16>()]
            .copy_from_slice(&(18u16).to_le_bytes());
        bytes[offset_of!(Instrument, contract_size)
            ..offset_of!(Instrument, contract_size) + size_of::<u64>()]
            .copy_from_slice(&(20u64).to_le_bytes());
        bytes[offset_of!(Instrument, tick_size)
            ..offset_of!(Instrument, tick_size) + size_of::<u64>()]
            .copy_from_slice(&(21u64).to_le_bytes());
        bytes
            [offset_of!(Instrument, lot_size)..offset_of!(Instrument, lot_size) + size_of::<u64>()]
            .copy_from_slice(&(22u64).to_le_bytes());
        bytes[offset_of!(Instrument, imr_bps)..offset_of!(Instrument, imr_bps) + size_of::<u16>()]
            .copy_from_slice(&(23u16).to_le_bytes());
        bytes[offset_of!(Instrument, mmr_bps)..offset_of!(Instrument, mmr_bps) + size_of::<u16>()]
            .copy_from_slice(&(24u16).to_le_bytes());
        bytes[offset_of!(Instrument, taker_fee_bps)
            ..offset_of!(Instrument, taker_fee_bps) + size_of::<u16>()]
            .copy_from_slice(&(25u16).to_le_bytes());
        bytes[offset_of!(Instrument, maker_fee_bps)
            ..offset_of!(Instrument, maker_fee_bps) + size_of::<i16>()]
            .copy_from_slice(&(26i16).to_le_bytes());
        bytes[offset_of!(Instrument, max_leverage)
            ..offset_of!(Instrument, max_leverage) + size_of::<u16>()]
            .copy_from_slice(&(27u16).to_le_bytes());
        bytes[offset_of!(Instrument, oracle_addr)..offset_of!(Instrument, oracle_addr) + 32]
            .fill(29);
        bytes[offset_of!(Instrument, cum_funding)
            ..offset_of!(Instrument, cum_funding) + size_of::<i128>()]
            .copy_from_slice(&(31i128).to_le_bytes());
        bytes[offset_of!(Instrument, last_funding_slot)
            ..offset_of!(Instrument, last_funding_slot) + size_of::<u64>()]
            .copy_from_slice(&(32u64).to_le_bytes());
        bytes[offset_of!(Instrument, funding_interval_slots)
            ..offset_of!(Instrument, funding_interval_slots) + size_of::<u64>()]
            .copy_from_slice(&(33u64).to_le_bytes());
        bytes[offset_of!(Instrument, is_active)] = 1;
        bytes[offset_of!(Instrument, bump)..offset_of!(Instrument, bump) + size_of::<u8>()]
            .copy_from_slice(&(35u8).to_le_bytes());
        bytes[offset_of!(Instrument, mark_price)
            ..offset_of!(Instrument, mark_price) + size_of::<i64>()]
            .copy_from_slice(&(37i64).to_le_bytes());
        bytes[offset_of!(Instrument, mark_reference_qty)
            ..offset_of!(Instrument, mark_reference_qty) + size_of::<u64>()]
            .copy_from_slice(&(38u64).to_le_bytes());
        bytes[offset_of!(Instrument, mark_decay_window_slots)
            ..offset_of!(Instrument, mark_decay_window_slots) + size_of::<u64>()]
            .copy_from_slice(&(39u64).to_le_bytes());
        bytes[offset_of!(Instrument, funding_coefficient_bps)
            ..offset_of!(Instrument, funding_coefficient_bps) + size_of::<i64>()]
            .copy_from_slice(&(40i64).to_le_bytes());
        bytes[offset_of!(Instrument, max_funding_rate_bps)
            ..offset_of!(Instrument, max_funding_rate_bps) + size_of::<i64>()]
            .copy_from_slice(&(42i64).to_le_bytes());
        layouts.insert("Instrument".into(), json!({"size":size_of::<Instrument>(),"fields":fields,"fixture":bytes,"discriminator":Instrument::DISCRIMINATOR,"version":Instrument::LAYOUT_VERSION}));
    }
    {
        let mut fields = Map::new();
        fields.insert(
            "batchId".into(),
            json!([offset_of!(Batch, batch_id), "u64"]),
        );
        fields.insert("status".into(), json!([offset_of!(Batch, status), "u8"]));
        fields.insert(
            "commitDeadlineSlot".into(),
            json!([offset_of!(Batch, commit_deadline_slot), "u64"]),
        );
        fields.insert(
            "revealDeadlineSlot".into(),
            json!([offset_of!(Batch, reveal_deadline_slot), "u64"]),
        );
        fields.insert(
            "closeSlot".into(),
            json!([offset_of!(Batch, close_slot), "u64"]),
        );
        fields.insert(
            "shuffleSeed".into(),
            json!([offset_of!(Batch, shuffle_seed), "u64"]),
        );
        fields.insert(
            "clearingPrice".into(),
            json!([offset_of!(Batch, clearing_price), "i64"]),
        );
        fields.insert(
            "totalCommitments".into(),
            json!([offset_of!(Batch, total_commitments), "u32"]),
        );
        fields.insert(
            "totalRevealed".into(),
            json!([offset_of!(Batch, total_revealed), "u32"]),
        );
        fields.insert(
            "totalSettled".into(),
            json!([offset_of!(Batch, total_settled), "u32"]),
        );
        fields.insert(
            "totalVolume".into(),
            json!([offset_of!(Batch, total_volume), "u64"]),
        );
        fields.insert(
            "totalNotional".into(),
            json!([offset_of!(Batch, total_notional), "u128"]),
        );
        fields.insert(
            "slashedDeposits".into(),
            json!([offset_of!(Batch, slashed_deposits), "u128"]),
        );
        fields.insert("bump".into(), json!([offset_of!(Batch, bump), "u8"]));
        fields.insert(
            "bidClearingPrice".into(),
            json!([offset_of!(Batch, bid_clearing_price), "i64"]),
        );
        fields.insert(
            "askClearingPrice".into(),
            json!([offset_of!(Batch, ask_clearing_price), "i64"]),
        );
        fields.insert(
            "matchedBidQty".into(),
            json!([offset_of!(Batch, matched_bid_qty), "u64"]),
        );
        fields.insert(
            "matchedAskQty".into(),
            json!([offset_of!(Batch, matched_ask_qty), "u64"]),
        );
        fields.insert(
            "markValid".into(),
            json!([offset_of!(Batch, mark_valid), "u8"]),
        );
        fields.insert(
            "liqPaused".into(),
            json!([offset_of!(Batch, liq_paused), "u8"]),
        );
        let mut bytes = vec![0u8; size_of::<Batch>()];
        bytes[0] = Batch::DISCRIMINATOR;
        bytes[1] = Batch::LAYOUT_VERSION;
        bytes[offset_of!(Batch, batch_id)..offset_of!(Batch, batch_id) + size_of::<u64>()]
            .copy_from_slice(&(18u64).to_le_bytes());
        bytes[offset_of!(Batch, commit_deadline_slot)
            ..offset_of!(Batch, commit_deadline_slot) + size_of::<u64>()]
            .copy_from_slice(&(21u64).to_le_bytes());
        bytes[offset_of!(Batch, reveal_deadline_slot)
            ..offset_of!(Batch, reveal_deadline_slot) + size_of::<u64>()]
            .copy_from_slice(&(22u64).to_le_bytes());
        bytes[offset_of!(Batch, close_slot)..offset_of!(Batch, close_slot) + size_of::<u64>()]
            .copy_from_slice(&(23u64).to_le_bytes());
        bytes[offset_of!(Batch, shuffle_seed)..offset_of!(Batch, shuffle_seed) + size_of::<u64>()]
            .copy_from_slice(&(24u64).to_le_bytes());
        bytes[offset_of!(Batch, clearing_price)
            ..offset_of!(Batch, clearing_price) + size_of::<i64>()]
            .copy_from_slice(&(25i64).to_le_bytes());
        bytes[offset_of!(Batch, total_commitments)
            ..offset_of!(Batch, total_commitments) + size_of::<u32>()]
            .copy_from_slice(&(26u32).to_le_bytes());
        bytes[offset_of!(Batch, total_revealed)
            ..offset_of!(Batch, total_revealed) + size_of::<u32>()]
            .copy_from_slice(&(27u32).to_le_bytes());
        bytes
            [offset_of!(Batch, total_settled)..offset_of!(Batch, total_settled) + size_of::<u32>()]
            .copy_from_slice(&(28u32).to_le_bytes());
        bytes[offset_of!(Batch, total_volume)..offset_of!(Batch, total_volume) + size_of::<u64>()]
            .copy_from_slice(&(29u64).to_le_bytes());
        bytes[offset_of!(Batch, total_notional)
            ..offset_of!(Batch, total_notional) + size_of::<u128>()]
            .copy_from_slice(&(31u128).to_le_bytes());
        bytes[offset_of!(Batch, slashed_deposits)
            ..offset_of!(Batch, slashed_deposits) + size_of::<u128>()]
            .copy_from_slice(&(32u128).to_le_bytes());
        bytes[offset_of!(Batch, bump)..offset_of!(Batch, bump) + size_of::<u8>()]
            .copy_from_slice(&(33u8).to_le_bytes());
        bytes[offset_of!(Batch, bid_clearing_price)
            ..offset_of!(Batch, bid_clearing_price) + size_of::<i64>()]
            .copy_from_slice(&(35i64).to_le_bytes());
        bytes[offset_of!(Batch, ask_clearing_price)
            ..offset_of!(Batch, ask_clearing_price) + size_of::<i64>()]
            .copy_from_slice(&(36i64).to_le_bytes());
        bytes[offset_of!(Batch, matched_bid_qty)
            ..offset_of!(Batch, matched_bid_qty) + size_of::<u64>()]
            .copy_from_slice(&(37u64).to_le_bytes());
        bytes[offset_of!(Batch, matched_ask_qty)
            ..offset_of!(Batch, matched_ask_qty) + size_of::<u64>()]
            .copy_from_slice(&(38u64).to_le_bytes());
        bytes[offset_of!(Batch, mark_valid)..offset_of!(Batch, mark_valid) + size_of::<u8>()]
            .copy_from_slice(&(39u8).to_le_bytes());
        bytes[offset_of!(Batch, liq_paused)..offset_of!(Batch, liq_paused) + size_of::<u8>()]
            .copy_from_slice(&(40u8).to_le_bytes());
        layouts.insert("Batch".into(), json!({"size":size_of::<Batch>(),"fields":fields,"fixture":bytes,"discriminator":Batch::DISCRIMINATOR,"version":Batch::LAYOUT_VERSION}));
    }
    {
        let mut fields = Map::new();
        fields.insert(
            "batchId".into(),
            json!([offset_of!(Commitment, batch_id), "u64"]),
        );
        fields.insert(
            "user".into(),
            json!([offset_of!(Commitment, user), "pubkey"]),
        );
        fields.insert(
            "orderHash".into(),
            json!([offset_of!(Commitment, order_hash), "[u8; 32]"]),
        );
        fields.insert(
            "depositLamports".into(),
            json!([offset_of!(Commitment, deposit_lamports), "u64"]),
        );
        fields.insert(
            "status".into(),
            json!([offset_of!(Commitment, status), "u8"]),
        );
        fields.insert(
            "nonce".into(),
            json!([offset_of!(Commitment, nonce), "u64"]),
        );
        fields.insert(
            "revealed".into(),
            json!([offset_of!(Commitment, revealed), "RevealedOrder"]),
        );
        let mut bytes = vec![0u8; size_of::<Commitment>()];
        bytes[0] = Commitment::DISCRIMINATOR;
        bytes[1] = Commitment::LAYOUT_VERSION;
        bytes
            [offset_of!(Commitment, batch_id)..offset_of!(Commitment, batch_id) + size_of::<u64>()]
            .copy_from_slice(&(18u64).to_le_bytes());
        bytes[offset_of!(Commitment, user)..offset_of!(Commitment, user) + 32].fill(19);
        bytes[offset_of!(Commitment, deposit_lamports)
            ..offset_of!(Commitment, deposit_lamports) + size_of::<u64>()]
            .copy_from_slice(&(21u64).to_le_bytes());
        bytes[offset_of!(Commitment, nonce)..offset_of!(Commitment, nonce) + size_of::<u64>()]
            .copy_from_slice(&(24u64).to_le_bytes());
        layouts.insert("Commitment".into(), json!({"size":size_of::<Commitment>(),"fields":fields,"fixture":bytes,"discriminator":Commitment::DISCRIMINATOR,"version":Commitment::LAYOUT_VERSION}));
    }
    {
        let mut fields = Map::new();
        fields.insert(
            "user".into(),
            json!([offset_of!(RevealedOrder, user), "pubkey"]),
        );
        fields.insert(
            "price".into(),
            json!([offset_of!(RevealedOrder, price), "i64"]),
        );
        fields.insert("qty".into(), json!([offset_of!(RevealedOrder, qty), "u64"]));
        fields.insert(
            "salt".into(),
            json!([offset_of!(RevealedOrder, salt), "u64"]),
        );
        fields.insert(
            "instrumentId".into(),
            json!([offset_of!(RevealedOrder, instrument_id), "u16"]),
        );
        fields.insert(
            "commitmentIdx".into(),
            json!([offset_of!(RevealedOrder, commitment_idx), "u32"]),
        );
        fields.insert(
            "orderType".into(),
            json!([offset_of!(RevealedOrder, order_type), "u8"]),
        );
        fields.insert(
            "side".into(),
            json!([offset_of!(RevealedOrder, side), "u8"]),
        );
        fields.insert(
            "reduceOnly".into(),
            json!([offset_of!(RevealedOrder, reduce_only), "bool"]),
        );
        let mut bytes = vec![0u8; size_of::<RevealedOrder>()];
        bytes[offset_of!(RevealedOrder, user)..offset_of!(RevealedOrder, user) + 32].fill(17);
        bytes
            [offset_of!(RevealedOrder, price)..offset_of!(RevealedOrder, price) + size_of::<i64>()]
            .copy_from_slice(&(18i64).to_le_bytes());
        bytes[offset_of!(RevealedOrder, qty)..offset_of!(RevealedOrder, qty) + size_of::<u64>()]
            .copy_from_slice(&(19u64).to_le_bytes());
        bytes[offset_of!(RevealedOrder, salt)..offset_of!(RevealedOrder, salt) + size_of::<u64>()]
            .copy_from_slice(&(20u64).to_le_bytes());
        bytes[offset_of!(RevealedOrder, instrument_id)
            ..offset_of!(RevealedOrder, instrument_id) + size_of::<u16>()]
            .copy_from_slice(&(21u16).to_le_bytes());
        bytes[offset_of!(RevealedOrder, commitment_idx)
            ..offset_of!(RevealedOrder, commitment_idx) + size_of::<u32>()]
            .copy_from_slice(&(22u32).to_le_bytes());
        bytes[offset_of!(RevealedOrder, reduce_only)] = 1;
        layouts.insert("RevealedOrder".into(), json!({"size":size_of::<RevealedOrder>(),"fields":fields,"fixture":bytes,"discriminator":null,"version":null}));
    }
    {
        let mut fields = Map::new();
        fields.insert("balance".into(), json!([offset_of!(Vault, balance), "u64"]));
        fields.insert(
            "insuranceFund".into(),
            json!([offset_of!(Vault, insurance_fund), "u128"]),
        );
        fields.insert(
            "uncoveredBadDebt".into(),
            json!([offset_of!(Vault, uncovered_bad_debt), "u128"]),
        );
        fields.insert(
            "openInterestLong".into(),
            json!([offset_of!(Vault, open_interest_long), "u64"]),
        );
        fields.insert(
            "openInterestShort".into(),
            json!([offset_of!(Vault, open_interest_short), "u64"]),
        );
        fields.insert("bump".into(), json!([offset_of!(Vault, bump), "u8"]));
        let mut bytes = vec![0u8; size_of::<Vault>()];
        bytes[0] = Vault::DISCRIMINATOR;
        bytes[1] = Vault::LAYOUT_VERSION;
        bytes[offset_of!(Vault, balance)..offset_of!(Vault, balance) + size_of::<u64>()]
            .copy_from_slice(&(18u64).to_le_bytes());
        bytes[offset_of!(Vault, insurance_fund)
            ..offset_of!(Vault, insurance_fund) + size_of::<u128>()]
            .copy_from_slice(&(19u128).to_le_bytes());
        bytes[offset_of!(Vault, uncovered_bad_debt)
            ..offset_of!(Vault, uncovered_bad_debt) + size_of::<u128>()]
            .copy_from_slice(&(20u128).to_le_bytes());
        bytes[offset_of!(Vault, open_interest_long)
            ..offset_of!(Vault, open_interest_long) + size_of::<u64>()]
            .copy_from_slice(&(21u64).to_le_bytes());
        bytes[offset_of!(Vault, open_interest_short)
            ..offset_of!(Vault, open_interest_short) + size_of::<u64>()]
            .copy_from_slice(&(22u64).to_le_bytes());
        bytes[offset_of!(Vault, bump)..offset_of!(Vault, bump) + size_of::<u8>()]
            .copy_from_slice(&(23u8).to_le_bytes());
        layouts.insert("Vault".into(), json!({"size":size_of::<Vault>(),"fields":fields,"fixture":bytes,"discriminator":Vault::DISCRIMINATOR,"version":Vault::LAYOUT_VERSION}));
    }
    {
        let mut fields = Map::new();
        fields.insert(
            "instrumentId".into(),
            json!([offset_of!(OrderBook, instrument_id), "u16"]),
        );
        fields.insert(
            "bestBid".into(),
            json!([offset_of!(OrderBook, best_bid), "i64"]),
        );
        fields.insert(
            "bestAsk".into(),
            json!([offset_of!(OrderBook, best_ask), "i64"]),
        );
        fields.insert(
            "bidCount".into(),
            json!([offset_of!(OrderBook, bid_count), "u32"]),
        );
        fields.insert(
            "askCount".into(),
            json!([offset_of!(OrderBook, ask_count), "u32"]),
        );
        fields.insert(
            "nextOrderId".into(),
            json!([offset_of!(OrderBook, next_order_id), "u64"]),
        );
        fields.insert(
            "lastUpdateSlot".into(),
            json!([offset_of!(OrderBook, last_update_slot), "u64"]),
        );
        fields.insert(
            "bids".into(),
            json!([offset_of!(OrderBook, bids), "[BookLevel; 64]"]),
        );
        fields.insert(
            "asks".into(),
            json!([offset_of!(OrderBook, asks), "[BookLevel; 64]"]),
        );
        let mut bytes = vec![0u8; size_of::<OrderBook>()];
        bytes[0] = OrderBook::DISCRIMINATOR;
        bytes[1] = OrderBook::LAYOUT_VERSION;
        bytes[offset_of!(OrderBook, instrument_id)
            ..offset_of!(OrderBook, instrument_id) + size_of::<u16>()]
            .copy_from_slice(&(18u16).to_le_bytes());
        bytes[offset_of!(OrderBook, best_bid)..offset_of!(OrderBook, best_bid) + size_of::<i64>()]
            .copy_from_slice(&(19i64).to_le_bytes());
        bytes[offset_of!(OrderBook, best_ask)..offset_of!(OrderBook, best_ask) + size_of::<i64>()]
            .copy_from_slice(&(20i64).to_le_bytes());
        bytes
            [offset_of!(OrderBook, bid_count)..offset_of!(OrderBook, bid_count) + size_of::<u32>()]
            .copy_from_slice(&(21u32).to_le_bytes());
        bytes
            [offset_of!(OrderBook, ask_count)..offset_of!(OrderBook, ask_count) + size_of::<u32>()]
            .copy_from_slice(&(22u32).to_le_bytes());
        bytes[offset_of!(OrderBook, next_order_id)
            ..offset_of!(OrderBook, next_order_id) + size_of::<u64>()]
            .copy_from_slice(&(23u64).to_le_bytes());
        bytes[offset_of!(OrderBook, last_update_slot)
            ..offset_of!(OrderBook, last_update_slot) + size_of::<u64>()]
            .copy_from_slice(&(24u64).to_le_bytes());
        layouts.insert("OrderBook".into(), json!({"size":size_of::<OrderBook>(),"fields":fields,"fixture":bytes,"discriminator":OrderBook::DISCRIMINATOR,"version":OrderBook::LAYOUT_VERSION}));
    }
    {
        let mut fields = Map::new();
        fields.insert("price".into(), json!([offset_of!(BookLevel, price), "i64"]));
        fields.insert(
            "totalQty".into(),
            json!([offset_of!(BookLevel, total_qty), "u64"]),
        );
        fields.insert(
            "orderCount".into(),
            json!([offset_of!(BookLevel, order_count), "u16"]),
        );
        fields.insert(
            "firstOrderOffset".into(),
            json!([offset_of!(BookLevel, first_order_offset), "u32"]),
        );
        let mut bytes = vec![0u8; size_of::<BookLevel>()];
        bytes[offset_of!(BookLevel, price)..offset_of!(BookLevel, price) + size_of::<i64>()]
            .copy_from_slice(&(17i64).to_le_bytes());
        bytes
            [offset_of!(BookLevel, total_qty)..offset_of!(BookLevel, total_qty) + size_of::<u64>()]
            .copy_from_slice(&(18u64).to_le_bytes());
        bytes[offset_of!(BookLevel, order_count)
            ..offset_of!(BookLevel, order_count) + size_of::<u16>()]
            .copy_from_slice(&(19u16).to_le_bytes());
        bytes[offset_of!(BookLevel, first_order_offset)
            ..offset_of!(BookLevel, first_order_offset) + size_of::<u32>()]
            .copy_from_slice(&(20u32).to_le_bytes());
        layouts.insert("BookLevel".into(), json!({"size":size_of::<BookLevel>(),"fields":fields,"fixture":bytes,"discriminator":null,"version":null}));
    }
    {
        let mut fields = Map::new();
        fields.insert(
            "orderId".into(),
            json!([offset_of!(RestingOrder, order_id), "u64"]),
        );
        fields.insert(
            "user".into(),
            json!([offset_of!(RestingOrder, user), "pubkey"]),
        );
        fields.insert("side".into(), json!([offset_of!(RestingOrder, side), "u8"]));
        fields.insert(
            "price".into(),
            json!([offset_of!(RestingOrder, price), "i64"]),
        );
        fields.insert("qty".into(), json!([offset_of!(RestingOrder, qty), "u64"]));
        fields.insert(
            "filledQty".into(),
            json!([offset_of!(RestingOrder, filled_qty), "u64"]),
        );
        fields.insert(
            "instrumentId".into(),
            json!([offset_of!(RestingOrder, instrument_id), "u16"]),
        );
        fields.insert(
            "reduceOnly".into(),
            json!([offset_of!(RestingOrder, reduce_only), "bool"]),
        );
        fields.insert(
            "batchPlaced".into(),
            json!([offset_of!(RestingOrder, batch_placed), "u64"]),
        );
        fields.insert(
            "nextOrderOffset".into(),
            json!([offset_of!(RestingOrder, next_order_offset), "u32"]),
        );
        fields.insert(
            "isMaker".into(),
            json!([offset_of!(RestingOrder, is_maker), "bool"]),
        );
        let mut bytes = vec![0u8; size_of::<RestingOrder>()];
        bytes[offset_of!(RestingOrder, order_id)
            ..offset_of!(RestingOrder, order_id) + size_of::<u64>()]
            .copy_from_slice(&(17u64).to_le_bytes());
        bytes[offset_of!(RestingOrder, user)..offset_of!(RestingOrder, user) + 32].fill(18);
        bytes[offset_of!(RestingOrder, price)..offset_of!(RestingOrder, price) + size_of::<i64>()]
            .copy_from_slice(&(20i64).to_le_bytes());
        bytes[offset_of!(RestingOrder, qty)..offset_of!(RestingOrder, qty) + size_of::<u64>()]
            .copy_from_slice(&(21u64).to_le_bytes());
        bytes[offset_of!(RestingOrder, filled_qty)
            ..offset_of!(RestingOrder, filled_qty) + size_of::<u64>()]
            .copy_from_slice(&(22u64).to_le_bytes());
        bytes[offset_of!(RestingOrder, instrument_id)
            ..offset_of!(RestingOrder, instrument_id) + size_of::<u16>()]
            .copy_from_slice(&(23u16).to_le_bytes());
        bytes[offset_of!(RestingOrder, reduce_only)] = 1;
        bytes[offset_of!(RestingOrder, batch_placed)
            ..offset_of!(RestingOrder, batch_placed) + size_of::<u64>()]
            .copy_from_slice(&(25u64).to_le_bytes());
        bytes[offset_of!(RestingOrder, next_order_offset)
            ..offset_of!(RestingOrder, next_order_offset) + size_of::<u32>()]
            .copy_from_slice(&(26u32).to_le_bytes());
        bytes[offset_of!(RestingOrder, is_maker)] = 1;
        layouts.insert("RestingOrder".into(), json!({"size":size_of::<RestingOrder>(),"fields":fields,"fixture":bytes,"discriminator":null,"version":null}));
    }
    {
        let mut fields = Map::new();
        fields.insert("bump".into(), json!([offset_of!(PriceOracle, bump), "u8"]));
        fields.insert(
            "isActive".into(),
            json!([offset_of!(PriceOracle, is_active), "bool"]),
        );
        fields.insert(
            "authority".into(),
            json!([offset_of!(PriceOracle, authority), "pubkey"]),
        );
        fields.insert(
            "instrument".into(),
            json!([offset_of!(PriceOracle, instrument), "pubkey"]),
        );
        fields.insert(
            "price".into(),
            json!([offset_of!(PriceOracle, price), "i64"]),
        );
        fields.insert(
            "timestamp".into(),
            json!([offset_of!(PriceOracle, timestamp), "i64"]),
        );
        fields.insert(
            "confidence".into(),
            json!([offset_of!(PriceOracle, confidence), "i64"]),
        );
        let mut bytes = vec![0u8; size_of::<PriceOracle>()];
        bytes[0] = PriceOracle::DISCRIMINATOR;
        bytes[1] = PriceOracle::LAYOUT_VERSION;
        bytes[offset_of!(PriceOracle, bump)..offset_of!(PriceOracle, bump) + size_of::<u8>()]
            .copy_from_slice(&(19u8).to_le_bytes());
        bytes[offset_of!(PriceOracle, is_active)] = 1;
        bytes[offset_of!(PriceOracle, authority)..offset_of!(PriceOracle, authority) + 32].fill(22);
        bytes[offset_of!(PriceOracle, instrument)..offset_of!(PriceOracle, instrument) + 32]
            .fill(23);
        bytes[offset_of!(PriceOracle, price)..offset_of!(PriceOracle, price) + size_of::<i64>()]
            .copy_from_slice(&(24i64).to_le_bytes());
        bytes[offset_of!(PriceOracle, timestamp)
            ..offset_of!(PriceOracle, timestamp) + size_of::<i64>()]
            .copy_from_slice(&(25i64).to_le_bytes());
        bytes[offset_of!(PriceOracle, confidence)
            ..offset_of!(PriceOracle, confidence) + size_of::<i64>()]
            .copy_from_slice(&(26i64).to_le_bytes());
        layouts.insert("PriceOracle".into(), json!({"size":size_of::<PriceOracle>(),"fields":fields,"fixture":bytes,"discriminator":PriceOracle::DISCRIMINATOR,"version":PriceOracle::LAYOUT_VERSION}));
    }
    {
        let mut fields = Map::new();
        fields.insert(
            "seqno".into(),
            json!([offset_of!(SlabHeader, seqno), "u32"]),
        );
        fields.insert(
            "programId".into(),
            json!([offset_of!(SlabHeader, program_id), "pubkey"]),
        );
        fields.insert(
            "lpOwner".into(),
            json!([offset_of!(SlabHeader, lp_owner), "pubkey"]),
        );
        fields.insert(
            "routerId".into(),
            json!([offset_of!(SlabHeader, router_id), "pubkey"]),
        );
        fields.insert(
            "instrument".into(),
            json!([offset_of!(SlabHeader, instrument), "pubkey"]),
        );
        fields.insert(
            "contractSize".into(),
            json!([offset_of!(SlabHeader, contract_size), "i64"]),
        );
        fields.insert("tick".into(), json!([offset_of!(SlabHeader, tick), "i64"]));
        fields.insert("lot".into(), json!([offset_of!(SlabHeader, lot), "i64"]));
        fields.insert(
            "markPx".into(),
            json!([offset_of!(SlabHeader, mark_px), "i64"]),
        );
        fields.insert(
            "takerFeeBps".into(),
            json!([offset_of!(SlabHeader, taker_fee_bps), "i64"]),
        );
        fields.insert(
            "offBook".into(),
            json!([offset_of!(SlabHeader, off_book), "u32"]),
        );
        fields.insert(
            "offQuoteCache".into(),
            json!([offset_of!(SlabHeader, off_quote_cache), "u32"]),
        );
        fields.insert(
            "offReceiptArea".into(),
            json!([offset_of!(SlabHeader, off_receipt_area), "u32"]),
        );
        fields.insert("bump".into(), json!([offset_of!(SlabHeader, bump), "u8"]));
        let mut bytes = vec![0u8; size_of::<SlabHeader>()];
        bytes[0] = SlabHeader::DISCRIMINATOR;
        bytes[1] = SlabHeader::LAYOUT_VERSION;
        bytes[offset_of!(SlabHeader, seqno)..offset_of!(SlabHeader, seqno) + size_of::<u32>()]
            .copy_from_slice(&(18u32).to_le_bytes());
        bytes[offset_of!(SlabHeader, program_id)..offset_of!(SlabHeader, program_id) + 32].fill(19);
        bytes[offset_of!(SlabHeader, lp_owner)..offset_of!(SlabHeader, lp_owner) + 32].fill(20);
        bytes[offset_of!(SlabHeader, router_id)..offset_of!(SlabHeader, router_id) + 32].fill(21);
        bytes[offset_of!(SlabHeader, instrument)..offset_of!(SlabHeader, instrument) + 32].fill(22);
        bytes[offset_of!(SlabHeader, contract_size)
            ..offset_of!(SlabHeader, contract_size) + size_of::<i64>()]
            .copy_from_slice(&(23i64).to_le_bytes());
        bytes[offset_of!(SlabHeader, tick)..offset_of!(SlabHeader, tick) + size_of::<i64>()]
            .copy_from_slice(&(24i64).to_le_bytes());
        bytes[offset_of!(SlabHeader, lot)..offset_of!(SlabHeader, lot) + size_of::<i64>()]
            .copy_from_slice(&(25i64).to_le_bytes());
        bytes[offset_of!(SlabHeader, mark_px)..offset_of!(SlabHeader, mark_px) + size_of::<i64>()]
            .copy_from_slice(&(26i64).to_le_bytes());
        bytes[offset_of!(SlabHeader, taker_fee_bps)
            ..offset_of!(SlabHeader, taker_fee_bps) + size_of::<i64>()]
            .copy_from_slice(&(27i64).to_le_bytes());
        bytes
            [offset_of!(SlabHeader, off_book)..offset_of!(SlabHeader, off_book) + size_of::<u32>()]
            .copy_from_slice(&(28u32).to_le_bytes());
        bytes[offset_of!(SlabHeader, off_quote_cache)
            ..offset_of!(SlabHeader, off_quote_cache) + size_of::<u32>()]
            .copy_from_slice(&(29u32).to_le_bytes());
        bytes[offset_of!(SlabHeader, off_receipt_area)
            ..offset_of!(SlabHeader, off_receipt_area) + size_of::<u32>()]
            .copy_from_slice(&(30u32).to_le_bytes());
        bytes[offset_of!(SlabHeader, bump)..offset_of!(SlabHeader, bump) + size_of::<u8>()]
            .copy_from_slice(&(31u8).to_le_bytes());
        layouts.insert("SlabHeader".into(), json!({"size":size_of::<SlabHeader>(),"fields":fields,"fixture":bytes,"discriminator":SlabHeader::DISCRIMINATOR,"version":SlabHeader::LAYOUT_VERSION}));
    }
    for (parent, field, child) in [
        ("Portfolio", "positions", "Position"),
        ("Portfolio", "orders", "OrderReservation"),
        ("Commitment", "revealed", "RevealedOrder"),
        ("OrderBook", "bids", "BookLevel"),
        ("OrderBook", "asks", "BookLevel"),
    ] {
        let source = layouts[child]["fixture"].as_array().unwrap().clone();
        let offset = layouts[parent]["fields"][field][0].as_u64().unwrap() as usize;
        let target = layouts.get_mut(parent).unwrap()["fixture"]
            .as_array_mut()
            .unwrap();
        target[offset..offset + source.len()].clone_from_slice(&source);
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&Value::Object(layouts)).unwrap()
    );
}
