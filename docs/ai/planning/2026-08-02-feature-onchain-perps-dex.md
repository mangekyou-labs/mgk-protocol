---
phase: planning
title: On-Chain Perps DEX — DFBA Migration Plan
description: Task plan to migrate matching from commit-reveal CLOB to pure Dual Flow Batch Auction (DFBA). Supersedes active matching work in the historical commit-reveal plan.
status: in-progress
feature: onchain-perps-dex
requirements: docs/ai/requirements/2026-06-18-feature-onchain-perps-dex.md
design: docs/ai/design/feature-onchain-perps-dex.md
created: 2026-08-02
updated: 2026-08-24
---

# On-Chain Perps DEX — DFBA Migration Plan

## Context

**v1 matching is pure DFBA** (requirements + design, 2026-08-02). Commit-reveal, Fisher-Yates shuffle, structural priority queues, and the reveal relayer are out of scope.

> **Phase 7 reconciliation (2026-08-24):** M9.9's independent-wallet browser
> execution proof is complete. References below that say it is pending,
> unproven, or blocked are dated 2026-08-21 historical RPC-stop checkpoints,
> not current task state. The full implementation is nevertheless **not
> aligned**: C1–C6 and M1–M12 in
> `docs/ai/implementation/2026-08-24-feature-onchain-perps-dex.md` reopen the
> Execute Plan. A finalized transaction proves execution, not protocol safety
> or requirements conformance.

**Already shipped (historical M1–M8 + M9 DFBA core + Phase 5 hardening):**

| Area | Status | DFBA action |
|------|--------|-------------|
| Oracle / multi-venue index path | Done (admin fallback) | Index for funding ✅ T9.4.4; mark from DFBA only ✅ T9.4.3 |
| Portfolio, vault, deposit/withdraw | Done | Keep |
| Liquidation optimizer, insurance, ADL | Done (some simplifications) | **Gate on batch `mark_valid`** ✅ T9.4.1 |
| Commit/reveal/batch lifecycle | Replaced | Collecting(Committing) → Clearing → Settled + PostOrder |
| Matcher DFBA dual auction | Done | disc 5 `DfbaClear`; host + BPF e2e |
| Cancel/modify resting | Done | Works with `is_maker` flag |
| Pause flags | Done ✅ | Post gated by `PAUSE_POST`; Clear gated by `PAUSE_CLEAR`; T9.4.2 complete |
| Frontend PostOrder | **Partial — reliability follow-up open** | `encodePostOrder` + maker toggle are wired; wallet/chart hydration, truthful DFBA state copy, and stable polling are tracked in M9.8 |
| Testing / e2e | Host DFBA ✅; BPF 7/11 | Dual fill + one-sided + resting + self-trade + cancel + …; 4 `#[ignore]` CU harness-only |
| Devnet dual-fill | Done ✅ (scripted + browser personas) | M9.9 Batch 19 proves the independent-wallet browser execution path; Phase 7 found accounting and safety defects in that path |
| Keeper crank | Done ✅ | `tools/keeper-crank.js` — CloseCollecting → ClearBatch → SettleBatch loop |
| Independent-counterparty live match | **Execution verified 2026-08-24** | Named maker/taker sessions posted four Batch 19 orders and observed finalized Close → Clear → Settle; this does not close Phase 7 defects |
| Playwright web e2e | Baseline + M9.9 live proof done | `pnpm e2e:wallet` remains mocked construction; named playwright-cli personas are the live proof path |
| Legacy test cleanup | Done ✅ | 5 commit-reveal e2e tests rewritten with DFBA PostOrder pattern |

**Programs:** `perps-core`, `perps-matcher`, `mgk-oracle`, `mgk-common` (Pinocchio, single-byte discs).

**Non-goals in this plan:** matching rewrite (`compute_clearing` / `allocate_side`); cloning Pinocchio toy DFBA; GLP / LP-as-counterparty; Playwright MCP as a QA gate; Phantom-extension popups as the matching-proof harness; full frontend redesign; grant/`ARCHITECTURE.md` rewrite; toxic-taker scoring; multi-ix sub-batching; off-chain solver.

## Design parameters (locked — implement as defaults)

| ID | Value | Code notes |
|----|--------|------------|
| D1 | Stress `1/2/4` slots; **live working-devnet** `t_min=2`, `t_max=150`, `n_min=1` | Do not retune live to 1.6s for personas. SetBatchParams (disc 21) ✅ T9.3.5 |
| D2 | `per_batch_order_cap=64` (scratch max 128) | Locked contract; host timing exists, but selection semantics and on-chain CU proof are reopened by M1 |
| D3 | `taker_fee_bps=5`, makers **0 bps** | Live instrument still has leftover `makerFeeBps=-2`. Do not treat −2 as locked. Retune is M9.10, not the persona slice |
| D4 | Round-down dust to protocol | Allocation path |
| D5 | Collecting → Clearing → Settled | Committing alias for Collecting |
| D6 | Mark valid only on current dual clear | ClearBatch + SettleBatch |
| D7 | Funding mark vs index; skip if invalid/stale | **Reopened by Phase 7:** old SMA remains and slot/Unix freshness comparison is invalid |
| D8 | Overflow: best price → size → order_id | `select_by_price_priority` |
| D9 | `BatchCleared` + `Fill` events | Indexer path partial; formal events TBD |
| D10 | Retire commit/reveal; rewrite matcher clear | Commit/Reveal return InvalidInstruction |

## Milestones

### M9.0 — Prep & contracts
**Goal:** Shared types and invariants before code churn.

- [x] **T9.0.1** Spec wire format for flat clear pack ✅  
- [x] **T9.0.2** Batch DFBA fields + Collecting==Committing ✅  
- [x] **T9.0.3** Error codes for DFBA ✅ 2026-08-06
  - **Outcome:** `DfbaCapExceeded=603`, `MarkInvalidForLiquidation=604`, `BatchNotSettled=605` in MgkError. LiquidateUser now uses specific codes instead of generic `InvalidInstruction`/`OperationPaused`.
  - **Tests:** T-ERROR-MAP (pin test for all 3 discriminators)

### M9.1 — Matcher DFBA core (implemented; Phase 7 corrections open)

- [x] **T9.1.1** `compute_clearing` ✅  
- [x] **T9.1.2** `compute_allocation` ✅  
- [ ] **T9.1.3** Self-trade filter — implementation exists; eligibility ordering and pre-STP totals reopened by C4/M2
- [ ] **T9.1.4** Cap selection / overflow — implementation exists; global cap/priority semantics reopened by M1
- [x] **T9.1.5** `DfbaClear` disc 5 ✅ book collect + sequential bid/ask heap path  
- [x] **T9.1.6** Stack / scratch discipline ✅ fits default 32KB heap  
- [x] **T9.1.7** CU spike at cap=64 (and 32/128) ✅ 2026-08-06
  - **Outcome:** Host benchmarks: cap 128 × 1000 iters <10ms; efficient O(n log n).
  - **Tests:** T-CU-32, T-CU-64, T-CU-128, T-CU-OVERFLOW in `dfba.rs`

### M9.2 — Book + PostOrder path (implemented; Phase 7 corrections open)

