---
phase: testing
title: mgk On-Chain Perps DEX — DFBA Test Strategy
description: Test coverage for Dual Flow Batch Auction matching (replaces commit-reveal CLOB plan).
status: in-progress
date: 2026-08-02
updated: 2026-08-24
requirements: docs/ai/requirements/2026-06-18-feature-onchain-perps-dex.md
design: docs/ai/design/feature-onchain-perps-dex.md
planning: docs/ai/planning/2026-08-02-feature-onchain-perps-dex.md
---

# mgk On-Chain Perps DEX — DFBA Test Strategy

## Context

v1 matching is **pure DFBA**: open posts, dual uniform-price auctions, dual mid mark, liquidation pause without dual clear. Commit-reveal, shuffle, and priority queues are **out of scope** for new tests (legacy CLOB tests may remain until removed).

Programs: `perps-core`, `perps-matcher`, `mgk-oracle`, `mgk-common`.

> **Phase 7 reconciliation (2026-08-24):** M9.9's live named-persona proof is
> complete. All “unproven/blocked” statements in dated 2026-08-21 retry
> checkpoints below are retained as history, not current status. Fresh suites
> pass, but they omit adversarial coverage for six critical and twelve major
> implementation findings. See
> `docs/ai/implementation/2026-08-24-feature-onchain-perps-dex.md`.

## Test inventory (fresh 2026-08-24)

| Crate | DFBA-focused | Notes |
|-------|--------------|-------|
| `mgk-perps-matcher` | **21+** in `state/dfba.rs` + book `is_maker` | Host `cargo test -p mgk-perps-matcher --lib` (114 pass, 1 ignored) |
| `mgk-perps-core` | batch/settle/liq gates, PostOrder, ClearBatch, SettleMark | `cargo +stable test -p mgk-perps-core --lib --features host-hash` (225 pass) |
| `mgk-common` | math, types, errors | `cargo test -p mgk-common` (45 pass) |
| Legacy matcher CLOB/shuffle/queue | still present | Not the DFBA path |
| `lifecycle.rs` e2e | **8 pass, 4 `#[ignore]` fresh** | Included in `cargo +stable test --all-features`; four ignored matcher-CPI/CU cases remain unexecuted |

## Commands

```sh
cargo test -p mgk-perps-matcher --lib
cargo check -p mgk-perps-core --lib
cd programs/perps-matcher && cargo build-sbf   # stack gate
```

## Scenarios (checklist)

### Matcher DFBA core

- [x] T-DFBA-LAYOUT — flat pack 56 B, region offsets
- [x] T-DFBA-CLEAR-ASK / BID — paper-style volume max
- [x] T-DFBA-NO-CROSS — empty match
- [x] T-DFBA-ALLOC / CONSERVE / DUST — pro-rata + round-down
- [x] T-DFBA-SELF-TRADE — same user no fill (existing coverage does not catch pre-STP header totals or ineligible-order cancellation)
- [x] T-DFBA-CAP — implementation path covered; locked global cap/overflow semantics remain untested and non-conforming (M1)
- [x] T-DFBA-DUAL — both auctions + one-sided
- [x] T-BOOK-ROLE — `is_maker` on place_resting
- [x] T-LIFECYCLE-MARK — dual fill ⇒ mark_valid; one-sided ⇒ liq pause rule
- [x] T-SBF-STACK — `cargo build-sbf` no stack overflow on matcher

### Core lifecycle (unit / field simulation)

- [x] T-BATCH-DFBA-FIELDS — mark_valid, liq_paused defaults; dfba_mark_mid
- [x] T-CLOSE-TO-CLEARING — field write path Committing → Clearing
- [x] T-DFBA-DISC — matcher disc 5 / results header 34
- [x] T-POST-ORDER-UNIT — PostOrder wire format: disc 20, 21-byte data parse, CPI layout (disc 6, 54 bytes), validation constants (**done 2026-08-06**: 9 new tests in `post_order.rs`)
- [x] T-CLEAR-BATCH-IX — DfbaClear CPI layout (disc 5, 11 bytes), mark_valid/liq_paused flag logic (4 scenarios), clearing_price mid rounding, volume conservation (**done 2026-08-06**: 10 new tests in `clear_batch.rs`)
- [x] T-SETTLE-MARK — instrument.mark_price from dual mid when mark_valid; carry-forward when invalid; zero when no prev (**done 2026-08-06**: 6 new tests in `settle_batch.rs`)

### E2E (BPF / program-test)

