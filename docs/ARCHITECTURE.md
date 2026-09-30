# mgk Perps DEX

Technical Architecture

https://github.com/mangekyou-labs/mgk-solana

https://mgk-frontend.vercel.app

**mgk Perps DEX**

- [Introduction](#introduction)
  - [High-Level Overview](#high-level-overview)
- [Development](#development)
  - [High-Level Architecture](#high-level-architecture)
  - [Component Responsibilities](#component-responsibilities)
  - [Smart Contracts](#smart-contracts)
    - [Contract Architecture](#contract-architecture)
    - [Contract Descriptions](#contract-descriptions)
    - [Data Storage Overview](#data-storage-overview)
    - [Oracle Integration](#oracle-integration)
    - [Core Mechanisms](#core-mechanisms)
  - [Backend](#backend)
    - [Indexer Service](#indexer-service)
    - [API Server](#api-server)
    - [Keeper Bot Service](#keeper-bot-service)
  - [Infrastructure Considerations](#infrastructure-considerations)
    - [Design Principles](#design-principles)
- [Risk Disclosure & Compliance](#risk-disclosure--compliance)
  - [Technical Risks](#technical-risks)
  - [Market Risks](#market-risks)
  - [Operational Risks](#operational-risks)
- [Operation Flows](#operation-flows)
  - [Opening a Position](#opening-a-position)
  - [Closing a Position](#closing-a-position)
  - [Staking (LP Deposit)](#staking-lp-deposit)
  - [Unstaking (LP Withdrawal)](#unstaking-lp-withdrawal)

---

# Introduction

## High-Level Overview

Perpetual futures represent the largest segment of decentralized finance by trading volume, consistently accounting for 60–70% of total DEX volume and generating substantial protocol revenues. The perpetuals market has demonstrated product-market fit with protocols like GMX generating over $100M in annual fees and dYdX processing $50B+ in monthly trading volume.

Solana offers compelling advantages for derivatives trading:

- Ultra-low transaction costs: sub-cent average versus $2–20 on Ethereum mainnet (99%+ cost reduction), with Ethereum spiking to $50–100+ during congestion
- Fast finality: ~400 ms slots with optimistic confirmation in seconds, versus 12–15 minutes on Ethereum
- Parallel execution: independent markets and portfolios can proceed concurrently without a global queue
- High throughput: capacity for frequent order posts, cancels, and batch clears without fee spikes
- Existing wallet and RPC infrastructure: Phantom, Solflare, Backpack, and production-grade RPC providers

Today’s Solana perps landscape is dominated by hybrid models that match off-chain and settle on-chain, or by AMM-style synthetics that trade against a pooled LP at an oracle price. **No live venue combines fully on-chain matching, persistent resting depth, and sequencer-free operation.**

**Our Mission:** Build a fully on-chain perpetual futures DEX on Solana — Dual Flow Batch Auction matching, no sequencer, professional-grade UX that removes technical barriers for mainstream traders.

**Initial Launch Parameters:**

- Single collateral: SOL
- Three initial markets: SOL-PERP, BTC-PERP, ETH-PERP
- 5–20x leverage range with conservative per-instrument caps
- Cross-margin portfolio per wallet
- Professional-grade interface targeting retail and institutional traders

**Competitive Advantages:**

- Fully on-chain execution: every post, cancel, fill, liquidation, and settlement is verifiable on-chain
- No sequencer trust assumption: matching and custody live in Pinocchio BPF programs, not a private matching engine
- MEV / latency-arbitrage mitigation via market structure: Dual Flow Batch Auction (DFBA) — two independent uniform-price auctions per batch; within-batch arrival time has no priority
- Persistent resting book: unfilled maker and taker quantity survives across batches with role preserved
- Isolated custody: the Core program is the sole authority that can move user funds; the matcher never holds collateral
- Native SOL collateral with sub-cent transaction costs for high-frequency quoting and cancellation

---

# Development

## High-Level Architecture

The protocol consists of four interconnected systems working together:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Frontend Application                        │
│              Next.js + Tailwind · Phantom / Solflare            │
│         Trade · Chart · Positions · Balances · Order form       │
└──────────────────────────────┬──────────────────────────────────┘
                               │ REST / WebSocket
┌──────────────────────────────┴──────────────────────────────────┐
│                       Backend Services                          │
│         Indexer · API server · Batch crank · Liquidator         │
└──────────────────────────────┬──────────────────────────────────┘
                               │ RPC (send / subscribe)
┌───────────────┬──────────────┴──────────────┬───────────────────┐
│ Smart         │                             │ Oracle            │
│ Contracts     │                             │ Integration       │
│               │                             │                   │
│ Core          │  Matching Engine            │ Index feed        │
│ Portfolio,    │  Dual-flow batch auction    │ Funding only      │
│ vault, batch, │  Resting book               │ Never mark        │
│ margin, liq.  │  Never holds funds          │ Never execution   │
└───────────────┴─────────────────────────────┴───────────────────┘
```

**Key architectural principle:** fund management is isolated from matching. All SOL collateral sits in Core-controlled vaults and per-user portfolio PDAs. The Matching Engine stores the book and runs auctions; it cannot transfer lamports. Only one program can move user funds, reducing the blast radius of a matching bug.

## Component Responsibilities

**Smart Contracts Layer (Pinocchio / Rust)**

- Store and manage all portfolio, position, batch, and order-book state
- Execute SOL transfers with atomic guarantees inside Core
- Enforce risk parameters and liquidation logic
- Calculate PnL, funding rates, and the DFBA mark
- Manage resting order lifecycle (post, cancel, modify)
- Run two independent uniform-price auctions at batch clear
- Read the index price for funding only

**Backend Services (Node.js)**

- Index blockchain events and account updates in real time
- Maintain a synchronized database for the frontend
- Provide low-latency API endpoints
- Execute keeper operations (batch crank, liquidations, index updates)
- Send user notifications (position alerts, liquidation warnings)
- Cache frequently accessed data

**Oracle Integration**

- Index price used **only** for funding (`mark − index`)
- Design target: multi-venue aggregated fair value
- Current feed: admin-pushed on-chain oracle program, with freshness checks
- Manipulation resistance: the oracle cannot set execution price or liquidation mark

**Frontend Application (React / Next.js + TailwindCSS)**

- Professional trading interface with advanced charting
- Real-time position monitoring and PnL tracking
- Single-transaction order post (`PostOrder` with maker/taker role)
- Portfolio dashboard (balances, positions, open orders)
- Mobile-responsive design
- Wallet integration (Phantom, Solflare, Backpack)

## Smart Contracts

### Contract Architecture

The protocol uses 3 specialized programs for security, upgradeability, and clean separation of concerns:

**Core Program (`mgk-perps-core`)**
Manages portfolios, the collateral vault, batch lifecycle, margin, funding, and liquidation. Sole custody authority.

**Matching Engine (`mgk-perps-matcher`)**
Runs Dual Flow Batch Auction matching and stores the resting book. Never holds funds.

**Oracle Program (`mgk-oracle`)**
Publishes the funding index. Never sets mark. Never used as an execution price.

Live M9 devnet:

| Program | Address |
|---------|---------|
| Core | `C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx` |
| Matcher | `7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC` |
| Oracle | `CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ` |

A shared library crate (`mgk-common`) holds account validation, errors, and math. It is not a deployed program.

**Why This Architecture:**

- **Security:** the fund-holding program (Core) is isolated from matching logic (Matcher)
- **Upgradeability:** matching can be upgraded without touching the custody path
- **Auditing:** smaller, focused programs — Matcher is the heavy math surface; Core is the fund-moving surface
- **Risk isolation:** liquidation optimizer, insurance fund, and auto-deleveraging are independently reachable

CPI direction is one-way: Core → Matcher only. Matcher → Core is forbidden. Oracle is read-only.

### Contract Descriptions

**Core Program** manages the complete trader lifecycle: deposit, withdraw, post/cancel/modify orders, batch close/clear/settle, and liquidation. It is the only program that transfers SOL. Matching is delegated to the matcher via CPI so that a matching bug cannot move funds.

Key Methods:

- `initialize(admin)` → Bootstrap registry, vault, and default parameters
- `init_portfolio(trader)` → Create the trader’s cross-margin account
- `deposit(trader, amount)` → Transfer SOL from trader to vault; credit free collateral
- `withdraw(trader, amount)` → Transfer SOL from vault to trader after margin check
- `post_order(trader, instrument_id, side, is_maker, price, qty, reduce_only)` → Post a limit order onto the resting book
- `cancel_resting_order(trader, order_id)` → Immediate cancel; unlock collateral
- `modify_resting_order(trader, order_id, price, qty)` → Immediate modify; re-check margin
- `cancel_all_resting_orders(trader)` → Cancel every resting order for the portfolio
- `close_collecting()` → Permissionless: close the collection window when cadence criteria are met
- `clear_batch()` → Permissionless: CPI to matcher Dual Flow Batch Auction; apply fill receipts
- `settle_batch()` → Persist mark, accrue or skip funding, open the next batch
- `liquidate_user(keeper, trader)` → Hedge-preserving reduction → insurance fund → ADL. Requires a valid DFBA mark
- `add_instrument(market_id, imr, mmr, fees, max_leverage)` → Register a perp market
- `set_batch_params(t_min, t_max, n_min, cap)` → Governance: collection window and order cap
- `set_pause_flags(flags)` → Governance: independent pause bits (trading, withdraw, liquidation, funding, post, clear)

Orders are posted in the open. There is no commit-reveal ceremony and no second transaction to reveal.

**Matching Engine** holds order-book state and runs two independent uniform-price auctions per batch: maker-buy × taker-sell (bid auction) and maker-sell × taker-buy (ask auction). It never holds funds. Book accounts are rent-exempted by Core. Unfilled quantity rests with the same maker/taker role.

Key Methods:

- `initialize_book(instrument_id)` → Create the book PDA for a market
- `place_resting(order)` → Called via Core CPI on `post_order`
- `dfba_clear(eligible_orders)` → Dual volume-max auction, allocate, update book, return fill receipts
- `cancel_resting(order_id)` → Remove a resting order
- `modify_resting(order_id, price, qty)` → Resize / reprice a resting order
- `cancel_all(trader)` → Cancel all resting orders for an account

**Critical rule:** the matcher never calls Core and never transfers lamports.

**Oracle Program** publishes the funding index. Trading prices come from the two DFBA auctions. Liquidation mark is the mid of those two clears, and only when both auctions produce a fill. A stale or manipulated index can distort funding; it cannot force a false liquidation.

Key Methods:

- `initialize(admin)` → Bootstrap instrument and initial index
- `update_price(asset_id, price, confidence, timestamp)` → Push a new index
- `validate_price(price, timestamp)` → Freshness and bounds check (stale index → skip funding)
- `get_price(asset_id)` → Read current index
- `set_authority(new_admin)` → Rotate admin key
- `activate()` / `deactivate()` → Enable or disable index reads

### Data Storage Overview

**Core — Portfolio:** Persistent per-wallet account. Holds equity, principal, unrealized PnL, initial and maintenance margin, free collateral, health, open positions (instrument, signed quantity, entry VWAP), funding checkpoints, open-order count, and last batch/slot.

**Core — Vault:** Persistent singleton PDA. Holds all protocol SOL. Only Core can debit it (withdraw, liquidation payouts). Isolated from matching upgrades.

**Core — Registry / Instrument:** Persistent configuration. Fee rates, leverage caps, margin ratios, pause flags, batch parameters, oracle pubkey, and per-market metadata.

**Core — Batch:** Sequential account per clearing epoch. Status (Collecting / Clearing / Settled), window timestamps, order count, last bid/ask clearing prices, matched quantities, mark price, `mark_valid`, and liquidation-paused flag.

**Matcher — Order Book:** Persistent across batches. Resting orders with order id, trader, instrument, side, maker/taker role, limit price, quantity, filled quantity, reduce-only flag, and batch placed.

**Oracle — Price Account:** Latest index, confidence, timestamp, and active flag. Treated as Temporary in spirit (frequently updated) even though Solana accounts are rent-exempt and persistent.

### Oracle Integration

Price Feed Structure:

- Index is a reference fair value for **funding only**
- Design: multi-venue aggregation (four CEX venues)
- Current: on-chain oracle program with admin/keeper updates
- Price staleness check: skip funding when the index is older than the configured slot/time bound
- Timestamp-based replay protection
- **Does not** set entry price, exit price, or liquidation mark
- **Does not** use min/max oracle spread as a bid/ask that traders are filled against

When the index is stale or deactivated, `settle_batch` skips funding. Trading and cancels continue. Liquidations are gated on a valid DFBA mark, not on the oracle.

### Core Mechanisms

**Dual Flow Batch Auction (matching):**

- Collection window is governance-parameterized (`t_min`, `t_max`, `n_min`)
- Traders post limit orders openly with a designated role (maker or taker; default taker)
- Bid auction: maker-buy × taker-sell. Ask auction: maker-sell × taker-buy
- Each auction maximizes matched volume at a single uniform clearing price
- Allocation is price-priority, then pro-rata at the margin
- Makers never match makers. Takers never match takers
- Unfilled quantity rests with the same role until filled, cancelled, or modified
- Self-trade: skip pairs that resolve to the same portfolio
- Within-batch arrival time has **no** priority

Working-devnet window: `t_min = 2` slots, `t_max = 150` slots (~60s), `n_min = 1` order. The window can be tightened by governance without a program rewrite.

**Mark price:**

```
if bid_auction matched AND ask_auction matched:
    mark = (bid_clearing_price + ask_clearing_price) / 2
    mark_valid = true
else:
    mark_valid = false   // liquidations pause; last mid is display-only
```

**Funding Rate Calculation:**

- Accrued on settle when `mark_valid` and the index is fresh; otherwise skipped
- Larger premium of mark over index → longs pay shorts; discount → shorts pay longs
- Formula: `funding_rate = clamp(((mark − index) / index) × k, ±max_rate)`
- Trader-to-trader payment. No LP borrowing-fee leg
- No separate 60-second funding instruction — funding is applied in `settle_batch`

**Trading Fees:**

- Taker fee: 5 bps of filled notional at the clearing price (default)
- Maker fee: 0 bps in v1 (makers free)
- Fees round up to the protocol; pro-rata fills round down
- Optional maker rebate is post-v1

**Liquidation Logic:**

- Trigger: portfolio equity below maintenance margin **and** position PnL negative **and** `mark_valid`
- If `mark_valid` is false: `liquidate_user` rejects. No liquidation at an oracle or last-good mark
- Step 1: cancel all open orders so exposure cannot increase
- Step 2: hedge-preserving optimizer ranks reductions by impact ratio (`margin_reduction / estimated_impact`)
- Step 3: iterate up to 10 times; full flatten only if the optimizer cannot restore health
- Insurance fund absorbs shortfall (base and quote inventory)
- Auto-deleveraging (ADL) ranks profitable counterparties only if the fund cannot cover or the book cannot absorb
- No liquidation fee charged to the trader as a product rule; keepers are paid from protocol economics

**Emergency Pause:**

Six independent flags: trading, withdrawals, liquidations, funding, post, clear. Withdrawals are not automatically blocked when trading is paused. Governance only.

---

## Backend

### Indexer Service

**Purpose:** Maintain a real-time off-chain database synchronized with on-chain state.

**Core Functions:**

- Subscribe to Core and Matcher program logs via RPC websocket
- Optional account subscribe on Batch and Book PDAs
- Parse and transform instruction logs into a normalized schema
- Handle missed slots via signature backfill on startup
- Emit notifications for critical events (fills, liquidations, mark invalid)

Storage today is SQLite; Postgres with read replicas is the mainnet target. On-chain programs remain the source of truth. The indexer is a cache, not a sequencer.

### API Server

**Purpose:** Provide low-latency data access for the frontend and external integrations.

**Core Functions:**

- REST API for positions, balances, open orders, market data, user history
- WebSocket for live book and batch updates
- Caching layer for frequently accessed data
- Rate limiting

### Keeper Bot Service

**Critical Operations:**

1. **Batch Crank**
   - Watch `Batch.status == Collecting`
   - When window criteria are met, submit `close_collecting` → `clear_batch` → `settle_batch`
   - Retry next slot on failure
   - Funding is applied inside `settle_batch` (no separate 60s tick)

2. **Liquidation Monitoring**
   - Query the database for portfolios near maintenance
   - Double-check on-chain state (database could lag) including `mark_valid`
   - Execute `liquidate_user` only when mark is valid
   - Retry with higher priority fee if the transaction fails

3. **Index Updates**
   - Keep the funding index fresh
   - Stale index must skip funding, not invent a mark
   - Design target: multi-venue aggregation posted by a keeper

4. **ADL Execution**
   - Last step inside `liquidate_user`, not a separate bot
   - Activates only if the insurance fund cannot cover shortfall or the book cannot absorb the reduction
   - Closes profitable counterparties by score, at the deleveraged trader’s entry price

**Keeper Economics:**

- Liquidation rewards cover execution cost plus margin
- Batch crank is incentivized by a share of taker fees
- Index updates are operational cost (sub-cent on Solana)
- Multiple keeper competition ensures redundancy
- Open-source keeper implementation allows community participation
- Every keeper role is permissionless; the protocol is safe (degraded) under a single keeper

There is no reveal relayer. Orders are posted in one transaction.

---

## Infrastructure Considerations

### Design Principles

**Vendor-Agnostic Architecture:**

- All services containerized with Docker
- No cloud-provider-specific dependencies
- Enables deployment on any VPS/cloud (AWS, GCP, Azure, DigitalOcean)

**Horizontal Scalability:**

- Stateless API servers behind a load balancer
- Database read replicas for geographic distribution
- Independent service scaling based on load (indexer, API, keepers)

**Database Strategy:**

- SQLite on working-devnet; PostgreSQL primary for mainnet ACID guarantees
- Read replicas in multiple regions (EU, US, Asia)
- Reduces query latency for global users
- Automated failover for high availability

**Deployment Options:**

- Docker Compose for development and initial production
- Automated CI/CD pipeline (GitHub Actions): clippy (warnings = errors), `cargo test --all-features`, `cargo build-sbf`, frontend suites
- Rolling deployments for zero downtime

**Frontend Hosting:**

- Vercel for CDN distribution
- IPFS backup for censorship resistance
- Custom domain with SSL
- Cloudflare for DDoS protection

**On-chain source of truth:**

- Keepers and indexer may lag; they are never trusted for custody or matching
- Every fill is reproducible from program accounts
- Vault authority, admin authority, and pause authority are logically separate
- Mainnet upgrade and pause authority: Squads multisig (planned)
- No mainnet deploy without an independent security review

---

# Risk Disclosure & Compliance

## Technical Risks

**Smart Contract Risk:** Despite tests, bugs could lead to loss of funds. Mitigation: Pinocchio (no Anchor macro layer), checked arithmetic, single custody authority, one-way CPI, independent security review before mainnet, planned formal proofs on conservation, no over-withdrawal, makers-only-match-takers, uniform-price bound, self-trade skip, and `mark_valid` ⇒ dual clear. No mainnet pre-audit.

**Oracle Risk:** Incorrect index could distort funding. Mitigation: oracle never sets mark or execution price; liquidations require a current dual DFBA clear; stale index → skip funding; admin deactivate; future multi-venue aggregation.

**Liquidation Risk:** Insufficient keeper participation or an invalid mark could delay deleveraging. Mitigation: permissionless liquidators, keeper economics, honest pause when there is no dual clear (`mark_valid = false`), insurance fund, ADL as last resort, conservative margin caps.

**Account / Compute Risk:** A dual auction at the per-batch cap could exceed compute or the BPF stack. Mitigation: fixed-width scratch buffers, modular instructions, hard order cap; overflow rests for the next batch rather than aborting the book.

## Market Risks

**Trader PnL Risk:** There is no LP pool that absorbs trader profits. Counterparties are other traders. Residual shortfall is the insurance fund, then ADL. Mitigation: dual-auction rest so quotes persist, OI and margin caps, insurance inventory, ADL ranking.

**Liquidity Risk:** Insufficient resting makers leads to wider clears and more batches with no dual clear. Mitigation: makers trade free in v1, full rest across batches, market-maker quoting without maker–maker pick-off, conservative open-interest limits.

**Regulatory Risk:** Unclear regulatory status of perpetual futures. Mitigation: legal counsel, geo-blocking at the frontend if necessary, crypto-native launch markets (SOL/BTC/ETH-PERP). No KYC in v1.

## Operational Risks

**Key Management:** Loss of admin keys could prevent upgrades or pause. Mitigation: Squads multisig on mainnet, hardware wallets, key ceremony documentation. Devnet single-admin is not a mainnet pattern.

**Team Risk:** Dependence on a small core team. Mitigation: documentation, code reviews, open-source ethos, community keeper participation.

**Competitive Risk:** Other on-chain CLOB or auction perps could launch on Solana. Mitigation: shipped dual-auction on devnet, custody isolation, and a public DFBA spec rather than a sequencer story.

**Keeper Liveness:** A stalled crank stalls new clears. Mitigation: permissionless close/clear/settle; missed slot retries next slot; competing keepers; posts still rest until a crank runs.

**Indexer Lag:** UI could show a stale book or a false `mark_valid`. Mitigation: on-chain re-check before liquidation; boot backfill; never trust the database for custody.

---

# Operation Flows

## Opening a Position

Positions open when a posted limit **fills** in a Dual Flow Batch Auction, not when collateral is first locked.

1. **User submits order** → `post_order(trader, instrument_id, side, is_maker, price, qty)`
2. **Contract validates** → Check pause flags, signer, price/qty bounds, and margin (free collateral covers worst-case fill)
3. **Lock collateral** → Core locks free collateral on the portfolio; no token leaves the vault
4. **Rest on book** → Core CPI `place_resting` onto the Matching Engine book
5. **Batch closes** → Permissionless crank calls `close_collecting` when `(slot_age ≥ t_min AND n_orders ≥ n_min) OR slot_age ≥ t_max`
6. **Get fill price** → `clear_batch` runs bid and ask auctions; fill price is the uniform clearing price of the auction that matches this order (price improvement vs limit is possible)
7. **Create / update position** → Core applies fill receipts: signed quantity, entry VWAP, taker fee if `is_maker = false`
8. **Emit + display** → Indexer records the fill; frontend shows the new position

**Example:** 5 SOL collateral. Taker buy of 2 SOL-PERP at limit $150.50. A maker sell rests at $150.00. Ask auction clears at $150.00. Trader buys 2 at $150.00 (improvement vs $150.50), pays 5 bps taker fee, and is long 2 SOL-PERP.

Effective leverage is `notional / equity` after the fill, bounded by per-instrument initial and maintenance margin. There is no `leverage` argument on the instruction.

## Closing a Position

Close is a reduce-only order that fills the other way. There is no single `close_position` call against an LP.

1. **User initiates close** → `post_order(..., reduce_only=true)` on the opposite side, qty ≤ open position
2. **Verify** → Core rejects if the order would increase exposure
3. **Rest / fill** → Order rests and fills in the next Dual Flow Batch Auction at that auction’s uniform price
4. **Realize PnL** → Fill receipts reduce position quantity; PnL realizes into equity; locked collateral frees
5. **Remove if flat** → Position slot cleared when quantity reaches zero
6. **Calculate PnL** → `(exit_price − entry_vwap) × qty × direction − fees`
7. **Emit event** → Indexer records the close
8. **Return PnL** → Frontend displays profit/loss

**Example:** Long 2 at $150. Reduce-only taker sell of 2 at $149. Maker bid clears the bid auction at $149.50. Trader sells 2 at $149.50; position goes to zero; equity reflects realized PnL minus taker fee.

## Staking (LP Deposit)

mgk does not mint LP shares and does not run a pooled LP that underwrites trader PnL. Liquidity is resting maker quotes on the Dual Flow Batch Auction book. This heading is **SOL collateral deposit** into the Core vault.

1. **User deposits** → `deposit(trader, amount)`
2. **Transfer SOL** → System transfer from trader to the vault PDA
3. **Credit portfolio** → Increase `principal` and `free_collateral` 1:1 with lamports deposited
4. **No shares minted** → There is no share supply and no share price
5. **Update totals** → Vault lamports and portfolio equity
6. **Return balance** → Frontend displays portfolio collateral

**Example:** Deposit 1 SOL (1,000,000,000 lamports) → free collateral increases by 1 SOL.

Deposit does not underwrite other traders. A depositor who wants to provide liquidity posts maker orders; they are not LPs in a pool.

## Unstaking (LP Withdrawal)

This heading is **withdraw SOL** with a margin check. Not an LP share burn.

1. **User withdraws** → `withdraw(trader, amount)`
2. **Get portfolio state** → Recompute equity, initial/maintenance margin, and open-order locks
3. **Validate** → Reject if withdrawals are paused, or if remaining equity would breach margin
4. **Debit portfolio** → Reduce principal / free collateral
5. **Transfer SOL** → Vault PDA → trader
6. **Update totals** → Vault lamports and portfolio equity
7. **Return amount** → Frontend displays the new balance

**Example:** 5 SOL collateral, no open position, no resting orders → withdraw 5 SOL. If the trader is long 2 SOL-PERP, withdraw is capped so remaining collateral covers initial margin including worst-case resting orders.

Trading pause does not by itself block withdraw. `PAUSE_WITHDRAWALS` is an independent flag.

---

*Maintained by the mgk Protocol team. Educational / research software until independently audited. Do not deploy to handle real funds on mainnet without that review.*