- [x] **T9.2.1** RestingOrder / LimitOrder `is_maker` ✅  
- [ ] **T9.2.2** Core `PostOrder` disc 20 + matcher `PlaceResting` disc 6 — wire exists; account/risk validation and reusable capacity reopened by C3/C5
  - Also: increments `batch.total_commitments`; batch account writable  
- [x] **T9.2.3** CommitOrder / RevealOrder retired ✅  
- [x] **T9.2.4** Cancel/modify with role flag ✅  

### M9.3 — Batch lifecycle rewrite (implemented; Phase 7 corrections open)

- [x] **T9.3.1** Batch DFBA fields ✅ size 160 pinned  
- [x] **T9.3.2** Close → Clearing (skip reveal) ✅  
- [ ] **T9.3.3** ClearBatch CPI DfbaClear (book collect) — CPI exists; account binding and cap propagation reopened by C2/M1
- [ ] **T9.3.4** Settle dual mark + DFBA fill apply + fees — path exists; trusted inputs, portfolio coverage, accounting, and arithmetic reopened by C1/C6/M3–M5
  - Instrument init `#[repr(C)]` fee offsets fixed (taker@52, maker@54, mark@136)  
- [x] **T9.3.5** `SetBatchParams` governance ✅ 2026-08-06
  - **Outcome:** disc 21; updates `max_orders_per_batch`, `marginal_size_cap`, `t_min_slots`, `t_max_slots`, `n_min` on Registry. Governance signer required.
  - **Wire:** `max_orders(1) + marginal_cap(1) + t_min(8) + t_max(8) + n_min(4)` = 22 bytes
  - **Tests:** T-BATCH-PARAMS (defaults, writes, marginal_cap_zero, size_unchanged)

### M9.4 — Risk, pause, oracle role (partially aligned; Phase 7 corrections open)

- [x] **T9.4.0** Funding skip when `!mark_valid` (and `funding_paused`) ✅  
- [x] **T9.4.1** LiquidateUser requires settled batch `mark_valid` / !`liq_paused` ✅  
  - Account list: + batch after liquidator; SDK docs updated  
- [x] **T9.4.2** Pause flags: post + clear; remove reveal coupling ✅ 2026-08-06
  - **Outcome:** `PAUSE_POST=1<<4` blocks PostOrder; `PAUSE_CLEAR=1<<5` blocks CloseCollecting+ClearBatch; PAUSE_TRADING umbrella retained.
  - **Tests:** T-PAUSE-POST, T-PAUSE-CLEAR, T-PAUSE-BITS, T-PAUSE-RESERVED
- [ ] **T9.4.3** Mark path: no oracle blend — current dual-mid branch exists; first-invalid-batch seed and pre-STP totals reopened by C4/M3
  - **Outcome:** ClearBatch computes dual mid; SettleBatch uses pure dual mid when mark_valid; oracle for funding index only.
  - **Validation:** `clear_batch.rs:142` dual mid; `settle_batch.rs:616` mark_valid branch
  - **Tests:** T-MARK-NO-ORACLE covered by existing lifecycle/dual tests
- [ ] **T9.4.4** Index freshness for funding only — check exists; owner/instrument binding and time-domain comparison reopened by C1/M3
  - **Outcome:** `read_oracle_price` now returns `(price, timestamp, is_active)`. Funding accrual skips when oracle is stale (>600s) or inactive. Mark path unaffected (pure DFBA).
  - **Tests:** T-INDEX-FUNDING covered by existing funding_skip tests
- [x] **T9.4.5** Insurance inventory fields ✅ 2026-08-06 (already implemented)
  - **Outcome:** `Vault.insurance_fund` (u128) credited from taker fees + slashed deposits; `uncovered_bad_debt` (u128) tracks insurance shortfall; `adl_debt`/`adl_pending` for ADL tracking.
  - **Validation:** `settle_batch.rs:535-575` fee/rebate flow; `vault.rs` struct + helpers
  - **Tests:** Existing vault + settle tests cover insurance flow

### M9.5 — Tests, e2e, docs hygiene (suites pass; adversarial coverage open)

- [x] **T9.5.1** DFBA testing doc ✅  
- [x] **T9.5.2** Matcher suite green ✅ ~110 tests  
- [x] **T9.5.3** Lifecycle unit sims (dual / one-sided / self-trade) ✅ host  
- [x] **T9.5.4** BPF e2e dual fill + fees ✅ `test_e2e_full_lifecycle_with_fill`  
- [x] **T9.5.5a** BPF e2e one-sided liq pause ✅ `test_e2e_dfba_one_sided_liq_paused`  
- [x] **T9.5.5b** BPF e2e rest across batch with role ✅ 2026-08-06
- [x] **T9.5.5c** BPF e2e self-trade (optional; host covered) ✅ 2026-08-06
- [x] **T9.5.5d** BPF e2e cancel between batches ✅ 2026-08-06
- [x] **T9.5.6** Implementation notes ✅ `docs/ai/implementation/2026-08-02-feature-onchain-perps-dex-dfba.md`  
- [x] **T9.5.7** Frontend minimal PostOrder UI ✅ (trade page + form maker toggle)  

### M9.6 — Indexer + SDK (implemented; contract/correctness corrections open)

- [ ] **T9.6.1** DFBA results + batch decode — partial decoder/ingestion path exists; SDK layout drift and historical attribution reopened by M6/M7
- [ ] **T9.6.2** SDK encoders + keeper DFBA crank — PostOrder/keeper path exists; missing interfaces, portfolio discovery, and confirmation reopened by C6/M6/M11

### M9.7 — Explicitly deferred (not blocking M9 DoD)

- Full frontend UX / mark_valid display polish (M9 config + PostOrder path + Collecting labels **done**; polish remains)
- Grant proposal + public ARCHITECTURE rewrite  
- Toxic-taker scoring  
- Multi-ix sub-batch deep books  
- Raising cap above CU-proven value  
- Formal on-chain `BatchCleared` event IDL  
- Interactive Phantom-extension smoke remains optional UX (not the matching-proof gate)
- Security review before mainnet
- Feature-named deployment/monitoring docs (lint paths)

### M9.8 — Frontend reliability + truthful DFBA state (reopened 2026-08-08)

**Status:** In progress. This milestone captures user-observed frontend regressions after M9 deployment. The Positions/Portfolio refresh issue is intentionally **untriaged in this planning phase**; no root cause is assigned here.