- [x] T-E2E-DFBA-FILL — PostOrder × dual makers+takers → close → DfbaClear → settle; mark_valid + fills + fees
- [x] T-E2E-REST — unfilled rests next batch with role (**done 2026-08-06**: `test_e2e_resting_across_batch`)
- [x] T-E2E-LIQ-PAUSE — one-sided clear ⇒ mark_valid=0, liq_paused=1
- [x] T-E2E-SELF — same wallet maker+taker does not self-fill (**done 2026-08-06**: `test_e2e_self_trade_no_fill`)
- [x] T-E2E-CANCEL — cancel resting between batches (**done 2026-08-06**: `test_e2e_cancel_resting_between_batches`)
- [x] T-E2E-GTC-RESTS-NEXT-BATCH — DFBA resting order across batches (**done 2026-08-06**: `test_e2e_gtc_rests_then_matches_next_batch` rewritten from legacy)
- [x] T-E2E-SETTLE-NEXT-PDA — SettleBatch creates next batch PDA (**done 2026-08-06**: `test_e2e_settle_creates_next_batch_pda` rewritten from legacy)
- [x] T-E2E-LIQUIDATE — DFBA mark + underwater portfolio liquidation (**done 2026-08-06**: `test_e2e_liquidate_user_happy_path` rewritten from legacy)
- [x] T-E2E-ADL — ADL fires when insurance insufficient (**done 2026-08-06**: `test_e2e_liquidate_user_adl_stub_fires` rewritten from legacy)
- [x] T-E2E-CANCEL-ALL — CancelAllRestingOrders clears book (**done 2026-08-06**: `test_e2e_cancel_all_resting_orders` rewritten from legacy)

### Browser E2E (Playwright)

- [x] T-WEB-WALLET-CONNECT — deterministic Phantom-compatible provider auto-connects without an extension or approval popup.
- [x] T-WEB-POST-ORDER — mocked registry/portfolio/book/Collecting-batch RPC state drives the real `/trade` form through PostOrder construction.
- [x] T-WEB-POST-WIRE — captured transaction pins disc `20`, buy+maker flags, exact 1e6-scaled price/qty, instrument `0`, and six account metas including the user signer.
- Run only this fast path with `cd mgk-frontend/apps/web && pnpm e2e:wallet`.

### Live devnet smoke (Playwright MCP, 2026-08-09) — historical, not a fill proof

One connected Phantom wallet. Opposing posts from this wallet exercise
**self-trade skip**, not independent-counterparty matching. Do not add new
Playwright MCP coverage. Matching proof is **T-WEB-PERSONA-*** below.

- [x] T-WEB-LIVE-POST — Phantom-approved Buy/Long limit order confirmed on
  devnet at `76.55` / `0.01`; signature
  `482LWPHQXSfXt1EecLmtHNeYGoQJVSn8VDCj4RQEFcDnKYyMTfYdpXBtwgmHgn8exZzJ7cKNunzP1AYhJ2Np1Xgg`.
- [x] T-WEB-GTC-OBSERVE — keeper advanced batch 7 → 8 and the book endpoint
  retained the new bid (`price=76550000`, `qty=10000`, `orderCount=1`).
- [x] T-WEB-DFBA-COPY — header and status bar agree on
  `Orders open · Waiting for minimum flow (0/1)`.
- [x] T-WEB-MARKET-BASELINE — `/api/markets/0/state` returns HTTP 200 with a
  zero baseline before the first fill.
- [x] T-WEB-CROSSED-BOOK — crossed best bid/ask does not render a midpoint;
  UI reports that the book is crossed.

Regression suites added during this continuation cover stale runtime account
owner/size validation, minimum-flow copy, background portfolio refresh
stability, transient batch RPC preservation, and crossed-book midpoint safety.

### Live surface continuation (2026-08-09) — historical UI wiring

Same single-wallet MCP session as above. Evidence that Sell, cancel, modify,
portfolio tabs, and Clearing copy work. **Not** T-WEB-PERSONA-MATCH.

- [x] T-WEB-LIVE-SELL — Playwright MCP submitted a Sell/Short PostOrder with
  maker + reduce-only selected; the transaction confirmed and the resulting
  resting order was visible in Open Orders.
- [x] T-WEB-LIVE-CANCEL — Open Orders cancel path opened wallet approval and
  removed the test short order after confirmation.
- [x] T-WEB-LIVE-MODIFY — Inline modify mode opened, rejected a zero quantity
  with visible validation feedback, kept the editor open, and sent no
  transaction.
