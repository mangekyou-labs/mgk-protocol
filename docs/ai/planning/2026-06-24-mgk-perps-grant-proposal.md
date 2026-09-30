---
phase: grant-proposal
title: mgk Perps DEX — Grant Application ($50,000)
description: Fully on-chain perps DEX on Solana — Dual Flow Batch Auction, no sequencer, no commit-reveal. Live M9 programs on devnet. Companion to docs/ARCHITECTURE.md.
---

# mgk Perps DEX — Grant Application

**$50,000 USDG | Solana DeFi Infrastructure**
**Applicant:** mgk Protocol
**Apply:** https://superteam.fun/earn/grants/agentic-engineering

| | |
|---|---|
| **Repository** | https://github.com/mangekyou-labs/mgk-solana |
| **Architecture** | [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md) |
| **Frontend** | https://mgk-frontend.vercel.app |
| **Devnet (core)** | `C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx` |
| **Devnet (matcher)** | `7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC` |
| **Devnet (oracle)** | `CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ` |
| **Registry** | `CbsfrRS2rYE2qgJbi7MM6mLzARUy8cDiYmHW2o12jYJA` |
| **Vault** | `9qe7TkRxDXHo3dywPKiiY1jwSBnFuSPHmGTWhcP8ttXE` |
| **SOL-PERP** | `Hz9UtmSXyKFnp1pGvrhrAmizMsvEkYRh5Eih1r7Lf1hG` |

---

## Products & Services

mgk is a fully on-chain perpetual futures DEX on Solana. Traders post limit orders in the open. A permissionless crank closes a short collection window and runs two independent uniform-price auctions. Every post, cancel, fill, liquidation, and settlement is verifiable on-chain. There is no sequencer and no commit-reveal ceremony.

### What it is

- **Modular program architecture:** Core is the sole custody authority (portfolios, vault, margin, funding, liquidation). The Matching Engine stores the book and runs Dual Flow Batch Auction (DFBA). It never holds funds. Matching can be upgraded without touching the vault.
- **Dual Flow Batch Auction engine:** Bid auction is maker-buy × taker-sell. Ask auction is maker-sell × taker-buy. Each auction maximizes matched volume at one clearing price. Allocation is price-priority, then pro-rata. Unfilled quantity rests with the same maker/taker role across batches. Within-batch arrival time has no priority.
- **Automated maintenance:** Permissionless keepers crank batches (close → clear → settle), liquidate only when the DFBA mark is valid, and publish the funding index. No reveal relayer. No storage-TTL bot.
- **Index oracle (funding only):** The oracle is a reference index for `funding = f(mark − index)`. It never sets execution price and never sets the liquidation mark. Mark is the mid of the two DFBA clears, and only when both auctions produce a fill.
- **Trader interface:** Next.js trade page with charting, book, order form (`PostOrder` in one wallet signature), positions, and balances. Wallets: Phantom, Solflare, Backpack.

### Why this design?

Solana has fast blocks, parallel execution, and sub-cent fees — yet live perps still force a trade-off: fast but trust a sequencer, or permissionless but AMM-capped with no resting depth. mgk takes a third path.

- **Fairness:** Jump Crypto Dual Flow Batch Auction. Makers never match makers. Takers never match takers. Uniform price per auction. No time-priority race inside the batch.
- **Isolation:** Only Core can move SOL. A matcher bug cannot drain the vault.
- **Efficiency:** One user transaction to post. Governance can shrink the collection window without a program rewrite.
- **Resilience:** Keepers are open-source and permissionless. The protocol is safe (degraded) under a single keeper and stronger with competition.

**What it is not:** not a GLP / LP-pool synthetic, not a continuous price-time CLOB, not commit-reveal, not an off-chain DFBA solver.

---

## Market opportunity