| Task | Status | Outcome / scope | Dependencies | Validation / linked scenarios |
|------|--------|-----------------|--------------|-------------------------------|
| **T9.8.1 Browser-origin hydration + wallet/chart interactivity** | In progress | `/trade` hydrates at `localhost` and `127.0.0.1` under **playwright-cli**; Select Wallet opens; injected or installed wallets are detected; chart controls respond. Playwright MCP is not the regression gate | Next.js dev-origin config, wallet adapter, chart component | T-WEB-ORIGIN-HYDRATION, T-WEB-WALLET-MODAL |
| **T9.8.2 Truthful DFBA state language** | Implemented — lifecycle follow-up open | Header and status bar now share `describeBatchPhase`; below-`n_min` batches say `Orders open · Waiting for minimum flow`, eligible batches say `Ready to clear · Waiting for keeper` | Batch decoder, current-slot polling, keeper semantics | T-WEB-DFBA-STATE-COPY ✅; keeper freshness remains T9.8.6 |
| **T9.8.3 Chart loading/error/retry affordance** | Not started | Avoid a blank chart region while the provider script loads or fails; preserve surrounding trade controls and offer an explicit retry | T9.8.1, TradingView script boundary | T-WEB-CHART-STATE |
| **T9.8.4 Full deterministic DFBA playwright-cli lifecycle** | Partial — one-wallet live smoke only | Historical Playwright MCP one-wallet PostOrder/GTC is not a fill proof. After M9.9, reuse persona sessions for the complete visible Collecting → Clearing → Settled journey. Deterministic no-extension construction remains `pnpm e2e:wallet` | T9.9.1 harness, T9.8.1–3, mutable mocked RPC/batch fixture | T-WEB-LIVE-POST historical; T-WEB-DFBA-LIFECYCLE, T-WEB-PERSONA-MATCH |
| **T9.8.5 Positions/Portfolio visual stability** | Implemented | Existing portfolio data stays rendered during background polling; initial load still skeletons and ready panels expose `data-refreshing` | Positions/Portfolio query and store ownership | T-WEB-POLL-STABILITY ✅ |
| **T9.8.6 Keeper-lag visibility** | Partial | Minimum-flow vs keeper-waiting intent is visible; indexer freshness/last transition telemetry remains | T9.8.2, indexer/monitoring health data | T-KEEPER-LAG-INTENT partial |
| **T9.8.7 Retire remaining legacy web affordances** | Not started | Remove commit/reveal/slashed-flow assumptions from active trade UI and browser tests; historical docs may retain them for audit only | T9.8.2, T9.8.4 | T-NO-LEGACY-WEB-FLOW |

#### Approved state copy contract

| On-chain condition | Headline | Intent/detail |
|--------------------|----------|---------------|
| Collecting before deadline | Orders open | Dual auction in `HH:MM:SS` |
| Collecting at/after deadline, posts < `n_min` | Orders open | Waiting for minimum flow (`posts`/`n_min`) |
| Collecting at/after deadline, posts ≥ `n_min` | Ready to clear | Waiting for keeper |
| Clearing | Orders closed | Matching maker and taker flow at uniform prices |
| Settled with valid mark | Fills settled | Mark updated |
| Settled without a two-sided match | No two-sided match | Mark unchanged · Liquidations paused |

`current_slot >= commit_deadline_slot` means the batch is eligible for permissionless `CloseCollecting`; it does **not** mean the UI should keep presenting an open collection window. The chain remains in Collecting until a keeper submits the transition, so client copy must communicate both facts.

### M9.9 — Independent-counterparty matching proof (completed 2026-08-24)

**Status:** Completed. Single-provider serialized Playwright named-session workflow completed on QuickNode Primary RPC without HTTP 429s or confirmation timeouts. Pinned Batch 19 (`DuhAF1kA...`) received all 4 role-aware orders from Maker (`6LZP...`) and Taker (`BeBT...`). One-shot keeper crank executed Close, Clear, and Settle. Matcher results account `CYZnXvC4...` confirmed 10,000 matched bid / 10,000 matched ask, uniform prices $0.05 / $85.00, `mark_valid=1`, `liq_paused=0`, dual-mid clearing price $42.525. Indexer backfilled fills for both users, and both named browser sessions observed settled state and final portfolios.

| Task | Status | Outcome / scope | Dependencies | Validation / linked scenarios |
|------|--------|-----------------|--------------|-------------------------------|
| **T9.9.1 Persona harness and funding** | Done | Two named playwright-cli sessions with isolated storage; live-signing injected wallets from distinct funded keypairs; QuickNode primary selected via objective 3-part qualification gate (6/6 reads, 60s load @ 4.81 req/s 0 errors, signed devnet probe); clean proof keypairs; secret-free artifacts. | Devnet SOL, live M9 programs, RPC/indexer, playwright-cli `0.1.x`, local `/trade` | T-WEB-PERSONA-SETUP, T-WEB-TWO-WALLET-SETUP ✅ |
| **T9.9.2 Same-batch opposing PostOrders via UI** | Done | Pinned Batch 19 (`DuhAF1kA...`); Maker Buy ($0.05) & Maker Sell ($85.00) submitted via `-s=maker` (book slots 39, 40); Taker Sell ($0.05) & Taker Buy ($85.00) submitted via `-s=taker` (book slots 41, 42). All 4 confirmed on-chain in Collecting phase without third-party interference. | T9.9.1; usable RPC/indexer; open Collecting batch; collateral | T-WEB-PERSONA-POST, T-WEB-TWO-WALLET-POST ✅ |
| **T9.9.3 Clear/settle and both UIs observe** | Done | Crank CloseCollecting (`5EPWEA3q...`) → DfbaClear (`5t4LPoaH...`) → SettleBatch (`4apD1UuM...`). Results account `CYZnXvC4...` confirmed 10,000 matched on bid and ask, uniform prices $0.05 / $85.00, `mark_valid=1`, `liq_paused=0`. Indexer backfill fixed for multi-fill single-tx and v0 ALT blocks; REST API and browser UIs verified settled state, fills, and final portfolio flat net position. | T9.9.2, keeper crank, usable RPC/indexer | T-WEB-PERSONA-MATCH, T-WEB-TWO-WALLET-MATCH ✅ |
| **T9.9.4 Deterministic two-user regression** | Implemented and SBF-evidenced (2026-08-21) | Fixed-seed distinct maker/taker fixture asserts both allocations, fee/rebate + insurance flow, flat net position deltas, settled `mark_valid=1`, and rejects unexpected fill owners. Existing active matcher self-trade tests remain the focused regression. | Existing DFBA fixtures; implemented independently while T9.9.3 remains pending | T-E2E-TWO-USER-FILL ✅ |
| **T9.9.5 Discrepancy diagnosis and repeat** | Not required / Completed | On-chain live results matched deterministic fixture exactly (uniform clearing prices, dual-mid, 100% two-persona fills, mark_valid=1). No matcher or protocol changes needed. | T9.9.3–4 | T-WEB-PERSONA-MATCH, T-E2E-TWO-USER-FILL ✅ |

#### T9.9.1 operator sketch (implementation, not done)

```sh
# Isolated personas (never omit -s= once both are open)
playwright-cli -s=maker open http://localhost:3000/trade
playwright-cli -s=taker open http://localhost:3000/trade
# optional: playwright-cli -s=observer open http://localhost:3000/trade

playwright-cli -s=maker snapshot
playwright-cli -s=taker snapshot
# inject live-signing wallet per session (keypair path in; pubkey only in page)
# click existing testids: order-form-side-buy/sell, order-form-checkbox-input-post-as-maker,
#   order-form-price-input, order-form-qty-input, order-form-submit-buy/sell
# confirm both UIs show the same Collecting batch_id before posting
# crank: node tools/keeper-crank.js
# observe fills / mark_valid on both sessions
playwright-cli close-all
```

#### Historical failed-RPC checkpoint (2026-08-21; superseded for M9.9 proof)

- `node --test tools/lib/liveSigning.test.cjs`: **8 passed**. The helper loads
  keypairs by path, signs through a fake connection, and keeps secret material
  out of the page-facing provider.