- [x] T-WEB-LIVE-PORTFOLIO — Portfolio, balances, positions, open orders, trade
  history, and the three coming-soon history tabs rendered without application
  exceptions; deposit/withdraw controls enabled for a valid SOL amount without
  submitting funds.
- [x] T-WEB-CLEARING-DISPLAY — A live Clearing batch now renders `Batch:
  Clearing` plus `Orders closed · Matching maker and taker flow at uniform
  prices` instead of disappearing to `Batch: —`.
- [x] T-WEB-CROSSED-ORDER-FORM — Crossed best bid/ask no longer auto-fills a
  Sell price; the form shows `0.00`, base-asset `SOL` sizing, and collateral-
  derived availability.
- [x] T-WEB-DFBA-HISTORY-COPY — Order History no longer exposes commit/reveal
  terminology in its user-facing description or required indexer sources.

Focused regression evidence after these changes: web OrderForm + batch-store
tests **44 passed**, Open Orders tests **2 passed**, and history placeholder
tests **16 passed**.

Open infrastructure follow-up: the live browser produced Helius devnet RPC
`429` responses while several independent stores polled concurrently. Keep
this separate from protocol correctness; add shared throttling/indexer-backed
read caching before treating live console-error-free operation as complete.

### Independent-counterparty live DFBA (playwright-cli personas, completed 2026-08-24)

**Gate for working-devnet matching proof.** Two named `playwright-cli` sessions
against `http://localhost:3000/trade` on **live Solana devnet** M9 programs
(core `C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx`). Signing is an injected
Wallet Standard / Phantom-compatible provider that **sends** transactions.
Keypairs stay on disk (`~/.config/solana/mgk-trader-{maker,taker}.json` or
`MGK_MAKER_KEYPAIR` / `MGK_TAKER_KEYPAIR`). Never Playwright MCP. Never
Phantom-extension popups as the matching gate. Never treat `pnpm e2e:wallet`
(capture-only `mockPhantom.ts`) as a fill.

Keeper is `node tools/keeper-crank.js`, not a browser persona. Optional
`-s=observer` is unsigned public UI. Live window stays `t_min=2`, `t_max=150`,
`n_min=1`.

`mark_valid` needs **both** auctions (bid = maker-buy × taker-sell, ask =
maker-sell × taker-buy). T-WEB-PERSONA-MATCH is not done with a single
buy-vs-sell pair. Do not reuse the 2026-08-09 crossed-book 76.55 / 0.10 prices.

- [x] T-WEB-PERSONA-SETUP — Verified: `playwright-cli -s=maker`
  and `-s=taker` have isolated storage; each UI showed a distinct funded
  pubkey after live-signing inject (`6LZP...` maker, `BeBT...` taker); InitPortfolio completed for both, maker
  Deposit completed (0.1 SOL), and taker Deposit completed (0.4 SOL); and
  isolation snapshots contained no secret key,
  seed, or password. Primary QuickNode RPC qualified with 0 errors/429s over 60s load and confirmed signed probe.
  Linked: T9.9.1 / T-WEB-TWO-WALLET-SETUP.
- [x] T-WEB-PERSONA-POST — Both UIs showed pinned Collecting Batch 19 (`DuhAF1kA...`). Four
  PostOrders through `/trade` testids (`order-form-side-buy` /
  `order-form-side-sell`, `order-form-checkbox-input-post-as-maker`,
  `order-form-price-input`, `order-form-qty-input`, `order-form-submit-buy` /
  `order-form-submit-sell`): maker-buy ($0.05, 0.01 SOL, maker checked), maker-sell ($85.00, 0.01 SOL, maker checked), taker-sell
  ($0.05, 0.01 SOL, maker unchecked), taker-buy ($85.00, 0.01 SOL, maker unchecked). Confirmed on-chain in book slots 39, 40, 41, 42. Linked: T9.9.2 /
  T-WEB-TWO-WALLET-POST.
- [x] T-WEB-PERSONA-MATCH — After CloseCollecting (`5EPWEA3q...`) → DfbaClear (`5t4LPoaH...`) → SettleBatch (`4apD1UuM...`),
  both UIs show `Batch: Settled · Fills settled · Mark updated`, fills, fees, and positions; settled batch `mark_valid=1`, `liq_paused=0`, dual-mid clearing price $42.525.
  Results account `CYZnXvC4...` confirmed 10,000 matched bid / 10,000 matched ask, uniform prices $0.05 / $85.00, 100% two-persona fill ownership.
  Linked: T9.9.3 / T-WEB-TWO-WALLET-MATCH.
