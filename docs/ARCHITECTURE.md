# Architecture — mgk Perps DEX

**Dual Flow Batch Auction (DFBA) on Solana · Pinocchio / no_std · sequencer-free · MEV-mitigated**

Repository: https://github.com/mangekyou-labs/mgk-solana
Devnet programs: perps-core, perps-matcher, oracle (all executable — see [Verify](#how-to-verify))
Design source of truth: `docs/ai/design/feature-onchain-perps-dex.md`

> **Historical note:** Milestones M1–M8 shipped a short-batch commit-reveal CLOB (Fisher-Yates shuffle + structural priority queues). That model is **retired**. Active matching is pure DFBA (M9.0–M9.10, deployed on devnet 2026-08-24). Commit-reveal records remain in `docs/ai/planning/README.md` (historical M1–M8) and `docs/ai/testing/feature-mgk-onchain-perps-dex.md`. Do not implement new commit-reveal work from those files.

---

## Introduction

### High-Level Overview

Perpetual futures are the largest category in DeFi by trading volume. On-chain perps today force a trade-off: fast but trust an off-chain sequencer (Drift, Mango, Zeta), or permissionless but AMM-capped with no resting depth (Jupiter Perps, Perpetual Protocol). **mgk takes a third path** — a fully on-chain Dual Flow Batch Auction with no sequencer, no AMM curve, and persistent GTC resting depth.

Every order, fill, liquidation, and settlement is verifiable on-chain. Orders are posted openly during a Collecting window. When the window closes, a permissionless crank runs **two independent uniform-price auctions** (bid auction: maker-buy × taker-sell; ask auction: maker-sell × taker-buy). Clearing maximizes matched volume; fills in each auction share one price; makers never match makers and takers never match takers. Within-batch arrival order has no priority.

**Mission:** Sequencer-free, on-chain execution as a reusable primitive for Solana DeFi. Prices emerge from two-sided DFBA flow between competing participants, not from an external matching sequencer.

**Initial launch parameters:**

- Single collateral: SOL
- Three planned markets: SOL-PERP, BTC-PERP, ETH-PERP
- Cross-margin portfolio per wallet
- 5–20x leverage range with per-instrument caps
- Batch windows: live working-devnet `t_min=2`, `t_max=150` slots, `n_min=1` (latency SLOs still unmeasured; mainnet bar)

**Competitive advantages:**

- **No sequencer trust assumption:** all matching, settlement, and liquidation execute on-chain via Pinocchio BPF programs
- **MEV-mitigated by market structure:** batching + uniform dual clears eliminate within-batch time priority; order contents are visible when posted
- **Persistent GTC depth:** resting maker orders survive across batches — capital accumulates, makers can receive price improvement
- **Pinocchio, not Anchor:** `no_std`, zero-allocation, single-byte discriminators, checked arithmetic throughout — no IDL overhead, minimal SBF binary footprint
- **Sequencer-free execution pattern** is transferable as a primitive to other Solana venues (options, structured products)

---

## High-Level Architecture

The protocol consists of four interconnected systems:

```mermaid
graph TD
    subgraph Users
        TRADER[Trader]
    end

    subgraph "On-Chain Programs"
        CORE[Core Program<br/>Portfolio Mgmt<br/>Batch Lifecycle<br/>Custody<br/>Funding Accrual<br/>Mark Price]
        MATCH[Matching Engine<br/>DFBA Dual Auction<br/>Self-Trade Prevention<br/>Resting Book]
        FALLBACK[Fallback Oracle<br/>Admin-pushed price<br/>Auto-activate on staleness]
    end

    subgraph External
        PYTH[Index venues<br/>Multi-venue quorum<br/>BTC, ETH, SOL index]
    end

    subgraph "Permissionless Keepers"
        CRANK[Batch Crank<br/>Close Collecting, Clear, Settle]
        LIQ[Liquidator<br/>Hedge-preserving optimizer<br/>ADL as last resort]
        ORACLE_KEEPER[Oracle publisher<br/>Quorum index into PriceOracle]
    end

    subgraph "Safety Stack"
        OPTIMIZER[Liquidation Optimizer<br/>Hedge-preserving reduction<br/>Impact-ratio ranking<br/>Inventory tiebreaker]
        INSURANCE[Insurance Fund<br/>Fee-accrued<br/>Base/quote inventory<br/>Absorbs bad debt]
        ADL[Auto-Deleveraging<br/>Deleverage profitable counterparties<br/>Pro-rata by score]
    end

    TRADER -->|post_order / cancel / modify| CORE
    TRADER -->|deposit / withdraw| CORE
    CORE -->|"DfbaClear CPI (dual uniform auction)"| MATCH
    MATCH -->|"bid/ask clears + fills + resting book"| CORE
    CORE -->|update_positions + accrue_funding| CORE
    CORE -->|read bound PriceOracle| FALLBACK
    ORACLE_KEEPER -->|quorum publish| FALLBACK
    ORACLE_KEEPER -->|venues| PYTH
    CRANK -->|close_collecting + clear_batch + settle_batch| CORE
    LIQ -->|liquidate_user| OPTIMIZER
    OPTIMIZER -->|market sweep against book| MATCH
    OPTIMIZER -->|shortfall?| INSURANCE
    INSURANCE -->|insufficient?| ADL
```

**Key architectural principle:** The Core Program is the **single custody authority**. All SOL collateral lives in Core-controlled vaults/PDA portfolios. The Matching Engine holds the order book state but never holds funds. This follows the Solana authority-isolation pattern: only one program can move user funds, reducing the blast radius of any bug in the matching logic.

**Fair ordering principle:** DFBA removes within-batch time priority. Competition is on price and size; each auction clears at one uniform price; makers only match takers. Immediate cancel/modify of resting orders is available outside the auction. The safety-stack design follows [Bulk.Trade](https://docs.bulk.trade) (optimizer → insurance → ADL) without Bulk.Trade's off-chain admission quorum.

**Safety stack principle:** liquidation optimizer (hedge-preserving, impact-ratio ranked) → insurance fund → auto-deleveraging (ADL). The optimizer selectively reduces positions that contribute most to portfolio risk while preserving hedges. ADL deleverages profitable counterparties as a last resort.

### Why Not FIFO / Continuous CLOB

FIFO and continuous books create time-based advantages for colocated participants. DFBA removes within-batch time priority:

| Continuous/FIFO Weakness | DFBA Fix |
|---|---|
| Time advantage for colocated/fast participants | Uniform dual auction; arrival order does not rank fills |
| Sniping resting makers | Makers only match takers; each side clears at one price |
| Hidden vs visible intents | Posts are open; fairness is structural, not sealed-hash |
| Off-chain sequencer for MEV | All clears execute in Core→Matcher CPI |

---

## Component Responsibilities

### Smart Contracts Layer (Pinocchio / Rust / no_std)

- Stores all position, batch, commitment, and order-book state in PDAs
- Executes fund transfers with atomic guarantees inside Core
- Enforces risk parameters and liquidation logic
- Calculates PnL, funding rates, and mark prices
- Manages resting order lifecycle (place / cancel / modify)
- Integrates Pyth pull oracle + admin fallback

### Backend Services (Node.js — see `mgk-frontend/apps/indexer/`)

- Indexes on-chain events (log subscriptions) into SQLite
- REST API for frontend queries (read-only; no keeper inside the indexer process)
- Permissionless keepers as standalone workers: batch crank, liquidator, oracle publisher

### Oracle Integration

- **Primary:** Pyth Network pull-model price feeds (BTC/USD, ETH/USD, SOL/USD) read directly by Core via `pyth-solana-receiver-sdk`
- **Fallback:** minimal on-chain admin-pushed price feed (auto-activates on Pyth staleness)

### Frontend Application (React / Next.js 15 / Tailwind)

- TradingView chart, order book, order form, position panel
- Wallet connect (Phantom, Solflare)
- SDK package ships instruction encoders, PDA derivation, and state decoders (see `mgk-frontend/packages/sdk/`)

---

## Smart Contracts

### Program Architecture

Three on-chain programs + one shared library crate, all Pinocchio (`pinocchio::entrypoint!()`), no Anchor:

| Program | Role | Canonical devnet ID (2026-08-24) |
|---|---|---|
| `mgk-perps-core` | Portfolio mgmt, batch lifecycle, custody, mark price | `C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx` |
| `mgk-perps-matcher` | DFBA dual auction, resting book | `7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC` |
| `mgk-oracle` | Fallback / bound PriceOracle feed | `CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ` |
| `mgk-common` | Shared account validation, errors, math (library crate) | — |

### Program Descriptions

**mgk-perps-core** is the sole custody authority and batch lifecycle coordinator. It owns portfolio state, the registry, the collateral vault, and mark-price / funding writes. The live batch lifecycle is Collecting (alias Committing) → Clearing → Settled. Core issues one-way CPI to the matcher during `PostOrder`, `ClearBatch`, cancel/modify, and settle book reads. Fund custody stays in Core.

Key instructions (single-byte discriminator, not Anchor's 8-byte SHA256 digest). Numeric values are frozen; `CommitOrder` / `RevealOrder` remain in the enum but return `InvalidInstruction`.

| Disc | Instruction | Auth | Description |
|---|---|---|---|
| `0x00` | `Initialize` | Governance | Bootstrap registry |
| `0x01` | `InitPortfolio` | User signer | Initialize per-user cross-margin account |
| `0x02` | `Deposit` | User signer | Deposit SOL into the canonical vault PDA |
| `0x03` | `Withdraw` | User signer | Withdraw SOL with margin check |
| `0x04` | `CommitOrder` | — | Retired (returns `InvalidInstruction`) |
| `0x05` | `RevealOrder` | — | Retired (returns `InvalidInstruction`) |
| `0x06` | `CloseCommitting` | Permissionless | Close Collecting window → Clearing |
| `0x07` | `ClearBatch` | Permissionless (crank) | CPI matcher `DfbaClear`; write dual clears + `mark_valid` |
| `0x08` | `SettleBatch` | Permissionless | Positions, funding (D7), next batch |
| `0x09` | `LiquidateUser` | Permissionless (keeper) | Hedge-preserving optimizer → insurance → ADL; gated on `mark_valid` |
| `0x0A` | `AddInstrument` | Governance | Register new perp market |
| `0x0B` | `CancelRestingOrder` | User signer | Cancel resting GTC order |
| `0x0C` | `ModifyRestingOrder` | User signer | Modify resting order qty |
| `0x0D` | `CancelAllRestingOrders` | User signer | Cancel all user resting orders |
| `0x0E` | `SetPauseFlags` | Governance | Emergency pause flags |
| `0x0F` | `InitVault` | Governance | Initialize canonical vault PDA |
| `0x10` | `CreateBatch` | Keeper | Bootstrap first Collecting batch |
| `0x11` | `SetBatchCounter` | Governance | Reset `batch_id_counter` |
| `0x12` | `CreatePortfolio` | User signer | Create + init portfolio PDA |
| `0x13` | `InitPortfolioForUser` | Wallet (2-acct) or keeper (3-acct) | Create portfolio PDA; skip-reinit; no wipe |
| `0x14` | `PostOrder` | User signer | Open DFBA post with maker/taker flag |
| `0x15` | `SetBatchParams` | Governance | `t_min` / `t_max` / `n_min` |
| `0x16` | `SetInstrumentFees` | Governance | Maker/taker bps |
| `0x17` | `SetInstrumentOracle` | Governance | Bind PriceOracle account |
| `0x18` | `SetFundingParams` | Governance | D7 coefficient / interval / cap |

**mgk-perps-matcher** is the matching engine. Live clearing is `DfbaClear` (disc 5). Legacy CLOB/shuffle instructions remain for ABI stability but are not the DFBA path. Matcher mutations other than `InitializeBook` require CPI (stack-height gate). Full Core-caller authentication is a blocking design/migration (Instructions sysvar).

| Disc | Instruction | Description |
|---|---|---|
| `0x00` | `ComputeClearing` | Legacy host/CLOB helper (not DFBA) |
| `0x01` | `CancelResting` | Cancel resting order (CPI) |
| `0x02` | `ModifyResting` | Modify resting order qty (CPI) |
| `0x03` | `ClearAndMatch` | Legacy CLOB match |
| `0x04` | `CancelAll` | Cancel-all for an account (CPI) |
| `0x05` | `DfbaClear` | Dual uniform-price auction |
| `0x06` | `PlaceResting` | Place GTC with `is_maker` (CPI from Core PostOrder) |
| `0x07` | `InitializeBook` | Keeper-direct book setup |

**Critical rule:** the matcher never calls Core, and never holds funds. Book state lives in matcher-owned accounts. GTC orders persist across batches.

**mgk-oracle** is the fallback price feed. Same `PriceFeed` struct used by the primary Pyth path. Auto-activates when Pyth is stale, frozen, or has excessive confidence intervals. Admin can manually activate/deactivate.

| Disc | Instruction | Auth | Description |
|---|---|---|---|
| `0x00` | `Initialize` | Admin | Bootstrap instrument + initial price |
| `0x01` | `UpdatePrice` | Admin | Push new price + confidence |
| `0x02` | `SetAuthority` | Admin | Rotate admin key |
| `0x03` | `Activate` | Admin | Manually activate fallback |
| `0x04` | `Deactivate` | Admin | Manually deactivate fallback |

### Why This Architecture

- **Security:** fund custody (Core) is isolated from matching logic (Matcher). A bug in the matcher cannot directly move user funds.
- **Upgradability:** matching logic can be upgraded without touching the custody path.
- **Auditing:** smaller, focused programs are easier to audit thoroughly. ~5,900 LOC matcher is the largest; Core is comparable.
- **Risk isolation:** each safety-stack layer (optimizer → insurance → ADL) is independently reachable, so a partial failure doesn't cascade.
- **CPI direction is one-way:** Core → Matcher only. Matcher → Core is forbidden. Pyth is read-only (no CPI).

### CPI Relationships

```
Core  ──CPI──► Matching Engine  (PostOrder PlaceResting; ClearBatch DfbaClear; cancel/modify)
Core  ──READ──► Bound PriceOracle (funding index + liquidation; skip if stale / !mark_valid)
Liquidator ──CALL──► Core        (liquidate_user → optimizer → market sweep)
Crank      ──CALL──► Core        (close_collecting / clear_batch / settle_batch)
Oracle pub ──CALL──► Oracle      (quorum UpdatePrice)
```

### Data Storage Overview

All accounts are PDAs (Program Derived Addresses) with deterministic seeds. Sizes are rent-exempt class.

| PDA | Owning program | Seeds | Lifecycle | Write auth |
|---|---|---|---|---|
| `Registry` | core | `["registry"]` | Persistent (singleton) | Governance |
| `Instrument` | core | `["instrument", instrument_id]` | Persistent | Governance |
| `Portfolio` | core | `["portfolio", user_pubkey]` | Persistent | User / keeper (liquidation only) |
| `Vault` | core | `["vault"]` | Persistent (singleton) | Core (custody) |
| `Batch` | core | `["batch", batch_id]` | Per-batch (sequential) | Core |
| `Commitment` | core | `["commitment", batch_id, user, nonce]` | Per-batch | User (commit/reveal) → Core (slash) |
| `RevealedOrder` | core | (transient, in Batch CPI buffer) | Per-batch | Core |
| `OrderBook` | matcher | `["book", instrument_id]` | Persistent across batches | Matcher (via Core CPI) |
| `RestingOrder` | matcher | (in OrderBook BSS scratch) | Persistent until cancelled | Matcher |
| `FallbackPrice` | oracle | `["fallback", instrument_id]` | Persistent | Admin |
| `FlowQualityScore` | core | `["flow_quality", address, instrument_id]` | Persistent, rolling 100-batch window | Core (settle) |
| `PauseFlags` | core | (in Registry) | Persistent | Governance |

**Matcher BSS scratch buffers:** the matcher writes link-section scratch buffers in `.data.S` so order book mutations stay within the 4 kB BPF stack frame. This is a Solana-specific workaround for stack-overflow errors that Anchor-style allocations would hit. See `programs/perps-matcher/src/state/clob.rs` and `book.rs`.

### Order Types

| Type | Behavior |
|---|---|
| `Limit(GTC)` | Rests on book if not immediately fillable. Persistent across batches. |
| `Limit(IOC)` | Fills what's available; remainder cancelled. Never rests. |
| `Limit(ALO)` | Add-Liquidity-Only. Rejected (`rejectedCrossing`) if it would take liquidity. Otherwise rests. |
| `Market` | Walks the book until filled or book exhausted. Risk callback per fill. |
| `Cancel` | Cancel one resting order by ID. Structurally prioritized before all order types. |
| `CancelAll` | Cancel all resting orders for the user. Structurally prioritized. |

---

## Batch Lifecycle

A trading **batch** is the fundamental clearing epoch. The CLOB persists across batches — resting orders survive between clearing cycles.

```
                     close_committing              clear_batch                         settle_batch
                     records close_slot            1. Fisher-Yates shuffle
                          |                       2. Priority queue separation
                          |                       3. CLOB match: cancels, ALO, regular
                          |                       4. Resting orders stay on book
   ┌──────────────┐  ▼  ┌──────────────┐  ▼  ┌──────────────┐  ▼  ┌──────────────┐
   │  COMMITTING  │──►│  REVEALING  │──►│   CLEARING  │──►│   SETTLED   │
   │ Users submit  │    │ Users reveal │    │ Shuffle +   │    │ Positions    │
   │ hashed orders │    │ order params │    │ priority    │    │ updated.     │
   │ + deposits    │    │ + salts      │    │ queues +    │    │ Deposits back │
   │ + cancels     │    │ + order type │    │ CLOB match  │    │ Funding       │
   └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

### Phase 1: Committing

Users submit `hash(order_type, side, price, qty, salt, user_pubkey, batch_id)` to Core. A commitment deposit is locked, dynamic and risk-based: `base_deposit * volatility_multiplier[instrument]`. Cancel commitments reference a resting order ID and need no deposit.

Phase closes when dynamic criteria are met: `N_commitments >= N_min AND slot_age >= T_min` OR `slot_age >= T_max`. Any permissionless crank can call `CloseCommitting` once criteria are satisfied.

### Phase 2: Revealing

Users reveal `order_type, side, price, qty, salt, reduce_only`. Core verifies the hash matches the stored commitment. Reveal deadline is `T_reveal` slots after the commit phase closed. **Users who do not reveal are fully slashed** — the entire commitment deposit is credited to the insurance fund, and the order is excluded from the batch.

**Pre-signed reveal relayer (short-batch mode):** the user signs `CommitOrder` and `RevealOrder` in one wallet action, hands the pre-signed reveal transaction to a permissionless relayer bot, and the relayer submits the reveal within 1 slot of commit confirmation. This eliminates slash risk from tight reveal windows when batches close in ~2–4s.

### Phase 3: Clearing

1. **Shuffle** — Fisher-Yates of all revealed orders, seeded by `close_slot`. Randomizes order within the batch; submission timing becomes irrelevant.
2. **Priority queue separation** — cancels execute first; post-only/ALO second; regular orders third.
3. **CLOB matching** — within each queue, process orders in shuffled order:
   - Aggressive orders walk the book; each fill at the resting (maker) order's limit price.
   - Risk callback after every fill: if the resulting position would breach margin, cancel the remainder.
   - Passive orders rest on the book as GTC.
   - ALO orders that would cross are rejected (`rejectedCrossing`); otherwise they rest.
   - IOC orders fill what's available; remainder cancelled.
4. **Resting orders persist** — unmatched GTC orders remain on the book for future batches.

### Phase 4: Settled

- Commitment deposits returned to filled users (net of trading fees)
- Maker rebates applied (maker_fee_bps is typically negative — rebate)
- Slashed deposits from non-revealers credited to insurance fund
- Funding accrual: mark price computed per instrument; `cum_funding` updated; funding payments applied to portfolios with positions
- Next batch opens; book state carries over

### Dynamic Batch Cadence

| Parameter | Purpose | Long-batch default | Short-batch target |
|---|---|---|---|
| `N_min` | Min commitments for early close | 5 | 5 |
| `T_min` | Min slot age before early close | 10 | 2 (~0.8s) |
| `T_max` | Max slot age before forced close | 150 | 15 (~6s) |
| `T_reveal` | Reveal phase duration | 25 | 3 (~1.2s) |

Short-batch params are governance-configurable — **no on-chain program changes required** for the latency reduction.

---

## Oracle Integration

**Design principle:** trading prices emerge from two-sided orderbook flow. The oracle is a reference anchor for funding rate, mark price stabilization, and liquidation risk — **never** the execution price.

### Price Sources (defense in depth)

| Layer | Source | Role | Trigger |
|---|---|---|---|
| 1 (primary) | Pyth Network pull oracle | Index price for funding, mark price component, liquidation marking | Read inline when Core needs a price |
| 2 (fallback) | On-chain admin-pushed feed | Conservative fallback if Pyth stale/frozen | Auto-activate on staleness OR admin |

### Price Validation

- Pyth freshness: per-instrument `max_staleness_slots` (default ~25 slots / ~10s)
- Confidence interval check: reject prices with confidence > threshold
- Trading-status check: reject if Pyth flags the feed as halted
- Conservative pricing for liquidation: use unfavorable price (longs liquidated at low bid; shorts at high ask)

---

## Core Mechanisms

### Mark Price

The mark price reflects executable prices, not just top-of-book. The primary input is the **depth-weighted book mid**; the oracle is a fallback when the book is stale or thin.

```
P_bid  = sweep(sell, reference_notional)   // worst price to sell reference_notional
P_ask  = sweep(buy,  reference_notional)   // worst price to buy  reference_notional
P_book = (P_bid + P_ask) / 2
```

`reference_notional` is a configurable per-instrument amount (e.g., $10K). Accounts for actual liquidity at meaningful size, not just top-of-book.

When the book is stale (no updates for `book_staleness_threshold` slots) or has insufficient depth, the mark price smoothly transitions to the oracle:

```
age = (current_slot - book_last_update_slot) / decay_window_slots

if age >= 1.0:
    bias = tanh((age - 0.5) * 10) * 0.5 + 0.5    // sigmoid toward oracle
    P_mark = (1 - bias) * P_book + bias * P_oracle
else:
    P_mark = P_book
```

Smooth degradation, not a binary switch — prevents liquidation cascades from a stale-price spike.

### Funding Rate

Premium is computed from depth-weighted bid/ask vs oracle:

```
P_bid      = sweep(sell, sample_notional)
P_ask      = sweep(buy,  sample_notional)
P_oracle   = oracle_index_price
delta      = max(P_bid - P_oracle, 0) - max(P_oracle - P_ask, 0)
premium    = delta / P_oracle

F = clamp(SMA(premium_samples) + clamp(interest_rate - SMA(premium_samples), -deviation_cap, deviation_cap),
         -funding_cap, funding_cap)
```

| Param | Default |
|---|---|
| `interest_rate` | 1 bps |
| `deviation_cap` | 5 bps |
| `funding_cap` | 50 bps |
| `sample_notional` | 10,000 USD |

**Accrual:** `cum_funding += funding_rate * funding_period`, applied during `settle_batch` — no separate keeper instruction required.

**Application:** `funding_payment = position.qty * (cum_funding_current - position.last_funding_checkpoint)`. Longs pay shorts when `F > 0` (mark > index); shorts pay longs when `F < 0`.

### Liquidation & Safety Stack

**Trigger:** `Equity < M_p AND Position PnL < 0` where `M_p` is portfolio maintenance margin.

**Step 1 — Cancel open orders:** all resting orders across every market are cancelled to prevent exposure increase during liquidation.

**Step 2 — Compute target:** `target = max(0, Equity * (1 - buffer))`; `gap = M_p - target`. Buffer = 10% safety margin.

**Step 3 — Selective reduction:** for each non-zero position, compute margin impact of reducing it. **Skip positions where closing would NOT reduce portfolio margin** (these are hedges). Rank remaining positions by:

```
IR = margin_reduction / estimated_market_impact
```

`estimated_market_impact` comes from order book depth at the reduction size. Highest IR is reduced first. **Inventory tiebreaker:** when two positions have the same IR, prefer the reduction that moves insurance fund inventory toward target balance (e.g., 50/50 base/quote). IR remains the primary ranking signal — inventory is a soft tiebreaker only.

Reduction fraction by urgency:

| Condition | Reduction fraction |
|---|---|
| `gap > 30%` of `M_p` | 25% of position |
| `gap > 10%` of `M_p` | 10% of position |
| `gap ≤ 10%` of `M_p` | 5% of position |

**Step 4 — Iterate:** apply best reduction, recompute `gap`, repeat. Up to 10 iterations. If optimizer cannot resolve — **full flat** of all positions.

**Step 5 — Execute via market sweep:** planned reductions become market orders against the book. Per-fill risk checks prevent the liquidating account's margin from going further negative.

### Insurance Fund

If liquidation produces a shortfall (losses exceed account collateral), the insurance fund absorbs the bad debt. **No liquidation fee is charged to traders** — the fund is the backstop, replenished by slashed commitment deposits and protocol fees.

The fund tracks its own base/quote inventory separately (`insurance_base_reserves` and `insurance_quote_reserves` in the `Vault` struct) so the liquidation optimizer can prefer rebalancing sweep directions. Without inventory tracking, repeated liquidations in one direction can leave the fund one-sided. The rebalancing tiebreaker keeps the fund diversified without manual intervention.

### Auto-Deleveraging (ADL)

ADL activates when (a) the insurance fund cannot cover the shortfall, OR (b) there is unfilled liquidation volume (insufficient book liquidity).

**Ranking:** profitable counterparties on the opposite side ranked by:

```
score = max(1, PnL)^w * leverage^(1-w)
```

`w` is a configurable bias parameter (default 0.5). Highest-PnL + highest-leverage counterparties are deleveraged first.

**Allocation:** `ADL_size_i = total_shortfall * (score_i / sum(scores))`, closed at the deleveraged trader's entry price.

### Full Safety Stack

```
Margin breach detected
  → Liquidation Optimizer (hedge-preserving, IR-ranked)
    → Market sweep against book
      → Shortfall?
        → No:  Done
        → Yes: Insurance Fund absorbs loss
          → Fund sufficient?
            → Yes: Done
            → No:  ADL — deleverage profitable counterparties
```

### Toxic-Taker Detection

The matcher maintains a per-address, per-instrument flow-quality score computed from historical PnL-to-protocol over a rolling window (default 100 batches):

```
score = sum(PnL_to_protocol[address, instrument] over last N batches) / N

where PnL_to_protocol = maker_rebates − taker_fees − funding_payments for all fills by this address
```

- `score > 0`: benign taker (net payer to protocol)
- `score ≤ 0`: toxic taker (net drainer)
- Threshold configurable via governance

**Matcher behavior:** spread multiplied by `max(1.0, 1.0 + |score|/threshold)` capped at max; alternatively top-of-book depth withheld (taker sees level 2).

**Crucially: the taker is never hard-rejected.** The effect is economic friction, not exclusion. The protocol always provides a valid fill path; it just prices adversarial flow differently. Per-instrument scoring: toxic on SOL-PERP does not affect BTC-PERP score.

### Emergency Pause (4 independent flags)

| Flag | Effect |
|---|---|
| `PAUSE_TRADING` | Blocks `CommitOrder` |
| `PAUSE_WITHDRAWALS` | Blocks `Withdraw` |
| `PAUSE_LIQUIDATIONS` | Blocks `LiquidateUser` |
| `PAUSE_FUNDING` | Skips funding accrual in `SettleBatch` |

Gates verified in `commit_order`, `reveal_order`, `withdraw`, `liquidate_user`, and `settle_batch`. Each flag is independently settable via `SetPauseFlags` (governance only).

---

## Keepers (Permissionless Off-Chain Agents)

| Keeper | Operation | Revenue |
|---|---|---|
| **Batch Crank** | `CloseCommitting` → `ClearBatch` → `SettleBatch` | ~10% of batch taker fees |
| **Liquidator** | Monitor portfolio health; `LiquidateUser` → optimizer → market sweep | ~2.5% of liquidated notional |
| **Reveal Relayer (short-batch)** | Submit pre-signed reveal within 1 slot of commit confirmation | Small relayer fee deducted from commitment deposit return |

All keepers are permissionless. Anyone can run one. The protocol is safe under single-keeper operation (degraded) and improves with multiple competing keepers.

---

## Backend

### Indexer Service (`mgk-frontend/apps/indexer/`)

Node.js + TypeScript. Subscribes to on-chain logs via RPC, parses events into PostgreSQL, exposes REST + WebSocket.

- Real-time event sync to Postgres
- Backfill on startup
- REST endpoints for portfolio, batch, book, fills, instruments, oracle, flow-quality
- WebSocket for live book / batch updates

### API Server

Low-latency read endpoints cached in memory. Frontend polls REST; WebSocket pushes book deltas.

### Keeper Bots

| Keeper | Stack | Run mode |
|---|---|---|
| Batch Crank | Node.js / TypeScript | 24/7 devnet + mainnet |
| Liquidator | Node.js / TypeScript | 24/7 devnet + mainnet |
| Reveal relayer | Node.js, ~100 LOC | 24/7, triggered by commit confirmation |

### Keeper Economics

- Liquidation rewards cover execution costs + profit margin
- Batch crank is effectively subsidized by taker fees (anyone is incentivized to step in)
- Multiple competing keepers maintain redundancy and honesty

---

## Infrastructure Considerations

### Current (devnet)

- Single-region keeper VPS
- Postgres (single instance) for indexer
- Next.js 15 frontend on Vercel
- GitHub Actions CI: `cargo test --all-features` + `cargo clippy --all-targets --all-features -- -D warnings` + `cargo build-sbf` + `pnpm -r test` + Playwright E2E

### Planned (mainnet)

- Multi-region keeper VPS (US, EU, Asia) for redundancy
- Postgres read replicas for geographic distribution
- In-memory cache (Redis) for hot endpoints
- Grafana + Prometheus monitoring on keepers and indexer
- Rolling deployments via Docker

### Design Principles

- **Vendor-agnostic:** all services containerized with Docker; no cloud-specific dependencies
- **Horizontal scalability:** stateless API servers behind load balancer; DB read replicas
- **CI/CD:** GitHub Actions pipeline runs all test suites before deploy
- **Frontend:** Vercel CDN with IPFS backup

---

## Risk Disclosure & Compliance

### Technical Risks

| Risk | Mitigation |
|---|---|
| **Smart-contract bug** | Pinocchio (no Anchor macro magic), checked arithmetic throughout, single custody authority isolation, Kani formal verification (10 math proofs + 6 system invariants planned), independent security review before mainnet |
| **Oracle staleness / manipulation** | Pyth pull + admin fallback; freshness threshold + confidence check; graceful degradation to depth-weighted book mid when oracle is stale |
| **Commit-reveal slash risk** | Pre-signed reveal relayer eliminates user-side slash risk from tight reveal windows; relayer fee aligns incentives |
| **BPF stack overflow** | Matcher BSS scratch buffers in `.data.S` link section; modular instruction decomposition (`ComputeClearing` / `ClearAndMatch` / `CancelResting` etc.) |
| **Liquidation failure** | Permissionless liquidator + hedge-preserving optimizer + insurance fund + ADL; multi-keeper competition for liquidations |

### Market Risks

| Risk | Mitigation |
|---|---|
| **Toxic-taker gaming** | Flow-quality scoring over 100-batch rolling window; per-instrument scoring; capped spread widening (never hard-reject) |
| **Liquidity thinness** | Persistent GTC book across batches; depth-weighted mark price (not top-of-book); oracle as sanity anchor |
| **Funding rate gaming** | SMA over multiple samples per funding period; depth-weighted premium (not simple mid); funding cap |
| **Regulatory** | Initial launch markets are SOL-PERP, BTC-PERP, ETH-PERP — crypto-native. Geographic compliance handled at frontend (geo-block where required); program is network-agnostic |

### Operational Risks

| Risk | Mitigation |
|---|---|
| **Keeper liveness** | Permissionless + devnet-validated; multiple competing keepers; degraded-safe mode (mark price falls through to Pyth if oracle keepers fail) |
| **Key management** | Squads multisig (3-of-5 or similar) for upgrade authority, pause authority, governance in Phase 6 |
| **Program upgrade blast radius** | Pinocchio authority isolation — matcher can be upgraded without touching custody path |
| **Team risk** | Open-source ethos, full design doc + implementation report on disk, lifecycle-managed development |

---

## Operation Flows

### Example 1 — Open a long position via market order

**Setup:** Alice has deposited 5 SOL into her portfolio at SOL-PERP mark price $150.

1. Alice submits `CommitOrder(Limit(GTC), Long, $150, 2 SOL, salt, batch=N)` as a hash. A commitment deposit of ~0.01 SOL is locked.
2. Batch N commit phase closes after `T_min` slots with ≥5 commitments.
3. Alice (or her relayer) submits `RevealOrder` with the plaintext + salt within `T_reveal`.
4. Crank calls `ClearBatch`. Revealed orders are shuffled, separated into priority queues, then matched. Alice's limit at $150 doesn't cross (best ask is $150.5); it rests on the book as GTC.
5. Batch N+1 opens. Alice's resting order matches against an incoming market sell at $150. She fills at $150 (maker price).
6. Batch N+1 settles. Alice is long 2 SOL-PERP at entry $150 with 5 SOL collateral → ~1.67x effective leverage.

**Result:** Alice's position appears in the frontend portfolio panel. Her commitment deposit is returned.

### Example 2 — Resting order lifecycle (maker rebate)

1. Bob submits `CommitOrder(Limit(GTC), Short, $152, 3 SOL, ...)` at batch N. Best bid is $151.5 — Bob's order doesn't cross.
2. Batch N clears: Bob's order rests on the book at $152.
3. Batch N+1: Charlie submits a market buy for 4 SOL. He walks the book: 1 SOL at $151.5, 3 SOL at $152 (Bob is the maker).
4. Bob receives maker rebate (e.g., `maker_fee_bps = -1`, so he earns 0.01% × 3 SOL × $152 ≈ $4.56 in rebates). His position is short 3 SOL at $152.
5. Bob's resting order still has 0 SOL remaining — it's removed from the book.

**Capital efficiency:** Bob's order persisted across batches and captured a maker fill without resubmitting.

### Example 3 — Liquidation with insurance fund absorption

**Setup:** Dave has 10 SOL collateral, long 30 SOL at entry $148. Mark price drops to $140.

1. Dave's `Equity = collateral + position_pnl = 10 + 30*(140-148) = 10 - 240 = -230` USD-equivalent. Below maintenance margin `M_p` (e.g., 5% of notional = 0.05 × 30 × $140 = $210).
2. Liquidator keeper calls `LiquidateUser(Dave)`.
3. **Step 1** — cancel all of Dave's resting orders (none open).
4. **Step 3** — optimizer: Dave's long is the only position. `IR = margin_reduction / market_impact`. Reduce ~25% first (urgency > 30%).
5. Market sweep: 7.5 SOL sell against the book. Book absorbs at $139.95 → $139.85 (slightly worse than top-of-book due to depth).
6. Recompute gap. Still below. Iterate: another 25%. Book absorbs at $139.80.
7. After 4 iterations Dave's position is fully reduced. Residual shortfall: $50 below Dave's collateral. **Insurance fund absorbs** the $50.
8. ADL does NOT trigger because the insurance fund is sufficient.

**No liquidation fee charged to Dave.** Insurance fund replenished by protocol fees + slashed commitment deposits over time.

### Example 4 — Cancel a resting order

1. Eve has a resting GTC buy at $145 for 2 SOL from batch N−3.
2. Eve submits `CancelRestingOrder` (disc 11) in a single transaction.
3. Core CPI's matcher `CancelResting`. The resting order is removed immediately; it does not wait for the next DFBA clear.

**Latency:** cancel is visible as soon as the transaction confirms (not one-batch delayed).

---

## Major Design Decisions & Trade-offs

### 1. DFBA vs Continuous CLOB vs Off-Chain Batch Auction

**Chosen (v1, M9): Dual Flow Batch Auction.** Continuous CLOBs (Drift, Zeta) require sequencer trust to prevent MEV; solver-based batch auctions (CoW Protocol) require off-chain matching. DFBA gives on-chain uniform-price dual clears without a sequencer. Trade-off: orders are visible in the mempool during Collecting; fairness is structural (price/size), not sealed-intent.

**Historical (M1–M8, retired):** short-batch commit-reveal CLOB. Kept in historical planning/testing records only.

### 2. Hedge-Preserving Safety Stack vs Global Haircut

**Chosen: hedge-preserving optimizer + insurance + ADL.** Global haircut (e.g., Mars Protocol) charges all positions a flat haircut — simpler but inefficient for hedged portfolios. The optimizer only reduces positions that contribute to risk, preserving hedges.

### 3. Three-Program Separation vs Monolith

**Chosen: 3 programs + 1 library crate.** Isolates custody (Core) from matching (Matcher) from price (Oracle). A bug in matching logic cannot directly move funds. CPI is one-way (Core → Matcher only).

### 4. SOL-Only vs Multi-Token Collateral

**Chosen: SOL-only for v1.** Simplifies custody (one vault), margin math (one price), and liquidation (one market sweep). Multi-token collateral adds oracle breadth and cross-margin complexity — v2.

### 5. Full Slashing vs Partial Penalty

**Chosen: full slashing.** Partial penalties (e.g., 10%) leave a vector for malicious non-reveal at low cost. Full slashing makes non-reveal economically irrational and replenishes the insurance fund.

### 6. Static Margin Tiers vs Lambda Surfaces

**Chosen: static tiers for v1.** Lambda surfaces (e.g., Morpho-style) compute margin from a continuous function of volatility. More capital-efficient but harder to verify. v1 uses per-instrument `imr_bps` / `mmr_bps`; lambda surfaces are a v2 candidate.

### Rejected Alternatives

| # | Alternative | Rejection |
|---|---|---|
| R1 | Continuous CLOB (<400ms, no batches) | Requires sequencer for MEV protection — reintroduces trust assumption |
| R2 | Drift-style hybrid (off-chain matching + on-chain settlement) | Trusts the matcher, breaks promise of full on-chain verifiability |
| R3 | Bullet ZK rollup | Privacy is nice but rollup infra is heavy; chose transparent on-chain instead |

See `docs/ai/requirements/2026-06-18-feature-onchain-perps-dex.md` § Short-Batch Decision Log for the full rationale.

---

## Non-Functional Requirements

### Performance

| Metric | Target | Status |
|---|---|---|
| Batch latency | p50 < 4s, p99 < 8s | Unmeasured; mainnet bar. Live `t_min=2`, `t_max=150` slots |
| Throughput | 50+ orders per batch over 10+ batches | Target |
| Frontend TTI | < 2s | Lighthouse-validated |
| Indexer REST latency | < 100 ms p99 | Devnet |

### Security

- All arithmetic is checked (`checked_*`), no silent overflow
- `no_std` — no allocator — no heap-corruption class
- Pinocchio `entrypoint!` without Anchor macros — smaller attack surface
- PDA-based account ownership — no upgrade authority over user funds
- Pause flags verified at PostOrder / ClearBatch / withdraw / liquidate / settle call sites
- Canonical vault and registry PDA checks; matcher program-id checks on Core→Matcher CPI
- Matcher mutations require CPI (stack height); full Core-caller auth is a documented migration
- This document is **not** a substitute for the independent mainnet Solana audit

### Reliability

- Permissionless keepers: any party can run them
- Graceful degradation: oracle failure → depth-weighted book mid + Pyth fallback; book illiquidity → ADL
- All state is on-chain — no off-chain DB is a source of truth for trading

### Test Coverage

- Rust unit tests across 4 crates (`cargo +stable test --all-features`); four BPF lifecycle cases remain `#[ignore]` (program-test CU meter — test debt, not a proven on-chain defect)
- Frontend: Vitest web + SDK + indexer + Playwright wallet/trade suites
- Clippy clean (`cargo +stable clippy --all-targets --all-features -- -D warnings`)
- SBF builds clean (zero stack-overflow errors)
- Formal verification (Fender / QEDGen / Kani) is **unavailable** in this slice; CI still references a removed `model_safety` crate. Do not claim machine-checked invariants.

---

## How to Verify

- **Devnet explorer (core):** https://explorer.solana.com/address/C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx?cluster=devnet
- **Devnet explorer (matcher):** https://explorer.solana.com/address/7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC?cluster=devnet
- **Devnet explorer (oracle):** https://explorer.solana.com/address/CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ?cluster=devnet
- **PriceOracle:** `5NSDGAaRqfxe6mkZG9fEAZdzK4r77nEBEobohZGYP6PN`
- **Instrument:** `Hz9UtmSXyKFnp1pGvrhrAmizMsvEkYRh5Eih1r7Lf1hG`
- **M9.10 D7 core upgrade:** tx `Dmh6CEXi…` (slot 487386516)
- **Dual-fill settle (batch 20):** tx `2BYRK69U…`
- **Rust tests:** `cargo +stable test --all-features`
- **Frontend tests:** `pnpm -r test` in `mgk-frontend/` (Node 22.19.0 / Corepack)
- **Lint:** `cargo +stable clippy --all-targets --all-features -- -D warnings`
- **SBF build:** `cargo build-sbf`
- **Full design doc:** `docs/ai/design/feature-onchain-perps-dex.md`
- **Active plan:** `docs/ai/planning/2026-08-02-feature-onchain-perps-dex.md` (M9.10 complete; T9.11.12–13 post-merge deploy not this slice)
- **Internal CSO report:** `.superstack/security-reports/feature-dfba-auction-2026-08-24.md` (not the independent mainnet audit)
- **Historical grant (commit-reveal era):** `docs/ai/planning/2026-06-24-mgk-perps-grant-proposal.md`

---

## References

- [Bulk.Trade — Architecture](https://docs.bulk.trade/architecture) (fair ordering, safety stack alignment)
- [Pyth Network — Solana Price Feeds](https://docs.pyth.network/)
- [Pinocchio — Rust library for Solana programs](https://github.com/pinocchio-rs/pinocchio)

---

*Maintained by the mgk Protocol team. Grant submission: https://superteam.fun/earn/grants/agentic-engineering.*