- `node --test tools/cli-live-signer-bridge.test.cjs` (loopback bridge,
  escalated local-listener run): **1 passed**. The bridge exposes only public
  persona metadata and live `sign` / `sign-and-send` operations.
- `node tools/persona-fund.js`: **PASS** for distinct maker/taker pubkeys and
  portfolio initialization; maker deposit completed and the taker already had
  portfolio funding state. The named sessions
  `playwright-cli -s=maker` and `playwright-cli -s=taker` showed different
  wallet pubkeys on Online/Devnet. Secret scans of
  `.playwright-cli/maker-live-isolation.yaml` and
  `.playwright-cli/taker-live-isolation.yaml` were clean.
- **Stop condition reached:** `playwright-cli -s=taker console error` recorded
  193 errors with repeated authenticated Helius devnet HTTP `429` responses;
  the live batch/book reads were not reliable. T9.9.2–3 were therefore not
  attempted. Resume requires a usable private RPC quota/endpoint; do not
  retune the matcher to work around this infrastructure condition.

Deliverables for T9.9.1: live-signing inject helper (keypair path in, no secret out of snapshots/traces/screenshots); fund/init script or documented reuse of `tools/trade-e2e.js` (`loadOrCreateTrader('maker'|'taker')`); short operator runbook in the testing doc; confirmation that `-s=maker` and `-s=taker` do not share `localStorage` / wallet pubkey. No `qa:cli` script exists yet — T9.9.1 may add a thin `tools/` wrapper; raw `playwright-cli -s=` is the gate.

### M9.10 — Working-devnet follow-on (after M9.9; not this slice)

The persona fill is proven. These tasks remain subordinate to the Phase 7
critical corrections; do not treat the live fill as an alignment gate.

| Task | Status | Outcome |
|------|--------|---------|
| **T9.10.1 Retune maker fee to 0 bps** | Not started | Live instrument `makerFeeBps=0`; taker 5 stays. Leftover −2 is not the locked D3 |
| **T9.10.2 24/7 keeper + liquidator** | Not started | Always-on crank/liq on current M9 IDs with health/alerts; live underwater-portfolio proof |
| **T9.10.3 Index keeper reliability** | Not started | Multi-venue index posts stay fresh enough for funding skip to be honest |
| **T9.10.4 Indexer health / lag** | Implemented; correctness reopened | The state model and UI exist and 87 indexer + 492 web tests pass, but reconciliation is recorded before chunk success, backfill metadata is not driven, and health can report a false boundary (M8) |
| **T9.10.5 Replace SMA funding with D7 `f(mark − index)`** | Not started | Should-do; skip-when-invalid already shipped |
| **T9.10.6 Stop first-batch book/oracle mark seed** | Not started | Should-do |
| **T9.10.7 Reduce-only / flatten UX + paper fill-lot tests** | Not started | Should-do; fill-lot 100/400 and 100/250/50 are a test gap, not an algorithm gap |

### M9.11 — Public devnet release (PR #1 merged 2026-08-24; Vercel recovery in progress)

PR #1 squash-merged `4e7e8cf` to `master` while all three Vercel deployment
checks were failing. CI workflows targeted `main`/`develop`, not `master`.
This milestone tracks recovery: valid Vercel config, CI triggers, preview
recovery, and eventual production promote.

| Task | Status | Outcome |
|------|--------|---------|
| **T9.11.1–11 DFBA public devnet release** | Done (squash `4e7e8cf`) | Indexer read-only, wallet-funded disc 19, keeper/oracle workers, Render blueprint, Vercel config |
| **T9.11.8b Vercel schema + project recovery** | **Done** | `vercel.json` removed illegal `engines`/`env` and added `$schema`. Node 22 pinned via `package.json`. TDD: `tools/vercel-json.test.js` (4/4 pass). CI workflows retargeted to `master`. PR #2 verified with green Preview (`mgk-frontend-2k48aq9fa...` Ready). |
| **T9.11.12 Post-merge Render + Vercel promote** | **Done (Frontend promoted to production)** | Merged PR #2 (`25951f3`) to `master` with 100% green checks. Production deployment `mgk-frontend-6f28agyei...` is Ready. SSO Deployment Protection disabled for public access. Production URL `https://mgk-frontend.vercel.app/trade` live. Render worker deployment and oracle authority rotation noted as follow-up. |
| **T9.11.13 Smoke validation** | Done (Frontend live smoke) | `https://mgk-frontend.vercel.app/trade` verified live with clean layout, Devnet indicator, non-SSO public access, and indexer connection. |
| **Incident P0: CI `master` triggers** | Done | `verify.yml` + `mgk-frontend-ci.yml` merged to `master` and verified green in CI |
| **Incident P0: GitHub branch protection** | Document only | Not enabled without explicit user request |

### Phase 7 reopened Execute Plan tasks

The earlier checkmarks record implementation history. The following rows are
the current completion gates and take precedence over historical milestone and
session tables.

| Priority | Reopened task | Findings closed when complete |
|----------|---------------|-------------------------------|
| P0 | Bind and validate every core/matcher CPI and settlement account; make result provenance immutable and batch-specific | C1, C2 |
| P0 | Enforce PostOrder instrument/book/program identity, collateral/margin, reduce-only, tick/lot, and checked counters | C3 |
| P0 | Compute matched totals after eligibility and self-trade prevention | C4 |
| P0 | Reclaim or compact terminal resting-order slots | C5 |
| P0 | Discover and pass every DFBA fill portfolio during production settlement; fail closed on omissions | C6 |
| P1 | Implement global cap-64 selection from scratch-128 using locked priority; propagate registry params | M1 |
| P1 | Correct self-trade eligibility ordering, pure current-batch mark/funding, oracle time/binding, fill accounting, and checked arithmetic | M2–M5 |
| P1 | Reconcile Rust/TypeScript interfaces, historical indexer ingestion, and health-state truthfulness | M6–M8 |
| P1 | Bind web batch resolution, constrain the signer bridge, confirm keeper signatures, and retune maker fees | M9–M12 |
| P2 | Add the adversarial and integration tests listed in the Phase 7 implementation record | Test gaps |

## Sequencing

```text
M9.0–M9.3 core path ── DONE
M9.4 risk/oracle ──── DONE (T9.4.0–5)
M9.5 e2e ──────────── DONE (4 BPF tests ignored = program-test CU harness only)
M9.6 consumers ────── DONE
M9.7 deferred ─────── Frontend polish + grant/ARCHITECTURE + toxic-taker + multi-ix + formal events
Post-M9 ops ───────── Devnet dual-fill + frontend M9 wire + mocked Playwright wallet flow DONE
M9.8 frontend ─────── IN PROGRESS after M9.9: origin/chart/lifecycle polish on the persona harness
M9.9 matching proof ─ EXECUTION PROOF DONE 2026-08-24; Phase 7 correctness findings remain
Phase 7 alignment ─── NOT ALIGNED; Execute Plan C1–C6 then M1–M12
M9.10 working-devnet ─ T9.10.4 implemented but health correctness reopened; T9.10.1–3,5–7 remain
M9.11 release ─────── T9.11.1–11 squash merged; T9.11.8b Vercel recovery in progress; T9.11.12–13 blocked
```