- [x] T-E2E-TWO-USER-FILL — Deterministic two-pubkey CI fixture
  (program-test) asserting allocation, fee flow, position deltas, and no
  unexpected fill owner. Fixed-seed maker/taker identities, per-wallet fill
  allocation, fee/rebate and insurance flow, flat net position deltas, and
  `mark_valid=1` passed against local SBF artifacts on 2026-08-21. Existing
  matcher self-trade tests remain the focused regression. Linked: T9.9.4.

Operator sketch: planning doc T9.9.1. Isolation rule: never omit `-s=` once
both sessions are open.

#### Historical execution stop checkpoint (2026-08-21)

- `node --test tools/lib/liveSigning.test.cjs`: **8 passed**.
- `node --test tools/cli-live-signer-bridge.test.cjs` (escalated loopback
  listener run): **1 passed**.
- `node tools/persona-fund.js`: **PASS** for distinct maker/taker pubkeys and
  portfolio initialization; maker deposit completed and taker funding state
  already existed.
- Named `maker` and `taker` sessions showed different Online/Devnet wallet
  pubkeys. Secret scans were clean for
  `.playwright-cli/maker-live-isolation.yaml` and
  `.playwright-cli/taker-live-isolation.yaml`.
- **Stop:** `playwright-cli -s=taker console error` reported 193 errors with
  repeated authenticated Helius devnet HTTP `429` responses. Because current
  batch/book reads were not reliable, no PostOrder or keeper-crank fill gate
  was attempted. Resume requires a usable private RPC quota/endpoint.

#### Historical QuickNode retry checkpoint (2026-08-21)

- The supplied QuickNode devnet endpoint was configured in ignored local web and
  indexer env files. The endpoint is intentionally redacted from this document
  and all browser artifacts.
- `node tools/persona-fund.js` created and funded clean, distinct temporary
  maker/taker personas, initialized both portfolios, and deposited collateral.
  The principal-layout regression now reads byte offset 48 rather than equity at
  byte offset 32.
- A redacted low-rate probe reached a confirmed blockhash and all six canonical
  M9 accounts. A six-account range request hit the provider's five-account plan
  limit; one-account reads passed afterward.
- Named `playwright-cli -s=maker` and `playwright-cli -s=taker` sessions both
  opened `/trade`, showed distinct public keys, and detected their injected
  Phantom-compatible providers. Evidence: `.playwright-cli/maker-quicknode-
  isolation.yaml` and `.playwright-cli/taker-quicknode-isolation.yaml`.
- The browser then received repeated HTTP `429`s during live polling. This is
  the mandated RPC stop condition: no UI PostOrder, `keeper-crank.js`, or
  `mark_valid=1` claim was attempted. The browser sessions, signer bridges, web
  server, and indexer were stopped after capture.
- Focused helper verification: `node --test tools/trade-e2e.test.cjs
  tools/lib/liveSigning.test.cjs tools/portfolio-layout.test.cjs` — **11 passed**.
  Secret scan of the new snapshots — **PASS**.

#### Historical RPC fallback stop checkpoint (2026-08-21)

- Added the supplied Helius endpoint as `NEXT_PUBLIC_RPC_FALLBACK_URL` and
  `RPC_FALLBACK_URL` in ignored local env files; examples keep the fallback
  value blank so credentials never enter tracked artifacts.
- Helius direct `getSlot` returned JSON-RPC `-32429 rate limited`.
- QuickNode answered a low-rate probe and both named sessions reopened `/trade`
  with distinct funded pubkeys, but browser polling later produced repeated
  HTTP `429`s. `node tools/keeper-crank.js` additionally received QuickNode
  `-32007` (`15/second request limit reached`).
- The crank advanced empty batches only. No `/trade` PostOrder, four-order
  dual-auction proof, or `mark_valid=1` evidence exists. Stop and resume with a
  usable RPC quota/endpoint; then revalidate the active batch before posting.

#### Historical fallback-2 controlled browser retry (2026-08-21)

- Restarted local web, indexer/keeper, and maker/taker signer bridges with
  fallback-2; bridges used the two explicit funded proof-keypair paths.
- Named `maker` and `taker` sessions rendered distinct expected pubkeys. Maker
  showed `0.1000` free collateral; taker retained its distinct wallet surface.
- Both pages showed `Batch: —` while the RPC returned repeated HTTP `429`s
  under combined polling. The test therefore could not establish a common
  Collecting `batch_id`; no PostOrder or keeper crank was attempted.