Perpetual futures are the largest category in decentralized finance by volume. Trading platforms process ~$27.4B/day in volume, hold ~$17.1B in open interest, and clear >$1.3T/month ([DefiLlama](https://defillama.com/perps)). Solana is suited to on-chain perps — fast finality, parallel execution, sub-cent costs — yet its landscape is dominated by hybrid systems that match off-chain. **No live, fully on-chain CLOB perps DEX with persistent resting depth exists on Solana.** Capturing 1% of decentralized perps daily volume (~$274M/day) at a 5 bps taker fee yields ~$1.37M/day in protocol fees, ~$500M annualized.

mgk is pre-TVL, pre-beta-user. The proof of work is engineering depth plus M9 devnet liveness, not adoption metrics. Tranches 2 and 4 convert that proof of work into real beta-user traction before any mainnet deployment.

---

## Success criteria

The grant funds five tranches of **devnet-validation** work (Tranches 1–5 = $50K). Tranche 6 (mainnet readiness) is described but unfunded, gated on a post-grant independent security review. v1 success criteria are devnet-only.

| # | Criterion | Tranche | Measurement |
|---|---|---|---|
| 1 | Rust tests pass | 1, 2, 5 | `cargo test --all-features` exits 0 |
| 2 | Clippy clean | 1, 2, 5 | `cargo clippy --all-targets --all-features -- -D warnings` exits 0 |
| 3 | SBF builds, no stack overflow | 1, 2, 5 | `cargo build-sbf` exits 0 |
| 4 | Three M9 programs executable | 1 | Core, matcher, oracle IDs above executable on devnet |
| 5 | Full trader loop on devnet | 1 | External wallet: deposit → `PostOrder` → ClearBatch → SettleBatch → position → withdraw |
| 6 | Liquidation path on devnet | 1 | Underwater portfolio → optimizer → insurance/ADL; `LiquidateUser` rejects when `!mark_valid` |
| 7 | Pause flags live | 1 | Each of 6 flags (trading, withdraw, liq, funding, post, clear) toggled and verified |
| 8 | Short-batch latency | 3 | ≥10 batches; p50 < 4s, p99 < 8s post-to-settle; crank uptime ≥95% |
| 9 | Short-batch beta | 4 | 10–20 unique wallets, ≥5 trade cycles each; ≥80% find latency acceptable |
| 10 | Insurance inventory visible | 5 | Inventory rebalance observable post-liquidation; indexer `/insurance` |
| 11 | DFBA invariant proofs | 5 | Kani proofs pass for conservation, no over-withdrawal, makers-only-match-takers, uniform-price bound, self-trade skip, `mark_valid` ⇒ dual clear |

---

## Funded scope ($50K)

Three Pinocchio programs, Dual Flow Batch Auction matching, and the safety stack are deployed on M9 devnet. The grant is product completion: continuous operation, real beta users, shorter collection windows, then hardening. Matching is **not** being rewritten.

### Tranche 1 — Working Perps DEX on Devnet ($12,000)

**Goal:** Turn deployed programs into a demonstrable trading venue. A trader completes the full loop from a personal wallet. Estimated completion: 4 weeks.

**Deliverables & measurement:**

- 50+ full cycles on devnet: deposit → `PostOrder` → rest or fill → settle → withdraw, without protocol halt
- Resting orders persist across batches and are visible in the UI
- Cancel / modify works in the same transaction (no reveal window)
- Batch crank runs close → clear → settle continuously
- Positions and funding (or skipped funding) visible after settle
- Mark is DFBA mid when both auctions clear; liquidations pause when `mark_valid = false`
- Pause flags validated in 100% of simulated admin scenarios
- Liquidation / funding paths trigger correctly in 100% of tested under-collateralized / stale-index scenarios

**Keeper — Batch crank:** Node.js bot watches Collecting, calls `close_collecting` → `clear_batch` → `settle_batch` when `(slot_age ≥ t_min AND n_orders ≥ n_min) OR slot_age ≥ t_max`. Retry queue, RPC failover, alert on missed slot. Open-source, single-Docker deploy.

**Budget:**

- Frontend and program connectivity — $4,000
- Batch crank keeper — $3,500
- Liquidation and funding path exercising — $3,000
- Pause-flag and safety-gate validation — $1,500
- **Tranche 1 total — $12,000**

### Tranche 2 — Testing + Beta Users on Devnet ($10,000)

**Goal:** Stabilize the protocol with integration tests and 5–10 external testers. Estimated completion: 8 weeks.

**Deliverables & measurement:**

- Integration tests: full trade lifecycle (post → clear → settle → position → withdraw)
- Integration tests: liquidation (underwater portfolio → optimizer → insurance/ADL, including `!mark_valid` reject)
- Integration tests: each of the 6 pause flags
- Test coverage ≥85% on core trade, liquidation, and pause paths
- 10 unique external wallets complete a full trade cycle; zero critical bugs left open
- Risk monitoring captures 100% of simulated liquidation events (indexer + on-chain re-check)

**Keeper — Liquidator:** Watches portfolio health via indexer, **re-verifies on-chain** `mark_valid` and equity, invokes `liquidate_user`. No stale-DB liquidations. Priority-fee retry. Same VPS as the crank.

**Budget:**

- Integration tests and quality reports — $3,500
- Beta recruitment and incentives — $2,500
- Liquidator keeper — $3,000
- Bug fixes and UX from tester feedback — $1,000
- **Tranche 2 total — $10,000**

### Tranche 3 — Short-Batch Latency ($10,000)

**Goal:** Shrink the collection window from the working-devnet ~60s (`t_max = 150` slots) to ~2–4s so active trading is viable. Fairness stays in the Dual Flow Batch Auction rules — **not** in a reveal ceremony. Batch parameters are governance-configurable (`SetBatchParams`). No matching rewrite. Estimated completion: 12 weeks.

**Deliverables & measurement:**

- Set working-devnet params toward `t_min = 2` slots, `t_max ≈ 8–15` slots, `n_min = 1`
- Frontend batch countdown, order status, and fill feedback (single signature — no dual-sign, no pre-signed reveal)
- Load test: 100+ concurrent simulated orders; p50 < 4s and p99 < 8s post-to-settle across ≥10 batches
- Crank success ≥95%; missed slot retries next slot
- On-chain CU measurement at `per_batch_order_cap = 64` before any cap increase

**Budget:**

- Crank reliability, window tuning, CU measurement — $4,000
- Frontend batch-status UX — $3,000
- Load testing and latency CSV — $2,000
- Governance param validation — $1,000
- **Tranche 3 total — $10,000**

### Tranche 4 — Short-Batch Beta ($6,000)

**Goal:** Validate the faster window with a larger tester group. This is the **core product-risk gate**: is ~2–4s collection acceptable for traders who want on-chain matching? Estimated completion: 16 weeks.

**Deliverables & measurement:**

- 20 unique wallets complete ≥5 trade cycles each (100+ settled trades)
- Post-test survey: ≥85% satisfaction on latency and order-status clarity (≥80% “acceptable for active trading”)
- API response < 150ms under peak load testing
- Iterate UX from feedback (countdown, fill clarity, cancel)

If testers reject the latency, re-evaluate `t_max` before Tranche 5 — before mainnet, not after.

**Budget:**

- Expanded beta onboarding — $2,500
- Incentive pool for short-batch trading — $2,000
- Survey and feedback analysis — $1,500
- **Tranche 4 total — $6,000**

### Tranche 5 — Hardening & Verification ($12,000)

**Goal:** Align live leftovers with the locked architecture, prove DFBA invariants, and make insurance inventory observable. Matching stays frozen. Estimated completion: 20 weeks.

**Deliverables & measurement:**

- Maker fee live = 0 bps (locked spec; retire leftover −2 rebate on init)
- Funding live = `clamp(((mark − index) / index) × k, ±max)`; skip when `!mark_valid` or index stale (retire leftover SMA-of-book)
- First `!mark_valid` settle carries last mid for **display only** — never seed mark from book/oracle
- Insurance base/quote inventory visible; optimizer tiebreaker prefers rebalancing; indexer `/insurance`
- Formal `BatchCleared` / `Fill` program events (or equivalent indexer-stable log schema)
- Index publisher keeper posting a fresh funding index (design: multi-venue; live may start as admin/keeper push)
- Kani proofs with 0 unresolved critical findings on: conservation; no over-withdrawal; makers only match takers; uniform-price bound; self-trade skip; `mark_valid` ⇒ both auctions cleared

Toxic-taker scoring (flow-quality spread widening) stays **deferred**. v1 defense is DFBA structure + taker fees + immediate cancel. Do not change matching to fund this tranche.

**Budget:**

- Spec alignment (fees, funding, mark display) and formal events — $4,000
- Insurance inventory + indexer — $3,500
- Kani DFBA invariant proofs — $3,000
- Docs, SDK, architecture sync — $1,500
- **Tranche 5 total — $12,000**

### Readiness Preparation (Unfunded)

Final step before public mainnet: (a) independent third-party security review of all three programs, (b) latency assumption validated in Tranche 4. Audit cost ($25K–$40K for this Pinocchio scope) is outside the $50K grant.

- Independent review (candidates: Sec3, OtterSec, Neodyme, Zellic). No mainnet without a public report; all critical/high findings remediated and reverified
- Squads multisig (3-of-5) for upgrade, pause, and governance
- Mainnet deploy (post-audit, post-multisig)
- Mainnet keepers — batch crank + liquidator + index publisher — multi-region VPS (**no relayer**)
- Production frontend polish
- DEX aggregator outreach (2+ integrations)
- $100K cumulative trading volume within 30 days of mainnet

**Deliverable:** Audit procurement plan, multisig setup, governance docs, deploy runbook. Mainnet deploy itself is post-grant.

---

## Milestones & Tranches

| Phase | Budget | Business milestone | KPI |
|---|---|---|---|
| 1 | $12,000 | Trading infrastructure & workflow | Full cycle: deposit, `PostOrder`, clear, settle, withdraw; crank 24/7 |
| 2 | $10,000 | QA & first beta | ≥10 unique wallets; ≥80% UX feedback; liquidator 24/7 |
| 3 | $10,000 | Short-batch performance | p50 < 4s, p99 < 8s post-to-settle; crank ≥95%; cap-64 CU measured |
| 4 | $6,000 | Short-batch beta | 20 testers × ≥5 cycles; ≥80% accept latency |
| 5 | $12,000 | Hardening & proofs | Spec leftovers closed; `/insurance` live; 6 Kani proofs pass |
| 6 | $0 (post-grant) | Mainnet readiness | Audit engagement; Squads; runbook |

**Grant total: $50,000** (Tranches 1–5). Tranche 6 is not grant-funded.

---

## Keepers

Execution is on-chain. The protocol still needs maintenance. Three open-source keepers are built across the tranches:

| Keeper | Built in | Role |
|---|---|---|
| **Batch crank** | Tranche 1 | `close_collecting` → `clear_batch` → `settle_batch` |
| **Liquidator** | Tranche 2 | `liquidate_user` only when on-chain `mark_valid` |
| **Index publisher** | Tranche 5 | Keep the funding index fresh; stale index skips funding |

Every role is permissionless. Devnet VPS cost across all phases (~$1K) is folded into the tranches. **There is no reveal relayer** — `PostOrder` is one user-signed transaction.

---

## Go-to-market

**Stage 1 — Public devnet (Tranche 2).** Open devnet before shortening the window. Recruit 5–10 testers via MadToast, Solana Hacker Houses, Discord/Reddit, and demo videos. Goal: full deposit → post → fill → settle → withdraw.

**Stage 2 — Short-batch beta (Tranche 4).** Invite Stage 1 testers back plus new ones (10–20 total). Each completes ≥5 cycles on the short window. Structured feedback on latency and order-status clarity. Core product-risk gate.

**Stage 3 — Coordinated mainnet (Tranche 6, post-grant).** Two weeks before mainnet: publish the audit, open-source the production frontend, announce partners. Launch markets: SOL-PERP, BTC-PERP, ETH-PERP.

**Stage 4 — Genesis trading campaign (post-mainnet, post-grant).** 90-day incentives from protocol revenue: maker incentives, leaderboard, competitions.

**Stage 5 — Aggregator + wallets.** 2+ aggregator listings within 30 days of mainnet; Phantom/Solflare deep links; SDK on npm.

---

## Adoption metrics

| KPI | Target | When |
|---|---|---|
| Beta testers (devnet) | 10–20 by end of Tranche 4 | Unique addresses completing trade cycles |
| Cumulative trading volume | $1M within 60 days of mainnet | On-chain settlement |
| Daily active traders | 50+ within 30 days of mainnet | Unique addresses with settled trades |
| TVL | $50K within 30 days | Vault balances |
| DEX aggregator integrations | 2+ | Referral or on-chain evidence |
| Keeper network | 3+ independent keepers | Distinct crank/liquidator/index operators |

**Core product-risk assumption:** a ~2–4s Dual Flow Batch Auction window is acceptable for traders who want on-chain matching. Validated in Tranche 2 (long window) and Tranche 4 (short window) before mainnet.

---

## Long-term impact

mgk is a reusable primitive for sequencer-free execution on Solana. Dual Flow Batch Auction — dual uniform clears, rest with role preserved, custody isolated from matching — transfers to other venues that still rely on private matching engines: options, RFQ replacements, and periodic auctions.

Ecosystem impact beyond mgk:

- Proves fully on-chain matching with persistent depth is viable without a sequencer
- Publishes a Dual Flow Batch Auction template other Solana protocols can adopt (not commit-reveal, not shuffle, not GLP)
- Kani proofs on perps invariants raise the bar for Solana DeFi correctness
- Every keeper role is open-source, distributing operation across the community

---

## Why $50K

$50,000 funds **devnet validation** through Tranches 1–5, not mainnet. Mainnet is gated on an independent review whose cost exceeds this grant. We will not launch publicly until that review is complete. Tranche 6 is the explicit roadmap from grant-end to commercial launch.

This budget moves mgk from “M9 programs deployed, Dual Flow Batch Auction live on devnet” to “beta-validated short-batch venue, leftovers aligned to spec, invariants machine-checked, keepers operational — ready to procure an audit.”

---

## Team

mgk Protocol is led by Kyler, founder of Mangekyou Labs.

**Kyler Nguyen (Lead Engineer)** — architecture, all on-chain programs (Rust + Pinocchio), indexer, frontend integration, keeper infrastructure.

**Proof of work:** Built Oreka (prediction market, shared liquidity on ICP), Kamui (first elliptic curve VRF on Solana), and contributed to ZK development on Solana. This repo: three M9 programs on devnet, public DFBA architecture, lifecycle and crate tests, live frontend.

---

## How to verify

- **Repo:** https://github.com/mangekyou-labs/mgk-solana
- **Architecture:** [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md)
- **Design:** [`docs/ai/design/feature-onchain-perps-dex.md`](../design/feature-onchain-perps-dex.md)
- **M9 deploy record:** [`docs/ai/deployment/2026-08-06-devnet-deploy-m9.md`](../deployment/2026-08-06-devnet-deploy-m9.md)
- **Core:** https://explorer.solana.com/address/C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx?cluster=devnet
- **Matcher:** https://explorer.solana.com/address/7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC?cluster=devnet
- **Oracle:** https://explorer.solana.com/address/CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ?cluster=devnet
- **Tests:** `cargo test --all-features` · `cargo clippy --all-targets --all-features -- -D warnings` · `cargo build-sbf`