**Critical path remaining:** repair and adversarially test Phase 7 findings
C1–C6 first, then M1–M12. M9.9 is closed as an execution-evidence milestone,
not as an implementation-correctness gate. After alignment, run `dev-testing`
then `dev-review`. Security review remains mandatory before mainnet.

## Test scenario → task map

| Scenario ID | Description | Task(s) | Status |
|-------------|-------------|---------|--------|
| T-DFBA-* core | Uniform dual auction math | T9.1.* | ✅ |
| T-POST-ORDER | Single-tx post | T9.2.2 | ✅ |
| T-NO-COMMIT-REVEAL | Old path dead | T9.2.3 | ✅ |
| T-E2E-DFBA-FILL | Dual fill + fees | T9.5.4 | ✅ |
| T-E2E-LIQ-PAUSE | One-sided mark invalid | T9.5.5a | ✅ |
| T-E2E-REST | Rest across batch | T9.5.5b | ✅ |
| T-E2E-SELF | Self-trade no fill | T9.5.5c | ✅ |
| T-E2E-CANCEL | Cancel resting | T9.5.5d | ✅ |
| T-LIQ-MARK-GATE | Liq needs mark_valid | T9.4.1 | ✅ |
| T-FUNDING-SKIP | Skip if !mark_valid | T9.4.0 | ✅ |
| T-PAUSE-* | Pause matrix | T9.4.2 | ✅ |
| T-MARK-NO-ORACLE | Pure dual mid | T9.4.3 | ✅ |
| T-DFBA-CU-GATE | CU at cap 64 | T9.1.7 | ✅ |
| T-BATCH-PARAMS | Governance params | T9.3.5 | ✅ |
| T-WEB-ORIGIN-HYDRATION | playwright-cli origin hydrates interactive controls | T9.8.1 | In progress |
| T-WEB-WALLET-MODAL | Wallet selector opens and detects injected or installed wallets | T9.8.1 | In progress |
| T-WEB-DFBA-STATE-COPY | Header/status bar explain every DFBA phase | T9.8.2 | In progress |
| T-WEB-CHART-STATE | Chart has loading, success, error, and retry states | T9.8.3 | Not started |
| T-WEB-DFBA-LIFECYCLE | Browser executes PostOrder and observes the complete DFBA lifecycle | T9.8.4 | Live Batch 19 execution observed; deterministic mutable-phase browser fixture remains open |
| T-WEB-PERSONA-SETUP | Named playwright-cli sessions as maker/taker with isolated live-signing wallets | T9.9.1 | Done; pubkey isolation, signing tests, funding/init, and secret-free artifacts evidenced |
| T-WEB-PERSONA-POST | Four dual-auction PostOrders through `/trade` in the same Collecting batch | T9.9.2 | Done in Batch 19 |
| T-WEB-PERSONA-MATCH | Crank + both UIs show fills, fees, positions, `mark_valid=1` | T9.9.3, T9.9.5 | Execution observed; accounting/correctness defects remain Phase 7 findings |
| T-WEB-TWO-WALLET-SETUP | Alias of T-WEB-PERSONA-SETUP (legacy ID kept) | T9.9.1 | Done; same evidence as persona setup |
| T-WEB-TWO-WALLET-POST | Alias of T-WEB-PERSONA-POST | T9.9.2 | Done in Batch 19 |
| T-WEB-TWO-WALLET-MATCH | Alias of T-WEB-PERSONA-MATCH | T9.9.3, T9.9.5 | Execution observed; correctness remains open under Phase 7 |
| T-E2E-TWO-USER-FILL | Deterministic distinct-user DFBA fill and allocation regression | T9.9.4, T9.9.5 | Passed against local SBF artifacts 2026-08-21 |
| T-WEB-POLL-STABILITY | Positions/Portfolio background refresh causes no panel flicker or state reset | T9.8.5 | Implemented |
| T-KEEPER-LAG-INTENT | Past-deadline Collecting state clearly says it is waiting for keeper | T9.8.2, T9.8.6 | In progress |
| T-NO-LEGACY-WEB-FLOW | Active trade UI/tests contain no commit/reveal/slashed journey | T9.8.7 | Not started |
| T-INDEXER-HEALTH-STATES | Health tracker warming→healthy→degraded→critical state machine | T9.10.4 | Unit-covered; integration truthfulness reopened by M8 |
| T-INDEXER-SLOT-LAG | Slot lag computed from lastReconciledSlot with boundary at 10/11 and 50/51 | T9.10.4 | Unit-covered; source boundary reopened by M8 |
| T-INDEXER-QUIET-MARKET | Reconciliation recorded even on empty blocks to prevent silent staleness | T9.10.4 | Unit-covered; record-after-commit ordering reopened by M8 |
| T-INDEXER-BACKFILL-META | Backfill metadata (state, slotsScanned, txsMatched, fillsInserted) | T9.10.4 | Tracker API covered; production updates reopened by M8 |
| T-WEB-HEALTH-STORE | Consecutive failure counting (reconnecting/unreachable), manual refresh, last-good | T9.10.4 | ✅ |
| T-WEB-STATUSBAR-HEALTH | 6-state visual indicator mapping (syncing/live/reconnecting/unreachable/delayed/critical) | T9.10.4 | ✅ |
| T-WEB-MARKETHEADER-STALE | Never-loaded (—) vs cached-but-stale (as of Xm ago) for OI and volume | T9.10.4 | ✅ |
| T-WEB-CHART-FILLS-LABEL | fills live / fills delayed / fills off based on health state | T9.10.4 | ✅ |
| T-VERCEL-JSON-SCHEMA | vercel.json only uses official schema keys; rejects engines/env | T9.11.8b | ✅ |

## Risks & blockers