- `.playwright-cli/maker-fallback2-revalidated.yaml` and
  `.playwright-cli/taker-fallback2-revalidated.yaml` passed the secret scan.
  Generated console logs were credential-redacted and then scanned clean.
- Result: T-WEB-PERSONA-SETUP remains partial on provider health;
  T-WEB-PERSONA-POST and T-WEB-PERSONA-MATCH remain unproven.

#### Historical fallback-5 / split-provider controlled retry (2026-08-21)

- Funded two-persona preflight passed with distinct wallets and portfolios.
- Combined polling on fallback-5 failed with `429`s; no orders were counted.
- Split-provider sessions agreed on Collecting batch 116, but all four UI
  attempts failed before signing from web RPC rate limiting.
- A single-session retry confirmed two maker transactions, but the batch closed
  before taker participation. The next window showed cross-provider propagation
  lag. T9.9.2–3 remain unproven; T9.9.4/M9.10 remain gated.

### Superseded (do not add new coverage)

- CommitOrder / RevealOrder success paths
- Fisher-Yates fairness demos as product gates
- Pre-signed reveal relayer
- Freshness mark blend / toxic-taker scoring (deferred)
- New Playwright MCP (`@playwright/mcp`) coverage as a matching or wallet-QA gate
- Phantom-extension popups as the independent-counterparty fill harness

### Pause matrix (T9.4.2, done 2026-08-06)

- [x] T-PAUSE-POST — PAUSE_POST bit 4 blocks PostOrder (with PAUSE_TRADING umbrella)
- [x] T-PAUSE-CLEAR — PAUSE_CLEAR bit 5 blocks CloseCollecting + ClearBatch (with PAUSE_TRADING umbrella)
- [x] T-PAUSE-BITS — 6 independent bits pinned (TRADING, WITHDRAWALS, LIQUIDATIONS, FUNDING, POST, CLEAR)
- [x] T-PAUSE-RESERVED — PAUSE_RESERVED_MASK now 0b_1100_0000 (bits 6..7 only)

### CU measurement (T9.1.7, done 2026-08-06)

- [x] T-CU-32 — 32 orders/side × 1000 iterations host benchmark
- [x] T-CU-64 — 64 orders/side × 1000 iterations host benchmark
- [x] T-CU-128 — 128 orders/side × 1000 iterations host benchmark
- [x] T-CU-OVERFLOW — cap=64 with 80 orders (priority selection)

### Vercel schema (T9.11.8b, done 2026-08-24)

- [x] T-VERCEL-JSON-SCHEMA — every tracked `vercel.json` (`./vercel.json`, `mgk-frontend/vercel.json`, `mgk-frontend/apps/web/vercel.json`) uses only keys allowed by the official schema (`https://openapi.vercel.sh/vercel.json`). Explicitly rejects `engines` (not in schema, `additionalProperties: false`) and `env` (deprecated). Test: `cd tools && node --test vercel-json.test.js`. Node pin via `package.json` `engines.node`, not `vercel.json`.

## Coverage targets

| Layer | Target |
|-------|--------|
| DFBA pure math | 100% of `dfba.rs` public API |
| Book role flag | place + persist |
| Clear/settle wire | disc + header constants pinned |
| E2E | ≥1 dual-fill path on devnet/program-test when env allows; independent-wallet **browser** fill is T-WEB-PERSONA-MATCH |
| SBF | matcher + core `cargo build-sbf` zero stack overflow |

## Evidence log