| Risk | Status / mitigation |
|------|---------------------|
| Account layout Batch/Instrument | Batch size 160 pinned; instrument init offsets fixed 2026-08-03 |
| CU at cap 64 | Host benchmarks exist, but they are not on-chain CU evidence; keep an SBF/program-test CU assertion open |
| Stack overflow on clear | ✅ Mitigated: sequential dual clear + slim scratch |
| Mark often invalid on thin book | Product risk accepted; UI shows last mid / batch status |
| Legacy lifecycle e2es | ✅ Rewritten to DFBA PostOrder pattern |
| Deployment/monitoring docs | lint MISSING feature-named paths (deployment note exists: `2026-08-06-devnet-deploy-m9.md`) |
| Keeper crank | ✅ `tools/keeper-crank.js`; verified multi-batch Close→Clear→Settle on devnet |
| Book account size | Client keypair book (27 704 B); CPI CreateAccount 10KB cap — document ops path |
| Security review | Required before mainnet; `solana-fender-mcp` + QEDGen |
| RPC quota under concurrent polling | Historical providers throttled; Batch 19 later completed through the qualified primary. Preserve the earlier failures as operational history, not a current M9.9 blocker |
| Positions/Portfolio polling causes visible churn | P0 UX issue reported 2026-08-08; root cause deliberately not assigned during planning. Future implementation must reproduce and pin the behavior before choosing cache/store changes |
| Dev-origin hydration differs between `localhost` and `127.0.0.1` | Keep both origins in the browser regression matrix; do not treat a server-rendered screenshot as proof of client interactivity |
| Keeper lag is shown as an expired collection window | Use the approved Ready to clear / Waiting for keeper contract and add keeper freshness rather than implying orders remain open |
| Deterministic wallet test can pass without covering phase changes | Extend the mutable RPC fixture through the complete DFBA lifecycle; live installed-wallet detection is playwright-cli, not MCP |
| Independent-wallet execution can be mistaken for correctness | Batch 19 proves the two-persona lifecycle ran; C1–C6/M1–M12 show why that execution is not an alignment or safety proof |
| One buy vs one sell can leave `mark_valid=0` | T9.9.2 must post both auctions (maker two-sided quote + two crossing taker posts) |
| Crossed-book 76.55 / 0.10 prices will not clear | Choose crossing prices from the current book; do not reuse the 2026-08-09 smoke prices |
| Playwright MCP / Phantom popups used as the fill gate | Forbidden. MCP 2026-08-09 is historical UI wiring. Matching proof is playwright-cli named sessions + injected live-signing |
| Named sessions share storage or a pubkey | Always pass `-s=maker` / `-s=taker`; never omit `-s` once both are open; assert distinct pubkeys before posting |
| Key material in snapshots / traces | Load keypairs from disk paths; scan artifacts for secret key / seed / password |
| Helius throttling can obscure cross-surface evidence | Prefer Helius / indexer-backed reads; retain transaction/account snapshots for each lifecycle phase |

## Definition of done (M9)

| # | Criterion | Status |
|---|-----------|--------|
| 1 | `cargo test` / clippy clean | Partial: `+stable` passes; repository-default Solana Rust lacks cargo-clippy and cannot resolve current dependency MSRVs |
| 2 | `cargo build-sbf` no stack overflow | ✅ all four programs; one dead-code warning, no stack-offset overflow |
| 3 | E2E dual fill + rest across batch | Execution covered, but account substitution, missing portfolios, and double accounting remain open |
| 4 | Uniform price + role + self-trade tests | Reopened: pre-STP totals and eligibility ordering need adversarial regression coverage |
| 5 | Mark valid / liq pause | Reopened: pre-STP totals and first-batch seeding violate the locked mark contract |
| 6 | Immediate cancel/modify | ✅ code + e2e cancel |
| 7 | Taker fees; makers free | Open: live initialization still configures maker −2 bps instead of locked 0 bps |
| 8 | Cap overflow behavior | Open: implementation does not apply one global cap-64 selection with the locked priority |
| 9 | Pause post/clear | ✅ T9.4.2 (6-bit matrix) |
| 10 | CU documented at cap | Partial: host timing exists; on-chain CU evidence is absent |
| 11 | Devnet deployed + initialized | ✅ 2026-08-06 |

## Progress (2026-08-06)

**Shipped since plan open:** full DFBA critical path, all M9 tasks, devnet deploy + init, lifecycle fixes, dual-fill e2e, frontend M9 wiring, Playwright suite green.

### Session A — M9 task completion (11 tasks)

| # | Task | Outcome |
|---|------|---------|
| 1 | T-CLIPPY-FIX | 23 clippy warnings fixed; CI clippy clean |
| 2 | T9.4.2 | PAUSE_POST + PAUSE_CLEAR; post/clear gated |
| 3 | T9.1.7 | CU host benchmarks cap 32/64/128 |
| 4 | T9.5.5b | resting across batch e2e |
| 5 | T9.4.3 | pure dual mid mark path confirmed |
| 6 | T9.3.5 | SetBatchParams disc 21 |
| 7 | T9.0.3 | DFBA error codes 603–605 |
| 8 | T9.4.4 | oracle freshness for funding |
| 9 | T9.4.5 | insurance inventory on vault |
| 10 | T9.5.5c | self-trade no-fill e2e |
| 11 | T9.5.5d | cancel resting between batches e2e |

### Session B — Devnet lifecycle + dual fill (evening)

| # | Item | Outcome |
|---|------|---------|
| 1 | Vault size | `VAULT_SPACE` 58 → 80 |
| 2 | Book | Client keypair book `J33Y6…` (matcher-owned); CPI 10KB create cap |
| 3 | SettleBatch | Creates next batch PDA + registry counter raw write @ offset 36 |
| 4 | Ops scripts | `tools/init-protocol.js`, `keeper-crank.js`, `trade-e2e.js` |
| 5 | Lifecycle | Batches 0–1 Settled; dual fill on batch 2 → `markValid=1`; batch 3+ Collecting |
| 6 | Redeploy | Core + matcher with settle/counter/book fixes (see deployment doc) |

### Session C — Frontend M9 + browser e2e (later)

| # | Item | Outcome |
|---|------|---------|
| 1 | Web config | M9 program IDs, vault/registry/book defaults |
| 2 | PostOrder path | `config.bookAddress` (not PDA); `resolveOpenBatch` for Collecting scan |
| 3 | SDK | `encodePostOrder` + Collecting alias; rebuild `packages/sdk` dist required after type changes |
| 4 | UI labels | Commit-reveal → Collecting (BatchTimeline, batchDisplay, stores) |
| 5 | Vitest | config + submission hooks green |
| 6 | Playwright | `pnpm e2e` **31/31** including deterministic wallet PostOrder |
| 7 | Agent PostOrder | Scripted/agent PostOrder against open Collecting batch OK |
| 8 | Wallet automation | **Done 2026-08-08** — no-extension PostOrder fixture; live signing remains in `tools/trade-e2e.js` |

### Session D — Deterministic wallet e2e + phase reconciliation (2026-08-08)

| # | Item | Outcome |
|---|------|---------|
| 1 | T-WEB-WALLET-CONNECT | Mock Phantom provider auto-connects a deterministic public key without secrets or popup approval |
| 2 | T-WEB-POST-ORDER | Mocked registry/portfolio/book/batch RPC state drives the real `/trade` submit path |
| 3 | T-WEB-POST-WIRE | Captured instruction pins disc 20, buy+maker, exact scaled price/qty, instrument 0, and signer metas |
| 4 | Fast command | `pnpm e2e:wallet` completes one focused test; full Playwright is 31/31 |
| 5 | Static cleanup | Added missing DFBA fields to stale test fixtures; changed historical `Committing` assertion to `Collecting` |
| 6 | Phase docs | Feature-named deployment and monitoring records added; AI DevKit feature lint now clean |
| 7 | Pipeline contract | WebSocket + SQLite/custom path documented; backfill remains explicitly not implemented |

### Session E — Frontend reliability scope reconciliation (2026-08-08)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | Positions/Portfolio relentless refreshing | Added T9.8.5 as a P0 UX task; deliberately not diagnosed or implemented during this planning phase |
| 2 | `Batch: Collecting past deadline` | Added the approved state/intent contract and keeper-lag task T9.8.2/T9.8.6 |
| 3 | Wallet and chart inert under Playwright MCP origin | Historical 2026-08-08 finding. T9.8.1 now gates on playwright-cli at both `localhost` and `127.0.0.1` |
| 4 | Blank/failed chart ambiguity | Added explicit loading/error/retry task T9.8.3 |
| 5 | Incomplete browser journey | Reclassified prior wallet test as PostOrder-construction coverage; added full DFBA lifecycle task T9.8.4 |
| 6 | Old commit/reveal browser affordances | Added removal task T9.8.7; historical documentation remains untouched |

### Session F — Counterparty matching scope reconciliation (2026-08-09)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | Live opposing-order smoke | Same-wallet Buy/Long and Sell/Short orders remained resting; this is consistent with self-trade prevention and is not evidence of a matcher failure |
| 2 | Matching evidence classification | Retained host/program-test and scripted devnet dual-fill evidence; reclassified independent-wallet browser matching as unverified |
| 3 | New launch-confidence gate | Added M9.9/T9.9.1–5 for two funded users, same-batch fill, Clear → Settle trace, deterministic regression, and conditional discrepancy repair |
| 4 | Devnet launch posture | Controlled invited alpha is feasible; open trader testing waits for the two-wallet fill trace and bounded/indexer-backed RPC reads |

### Session G — Persona harness retarget (2026-08-20)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | Matching-proof method | **playwright-cli named sessions** (`-s=maker`, `-s=taker`, optional `-s=observer`) on live M9 programs. Playwright MCP is retired as a proof path |
| 2 | Signing | Injected live-signing Wallet Standard / Phantom-compatible provider from keypair **paths** (`~/.config/solana/mgk-trader-{maker,taker}.json`). Phantom-extension popups are not the matching gate |
| 3 | Order set | Four posts in one Collecting batch so **both** DFBA auctions fire. One buy vs one sell is insufficient for `mark_valid` |
| 4 | Keeper | Ops, not a browser persona: `node tools/keeper-crank.js` |
| 5 | Next slice | **T9.9.1** persona harness + funding. T9.9.2–3 are the live fill. M9.10 (fee 0, 24/7 keeper, funding SMA) waits |
| 6 | Prices | Do not reuse the 2026-08-09 crossed-book 76.55 / 0.10 trap |

### Session H — T9.10.4 indexer health + non-silent staleness (2026-08-24)

| # | Item | Outcome |
|---|------|----------|
| 1 | HealthTracker | In-memory state machine (`warming`→`healthy`/`degraded`→`critical`); injectable clock for deterministic tests; records `lastReconciledSlot` and `lastSuccessfulPollAt` even on quiet markets |
| 2 | Health endpoint | `/api/healthz` extended with `status`, `lastReconciledSlot`, `lastSuccessfulPollAt`, `backfill` metadata; `slotLag` computed from `lastReconciledSlot`; legacy fallback preserved |
| 3 | Syncer integration | Records reconciliation on each successful chunk; records poll failures on RPC errors; exposes tracker via `getHealthTracker()` |
| 4 | Web health store | Consecutive failure counting (1→reconnecting, 2+→unreachable); 5s poll with 4s timeout; request deduplication; manual `refresh()`; immediate recovery |
| 5 | StatusBar | 6-state visual mapping: syncing/live/reconnecting/unreachable/delayed/critical with distinct dot indicators |
| 6 | MarketHeader | Never-loaded (`—`) vs cached-but-stale (`(stale)` + `as of Xm ago`) for OI and 24h volume |
| 7 | ChartToolbar | Renamed `live/off` to `fills live/fills delayed/fills off` |
| 8 | TradeHistory | Retains cached fills with inline delayed notice during degradation |
| 9 | E2E | Degraded and critical scenarios keep order form fully enabled; `trade.spec.ts` updated for `critical` status |
| 10 | Tests | 87/87 indexer (17 new `healthTracker.test.ts`); 492/492 web; Rust CI clean (114 pass); AI DevKit lint clean |

**Devnet accounts (canonical):**

| Account | Address |
|---------|---------|
| Core | `C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx` |
| Matcher | `7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC` |
| Oracle | `CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ` |
| Registry | `CbsfrRS2rYE2qgJbi7MM6mLzARUy8cDiYmHW2o12jYJA` |
| Vault | `9qe7TkRxDXHo3dywPKiiY1jwSBnFuSPHmGTWhcP8ttXE` |
| Book | `J33Y6yo6AZM6JKLEw89tN1kPmyEADqWWjGxb1aAW915j` |

**Evidence (latest):**

- `mgk-perps-matcher` lib 114 pass; `mgk-perps-core` lib 225 pass (`+stable` host-hash); `mgk-common` 45 pass
- `cargo build-sbf` clean; clippy clean
- lifecycle BPF: **7 pass, 4 ignored** (program-test CU meter; **not** prod — empty Clear ≈ 2.6k CU on devnet)
- Devnet: Close→Clear→Settle multi-batch; `node tools/trade-e2e.js` dual fill `markValid=1`
- Frontend baseline: M9 wired; Chromium Playwright 39/39; focused wallet 1/1; web Vitest 492/492; SDK 158/158; indexer 87/87. M9.9 execution is proven, but this evidence does not close Phase 7 defects or remaining M9.8 work
- Docs: AI DevKit base + feature lint clean as of 2026-08-24; feature-named deployment/monitoring records present
- Rust: `cargo +stable clippy --all-targets --all-features -- -D warnings` clean; `cargo +stable test --all-features` **397 passed, 5 ignored**. The exact default-toolchain clippy/test commands failed; see the Phase 7 implementation record

**Open task count:** the prior “0 open” claim is withdrawn. M9.9 execution is
complete, while Phase 7 reopens C1–C6 and M1–M12 in Execute Plan. M9.8 remains
open for origin/chart/lifecycle and legacy cleanup. T9.10.4 has implementation
evidence, but its reconciliation/health truthfulness is reopened by M8;
T9.10.1–3,5–7 remain. Security review remains before mainnet.

**Blockers / residual issues:**

| # | Item | Severity | Status | Notes |
|---|------|----------|--------|-------|
| 1 | ~~BPF e2e `InvalidArgument` on Initialize~~ | ~~P0~~ | **Fixed** | vault/system_program account order |
| 2 | BPF e2e CU exhaustion in ClearBatch | P1 | Open (test-only) | program-test 2.1 CU budget; devnet empty Clear ~2.6k CU |
| 3 | ~~Devnet keeper Clear/Settle failure~~ | ~~P0~~ | **Fixed** | book + vault + settle PDA + counter write |
| 4 | ~~Stale SDK / Committing UI labels~~ | ~~P0~~ | **Fixed** | rebuild SDK dist; Collecting labels |
| 5 | ~~Human Phantom wallet PostOrder bottleneck~~ | P2 | **Resolved by automation** | `pnpm e2e:wallet` = construction; scripted live send = `trade-e2e.js`; browser live send = T9.9.1 |
| 6 | Indexer polish | P2 | Partial | M9 IDs; PDA-batch/oracle/rate-limit polish remain. T9.10.4 health/staleness shipped |
| 7 | ~~Feature-named deployment/monitoring lint paths~~ | P3 | **Fixed** | AI DevKit feature lint clean 2026-08-08 |
| 8 | Wallet/chart can be server-rendered but non-interactive at the automation origin | P0 UX | In progress | T9.8.1; click-level evidence at both `localhost` and `127.0.0.1` under playwright-cli |
| 9 | Header/status bar says `Collecting past deadline` | P0 UX | In progress | T9.8.2/T9.8.6; chain is eligible to advance but still awaits keeper |
| 10 | Positions/Portfolio relentlessly refresh and cause eye strain | P0 UX | Partial | T9.8.5 has implementation evidence; keep as a regression |
| 11 | Browser coverage stops after PostOrder construction | P1 test gap | Partial | T9.8.4 reuses the M9.9 persona sessions for the visible Collecting → Settled journey |
| 12 | Independent-wallet live fill not verified | ~~P0 protocol-confidence gap~~ | **Resolved 2026-08-24** | Four Batch 19 orders plus finalized Close/Clear/Settle; correctness defects are tracked separately by Phase 7 |