| Date | Command | Result |
|------|---------|--------|
| 2026-08-02 | `cargo test -p mgk-perps-matcher --lib` | **110 passed**, 1 ignored |
| 2026-08-02 | `cargo +stable test -p mgk-perps-core --lib --features host-hash` | **193+** then **196 passed** (2026-08-03) |
| 2026-08-03 | lifecycle `e2e_` with `SBF_OUT_DIR=target/deploy` | dual fill + one-sided liq pause **ok** |
| 2026-08-02 | `cargo build-sbf` matcher+core | clean (no stack errors) |
| 2026-08-06 | `cargo +stable clippy --all-targets --all-features -- -D warnings` | **clean** (23 warnings fixed) |
| 2026-08-06 | `cargo test -p mgk-perps-matcher --lib` | **114 passed** (+4 CU benchmarks) |
| 2026-08-06 | `cargo +stable test -p mgk-perps-core --lib --features host-hash` | **196 passed** |
| 2026-08-06 | `cargo test -p mgk-common` | **44 passed** |
| 2026-08-06 | `cargo +stable check -p mgk-perps-core --test lifecycle` | compiles (e2e_resting_across_batch added) |
| 2026-08-06 | `cargo +stable test -p mgk-perps-core --lib --features host-hash` | **225 passed** (+25 T-POST-ORDER-UNIT/T-CLEAR-BATCH-IX/T-SETTLE-MARK) |
| 2026-08-06 | `cargo test -p mgk-common` | **45 passed** |
| 2026-08-06 | `cargo +stable clippy --all-targets --all-features -- -D warnings` | **clean** (post new tests) |
| 2026-08-06 | `cargo +stable test -p mgk-perps-core --lib --features host-hash` | **225 passed** |
| 2026-08-06 | `cargo test -p mgk-perps-matcher --lib` | **114 passed** |
| 2026-08-06 | `cargo test -p mgk-common` | **45 passed** |
| 2026-08-06 | lifecycle.rs e2e BPF tests | **7 pass, 4 ignored** (CU exhaustion in ClearBatch) |
| 2026-08-06 | `SBF_OUT_DIR=target/deploy cargo +stable test -p mgk-perps-core --test lifecycle --features host-hash` | **7 passed**, 4 `#[ignore]` |
| 2026-08-08 | `cd mgk-frontend/apps/web && pnpm e2e:wallet` | **1 passed**; deterministic wallet + mocked RPC; browser body ~1.1s |
| 2026-08-08 | `cd mgk-frontend/apps/web && pnpm exec playwright test --project=chromium` | **31 passed** |
| 2026-08-08 | `cd mgk-frontend/apps/web && pnpm exec vitest run` | **436 passed** |
| 2026-08-08 | `cd mgk-frontend/packages/sdk && pnpm test` | **158 passed** |
| 2026-08-08 | `cd mgk-frontend/apps/web && pnpm typecheck` | **clean** |
| 2026-08-08 | `cargo +stable clippy --all-targets --all-features -- -D warnings` | **clean** |
| 2026-08-08 | `cargo +stable test --all-features` | **396 passed**, 5 ignored, 0 failed |
| 2026-08-25 | `cd tools && node --test vercel-json.test.js` | **4 passed** (`vercel.json`, `mgk-frontend/vercel.json`, `mgk-frontend/apps/web/vercel.json`) |
| 2026-08-25 | `gh pr checks 2` (PR #2 recovery branch) | **4/4 passed** (`Tests & Lint`, `Vercel – mgk-frontend`, `Vercel – percolator`, `Vercel Preview Comments`) |
| 2026-08-25 | `gh api repos/mangekyou-labs/mgk-solana/commits/master/status` | **state: success** (`Vercel – mgk-frontend` success, `Vercel – percolator` success) |

## Risks

- **Independent-wallet browser execution proof resolved 2026-08-24:** Batch 19
  includes four named-persona UI posts and finalized Close/Clear/Settle. This is
  not a protocol-correctness proof; Phase 7 found critical defects in the path.
- **Current P0 coverage gap:** no adversarial lifecycle tests cover substitute
  results/matcher/oracle/portfolio accounts, PostOrder risk/account binding,
  post-STP header conservation, permanent book exhaustion, or keeper omission
  of DFBA portfolios.

The provider-specific 429 items below are **historical 2026-08-21 stop
conditions** preserved for audit history; the later Batch 19 run supersedes
their M9.9 execution status.
- Same-wallet MCP smoke is self-trade skip, not a matcher failure.
- One-sided (single buy vs sell) posts can leave `mark_valid=0`.
- Crossed-book 76.55 / 0.10 prices will not clear both auctions.
- Helius / public-devnet 429s under concurrent store polling: reached the live
  stop condition on 2026-08-21; no fill claim is valid until a usable private
  RPC quota/endpoint is available.
- The supplied QuickNode endpoint passed low-rate canonical reads but returned
  repeated browser `429`s; no UI fill or keeper crank was attempted.
- The third public-devnet fallback passed initial low-rate slot/account reads
  and advanced empty batches, then returned repeated HTTP `429`s and keeper
  `fetch failed` errors once both named sessions and the keeper polled together.
  The web/indexer processes and browser sessions were stopped; T9.9.2–3 remain
  blocked and no UI PostOrder was attempted.
- Focused cache/keeper regressions after the active-batch fix:
  `pnpm exec vitest run src/integration.test.ts -t "invalidates the live cache|ignores a stale persisted"`
  — **2 passed, 25 skipped**; `pnpm exec vitest run
  src/keeperSelection.test.ts` — **4 passed**.
- The newly supplied Infura fallback 4 passed low-rate `getSlot`, canonical
  registry `getAccountInfo`, and confirmed `getLatestBlockhash` probes. It has
  been added to ignored local env files and selected for one controlled live
  retry.
- The first paired named-session UI submissions succeeded and batch 47 reached
  two commitments. Repeated provider HTTP `429 Too Many Requests` responses
  then blocked the second pair; the keeper also hit `getLatestBlockhash` 429
  during `ClearBatch`. The two-order batch eventually settled with
  `markValid=false`/`liqPaused=true`, which is expected without both auctions.
  The live processes and sessions were stopped under the mandated RPC stop
  condition. T9.9.2–3 remain unproven; no matcher discrepancy was observed.
- Named playwright-cli sessions leak storage if `-s=` is omitted.
- Key material in snapshots/traces if the inject helper dumps secretKey.
- **BPF e2e CU exhaustion (P1 harness-only, not working-devnet):** Matcher DfbaClear consumes 1.4M CUs in ClearBatch under program-test 2.1's 200k meter. 4 e2e tests `#[ignore]`. Devnet empty Clear ≈ 2.6k CU. Do not block T9.9.1 on this.
- Core e2e needs `SBF_OUT_DIR`/`BPF_OUT_DIR` absolute path to `target/deploy` and `+stable` for host test binary.
- Results accounts are required to be **matcher-owned and batch-bound**; the
  current core settlement path does not enforce either property (C1).
- Keeper and both trader keypairs need SOL for fees and collateral on devnet.
- ~~BPF e2e `InvalidArgument` on Initialize~~ — **Fixed**: swapped vault/system_program account indices.

---

## T9.10.4 — Indexer Health & Staleness Coverage (2026-08-24)

These passing tests cover the implemented state model and UI mappings. They do
not prove the production reconciliation boundary: the syncer records success
before the chunk is atomically committed and production backfill metadata is
not updated (Phase 7 M8).

### 1. Indexer Test Suite (87/87 passed)
- `healthTracker.test.ts` (17 tests): Warming → healthy transition; quiet-market reconciliation; boundary at 10/11 slots; degraded via RPC failure and 11–50 lag; critical via SQLite unwritable, 120 s timeout, and sustained 51-slot lag; high-lag window reset on reconciliation; recovery from degraded/critical; negative lag clamping; poll success without slot; backfill metadata state transitions; secret omission; defensive snapshot copies.
- `health.test.ts` (16 tests): Legacy classifier with `warming`/`critical` status names; tracker snapshot passthrough; slotLag from `lastReconciledSlot`; default backfill metadata; boundary at 10/11 and 50/51 slots; negative lag clamping; 15-second heartbeat expiry; backward-compatible `latestIndexedSlot` alias; omission of RPC URLs/secrets.
- `syncer.test.ts` (7 tests): Quiet-market advancement, failed chunk retry, restart resume, idempotent fills/candles, single-flight coalescing, subscription behavior, `SKIP_BACKFILL=1`; missing record-after-commit and production-backfill-metadata cases remain.
- `store.test.ts` (4 tests): Monotonic cursor progression, error timestamping, cursor seeding, database writability.
- `integration.test.ts` (27 tests) & `backfill.test.ts` (4 tests): REST and websocket integration with health endpoints and gap-aware ingestion.

### 2. Web App Test Suite (492/492 passed)
- `useIndexerHealthStore.test.ts` (9 tests): Initialization in warming status, consecutive failure counting (1 → reconnecting, 2+ → unreachable), immediate recovery on next valid response, last-valid preservation, request deduplication, manual refresh, and new status types (`warming`/`critical`).
- `StatusBar.test.tsx` (15 tests): Visual mapping to `Indexer syncing` (warming), `Indexer live` (healthy), `Indexer delayed · N slots` (degraded), `Indexer critical · N slots` (critical), `Indexer reconnecting` (1 failure), and `Indexer unreachable` (2+ failures) with corresponding dot indicators while preserving wallet connection separation.
- `MarketHeader.test.tsx` (13 tests): Stale indicators `(stale)` and `as of Xm ago` timestamps for 24h Vol and OI when indexer is degraded/critical; never-loaded state shows `—` without stale indicator; healthy shows no stale indicator.
- `TradeHistory.test.tsx`: Retaining cached fills with inline delayed notice banner during indexer degradation; displays blocking error only when zero fills exist.
- `ChartToolbar.test.tsx` (10 tests): Rendering `fills live`, `fills delayed`, or `fills off` based on health state (`warming`/`degraded`/`critical`) and WebSocket connection.

### 3. Playwright E2E Test Suite (39/39 passed)
- `trade.spec.ts`:
  - Degraded indexer scenario: surfaces `Indexer delayed` and stale badges while keeping order form inputs, sliders, checkboxes, and buy/sell actions fully enabled and interactable.
  - Critical indexer scenario: surfaces `Indexer critical` while keeping order form and trading actions enabled.
- `wallet-flow.spec.ts`: Submits `PostOrder` on deterministic wallet.
- `submit-long-and-observe.spec.ts` & `live-test.spec.ts`: Full end-to-end multi-step flow.

### 4. Rust Engine & On-chain Checks
- `cargo +stable clippy --all-targets --all-features -- -D warnings` — **PASS (0 warnings)**.
- `cargo +stable test --all-features` — **PASS (397 passed, 5 ignored)**.
- `npx ai-devkit@latest lint --feature onchain-perps-dex` — **PASS (0 errors)**.

## Phase 7 fresh verification ledger (2026-08-24)

| Command | Exit / count | Interpretation |
|---|---|---|
| `npx ai-devkit@latest lint` | 0 | Base lifecycle lint passes |
| `npx ai-devkit@latest lint --feature onchain-perps-dex` | 0, missing-worktree warning | Feature lint passes; dedicated worktree is absent |
| `cargo clippy --all-targets --all-features -- -D warnings` | 1 | Exact command unavailable because selected Solana toolchain has no `cargo-clippy` |
| `cargo +stable clippy --all-targets --all-features -- -D warnings` | 0 | Stable host clippy passes |
| `cargo test --all-features` | 101 | Exact command fails: Solana `rustc 1.79.0-dev` is incompatible with resolved dependencies |
| `cargo +stable test --all-features` | 0; **397 pass, 5 ignored** | common 45, oracle 5, core 225, lifecycle 8/4 ignored, matcher 114/1 ignored |
| `cargo build-sbf` | 0 | Four SBF programs build; no stack-offset overflow; one dead-code warning |
| `cargo build --lib --all` | 0 | Native libraries build |
| SDK test/typecheck/build | 0; **158/158** | Current SDK tests/build pass |
| Indexer test/typecheck/build | 0; **87/87** | Current indexer tests/build pass |
| Web test/typecheck/build | 0; **492/492** | Build required network for Google Fonts; unit stderr warnings remain |
| Web lint | 0, 9 warnings | No errors; not warning-clean |
| Chromium Playwright | 0; **39/39** | Required loopback bind outside the sandbox |
| Focused wallet Playwright | 0; **1/1** | Mocked deterministic wallet flow, not live signing |
| Live-signing/bridge/layout/trade Node tests | 0; **13/13** | Required loopback bind; arbitrary System transfer is currently accepted |

All pnpm evidence ran with a Node-engine mismatch: packages request Node 22;
the runner was Node `v24.10.0` and pnpm `8.15.9`.

### Required new coverage before alignment

1. Wrong owner/PDA/program/data-size and cross-batch substitution for every
   Clear/Settle/PostOrder account; checked bounds before variable account slices.
2. Fabricated-results conservation; post-STP header quantities must equal both
   fill legs; dual self-cross with zero fills must keep `mark_valid=0`.
3. PostOrder collateral, tick/lot, reduce-only, instrument, and overflow gates.
4. More than 256 place/cancel/fill cycles with reusable book slots.
5. PostOrder-only keeper settlement that discovers and requires all result
   owners' portfolios.
6. Global cap 64 from scratch 128 with price → size → order-ID overflow order.
7. D7 `f(mark-index)`, true Unix staleness, first-invalid-batch carry-forward,
   and funding/fee/volume conservation with checked arithmetic.
8. Rust/TypeScript golden layouts for Batch, Registry, Instrument,
   RestingOrder, results/fills, and all public discriminators/encoders.
9. Historical v0 ALT ingestion from transaction-time data with values above
   `2^53-1`; health reconciliation only after atomic cursor commit.
10. Keypair-batch resolution during indexer outage, strict expected batch ID,
    signer bridge program/account allowlists, and actual signature-status
    confirmation.

**Testing outcome:** not ready to enter Phase 8 as a completion phase. Repair
the Phase 7 implementation findings first, then use `dev-testing` to add and
run these scenarios. Historical pass counts remain history and are not current
completion evidence.