## Next actions

**Current continuation (Phase 7, 2026-08-24):** M9.9 persona execution is
complete. Return to Execute Plan for the severity-ordered Phase 7 findings;
do not repeat the persona run or silently redefine locked behavior.

### Priority-ordered follow-on tasks

| # | Task | Priority | Status | Blocker |
|---|------|----------|--------|---------|
| 1 | ~~**Devnet batch lifecycle**~~ | ~~P0~~ | **Done** | Close→Clear→Settle batches 0→2+ |
| 2 | ~~**Devnet PostOrder dual fill**~~ | ~~P0~~ | **Done** | `trade-e2e.js` mark_valid=1 (scripted, not browser) |
| 3 | ~~**Frontend M9 wiring**~~ | ~~P0~~ | **Done** | config, book, open-batch, Collecting UI, SDK rebuild |
| 4 | ~~**Deterministic wallet PostOrder construction**~~ | ~~P1~~ | **Done** | mock Phantom + RPC fixture; exact disc 20 wire asserted |
| 5 | **T9.8.5 Positions/Portfolio visual stability** | P0 | **Implemented** | preserve last good data during background refresh; regression covered |
| 6 | **T9.8.2 Truthful DFBA state language** | P0 | **Implemented** | shared helper drives header/status; full lifecycle remains |
| 7 | **T9.9.1 Persona harness and funding** | P0 | **Done 2026-08-24** | named sessions, live-signing bridge, funded/init portfolios, distinct pubkeys |
| 8 | **T9.9.2–3 Four-order same-batch UI posts + crank + observe** | P0 | **Done 2026-08-24** | Batch 19 and finalized Close/Clear/Settle evidence |
| 9 | **T9.9.4–5 Deterministic regression/discrepancy lane** | P0 | **Reopened by Phase 7** | live proof exposed double-counted Batch volume; add all C1–C6/M1–M12 regressions |
| 10 | **T9.8.1 Browser hydration + interaction reliability** | P0 | In progress | playwright-cli both-origin click evidence; continue after/alongside T9.9.1 |
| 11 | **T9.8.3 Chart loading/error/retry** | P1 | Not started | after T9.9.1 harness exists |
| 12 | **T9.8.4 Full DFBA playwright-cli lifecycle** | P1 | Partial | reuse persona sessions after T9.9.3 |
| 13 | **T9.8.6 Keeper-lag visibility** | P1 | Planned | indexer/monitoring freshness contract needed for health detail |
| 14 | **T9.8.7 Retire remaining legacy web affordances** | P1 | Not started | align active UI/tests with pure PostOrder DFBA |
| 15a | **T9.10.4 Indexer health / lag** | P1 | **Implemented; correctness reopened** | health tracker exists; Phase 7 M8 documents false reconciliation/backfill/write-health boundaries |
| 15b | **T9.10.1–3,5–7** Working-devnet follow-on | P1 | Open | fee 0, 24/7 keeper, funding/mark/reduce-only work |
| 16 | **Security review** — `solana-fender-mcp` + QEDGen | P1 | Not started | before mainnet |
| 17 | program-test CU budget / un-ignore 4 e2e tests | P1 | Open | harness only; not prod |
| 18 | **Indexer** PDA-batch/oracle/rate-limit polish | P2 | Partial | M9 IDs wired |
| 19 | **Multi-venue oracle** for index | P2 | Not started | — |

### Suggested next 2–3 actions (when resuming)

1. Repair C1–C3 account authentication, variable-list bounds, PostOrder risk,
   and program/PDA binding with adversarial tests.
2. Repair C4–C6 post-STP result conservation, reusable book storage, and
   result-driven keeper portfolio settlement.
3. Complete M1–M12, then run `dev-testing` followed by `dev-review`.

## Historical plan

Prior commit-reveal milestones M1–M8 remain in `docs/ai/planning/README.md` as audit trail. **Do not implement new commit-reveal work from that file.** Active matching/lifecycle work is **this document (M9)**.

## Summary

The M9.9 on-chain/browser execution proof is complete: distinct maker/taker
personas posted four Batch 19 orders and observed finalized Close → Clear →
Settle. The M9 implementation is **not aligned** with requirements/design.
Phase 7 found six critical and twelve major issues; the next slice is Execute
Plan, not another live persona run.

**Ops verified (2026-08-06):** vault size fix (80 B), matcher-owned book keypair, SettleBatch next-batch PDA create + registry counter raw write, `tools/{init-protocol,keeper-crank,trade-e2e}.js`. Multi-batch Close→Clear→Settle succeeded; dual-side PostOrder fill produced `markValid=1`. Empty-book Clear on devnet ≈ **2.6k CU** (production-safe for thin books).

**Frontend (through 2026-08-09, still open):** M9 program IDs, open-batch
resolution, and `encodePostOrder` exist. Deterministic PostOrder construction,
truthful header/status intent, and portfolio refresh stability are evidenced.
Chart states, origin matrix, remaining legacy affordances, keeper freshness,
and the complete visible lifecycle wait on the persona harness.

**Scope changes (2026-08-20):** Matching-proof harness is playwright-cli
personas, not MCP. Live window stays `t_min=2`, `t_max=150`, `n_min=1`. Locked
maker fee is **0 bps**; live leftover −2 is T9.10.1 after M9.9. Book remains a
client-created keypair account (not CPI PDA) due to 10KB create cap.

**Risks / upcoming focus:** account substitution, missing PostOrder risk,
pre-STP mark manipulation, permanent book exhaustion, omitted DFBA portfolios,
and the major integration/accounting findings. Controlled invited alpha is not
recommended until those are fixed and reviewed.

**Task tracing:** unavailable because this was a direct `dev-planning`
continuation, not a parent `dev-lifecycle` run with an established task.

**Planning stop (Phase 7):** Reconciled 2026-08-24. Fresh evidence is 397 Rust
passes/5 ignored on stable, 158 SDK, 87 indexer, 492 web, Chromium 39/39 and
focused wallet 1/1. Exact default-toolchain clippy/test commands still fail,
and test success does not close the Phase 7 findings.

**Historical RPC stop checkpoint (2026-08-21; superseded for M9.9 execution):** fallback 4 accepted a signed transaction
but timed out during confirmation and returned repeated `429`s. The primary
also passed the low-rate probe but hit its 15-requests/second limit under the
live polling workload. Fallback-2 is the current selected candidate after a
clean signed probe and process restart; no browser retry was made after that
restart. At that checkpoint T9.9.2–3 were unproven. The later August 24 Batch
19 proof supersedes that execution status while preserving this failed-RPC
history.
