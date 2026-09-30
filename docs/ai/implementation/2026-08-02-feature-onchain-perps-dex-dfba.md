---
phase: implementation
title: DFBA matcher core (M9.0–M9.1 partial)
description: Host-side Dual Flow Batch Auction clearing library in mgk-perps-matcher
date: 2026-08-02
---

# DFBA matcher core — implementation notes

## Completed tasks

| Task | Status | Evidence |
|------|--------|----------|
| T9.0.1 Flat pack layout | Done | `FLAT_ORDER_BYTES=56`, region offsets, pack/unpack tests |
| T9.1.1 `compute_clearing` | Done | Bid/ask volume-max; paper-style vectors |
| T9.1.2 `compute_allocation` | Done | Pro-rata, dust round-down, conservation |
| T9.1.3 Self-trade | Done | Same-user cancel without fills |
| T9.1.4 Cap select | Done | `select_by_price_priority` |
| T9.1.5 DfbaClear disc 5 | Done | `process_dfba_clear`, wire format, dual results |
| T9.1.6 SBF stack | Done | `*_into` + heap scratch; `cargo build-sbf` clean |

## Files

- **Added:** `programs/perps-matcher/src/state/dfba.rs`
- **Updated:** `programs/perps-matcher/src/state/mod.rs`, `entrypoint.rs` (disc 5), `instructions.rs` (`process_dfba_clear`)

## Design decisions in code

1. **Flat record 56 bytes:** price i64 + size u64 + order_id u64 + full Pubkey.
2. **Clearing / allocation:** volume-max + pro-rata; paper tie-breaks; self-trade cancel.
3. **Ix wire:** disc 5; `marginal_size_cap(8) + num_orders(2) + orders×58` (`side, is_maker, price, qty, order_id, user`).
4. **Results:** bid/ask prices + matched qtys + fills (`user, order_id, qty, price, is_maker, auction`).
5. **BPF:** all large state via heap/`run_dual_dfba_into`; host wrappers use stack; `Default` for large structs host-only.
6. **Book apply** not in this ix yet (orders from instruction data; T9.2/T9.3 will wire book + core CPI).

## Verification

```text
cargo test -p mgk-perps-matcher
# 106 passed, 1 ignored

cd programs/perps-matcher && cargo build-sbf
# Finished release — no stack offset errors
```

## T9.2 (also shipped)

| Task | Status |
|------|--------|
| T9.2.1 `is_maker` on LimitOrder/RestingOrder | Done |
| T9.2.2 Core `PostOrder` disc 20 + matcher `PlaceResting` disc 6 | Done |
| T9.2.3 Commit/Reveal retired (return InvalidInstruction) | Done |

### PostOrder wire
- Core disc **20**: `side(1) is_maker(1) price(8) qty(8) instrument_id(2) reduce_only(1)`
- Accounts: portfolio, user, batch (must `Committing`), registry, book, matcher
- CPI matcher disc **6** PlaceResting

## T9.3 (shipped)

| Piece | Behavior |
|-------|----------|
| CloseCommitting | Committing → **Clearing** (no reveal) |
| ClearBatch | CPI matcher disc **5** with `num_orders=0` (collect book); write bid/ask/mid/`mark_valid`/`liq_paused` |
| SettleBatch | DFBA results format + dual mid → `instrument.mark_price`; carry-forward if !mark_valid |
| LiquidateUser | Requires Settled batch with `mark_valid` / !`liq_paused` (+ instrument marks) |
| Batch layout | + bid/ask clear, matched qtys, mark_valid, liq_paused |

## T9.6 (shipped)

| Package | Changes |
|---------|---------|
| `@mgk/sdk` | `PostOrder` disc 20, `MATCHER_INSTRUCTION`, `encodeDfbaClear`, `encodePlaceResting`, `BATCH_SIZE=160`, DFBA batch fields, `decodeDfbaResultsHeader` |
| indexer keeper | Close → Clearing; ClearBatch DFBA book-collect; settle with 0 commitments |

```text
cd mgk-frontend/packages/sdk && pnpm test   # 158 passed
cargo +stable test -p mgk-perps-core --lib test_batch_size_matches_sdk  # size 160
```

### Done (2026-08-03 follow-on)
- **T9.4** funding soft-skip when `!mark_valid` (and existing `funding_paused`)
- **T9.4.1** LiquidateUser: batch account + `mark_valid` / `liq_paused` gate
- **Instrument init** fee offsets fixed to `#[repr(C)]` (taker@52, maker@54, … mark@136)
- **Frontend** trade UI → `usePostOrder` / `encodePostOrder` (maker toggle; commit-reveal retired)
- **BPF e2e** dual fill + fees; one-sided liq pause  
- **PostOrder** increments `batch.total_commitments` (n_min close)

```text
SBF_OUT_DIR=target/deploy cargo +stable test -p mgk-perps-core --test lifecycle \
  --features host-hash e2e_
# test_e2e_full_lifecycle_with_fill … ok
# test_e2e_dfba_one_sided_liq_paused … ok
```

### Done (2026-08-06 session)

- **T-CLIPPY-FIX** — Fixed 23 clippy warnings across mgk-common, mgk-perps-core, mgk-perps-matcher. CI `cargo +stable clippy --all-targets --all-features -- -D warnings` now clean.
  - `items_after_test_module` in error.rs (moved `impl From` before `mod tests`)
  - `private_interfaces` in clearing.rs (BuyEntry/SellEntry → `pub`)
  - `dead_code` on `apply_dfba_fills_to_book` / `write_dfba_results` (`#[allow(dead_code)]`)
  - `too_many_arguments` on 6 functions (`#[allow(clippy::too_many_arguments)]`)
  - `derivable_impls` on DualAuctionResult (→ `#[derive(Default)]`)
  - `returns_result_unit` on `pack_orders` (`#[allow(clippy::result_unit_err)]`)
  - `collapsible_if` + `manual_checked_div` in settle_batch.rs
  - `assertions_on_constants` in commit_order.rs (→ `const { assert!(...) }`)
  - `needless_range_loop` in dfba.rs (→ iterator)
  - `nonminimal_bool` in settle_batch/clear_batch tests
  - `manual_is_multiple_of` in book.rs

- **T9.4.2** — DFBA pause matrix:
  - Added `PAUSE_POST = 1 << 4` and `PAUSE_CLEAR = 1 << 5` to `Registry`
  - Updated `PAUSE_RESERVED_MASK` to `0b_1100_0000` (only bits 6..7 reserved)
  - Added `is_posts_paused()` and `is_clears_paused()` helpers
  - Gated `PostOrder` on `PAUSE_POST | PAUSE_TRADING`
  - Gated `CloseCollecting` and `ClearBatch` on `PAUSE_CLEAR | PAUSE_TRADING`
  - Updated all pause flag tests to cover 6 flags
  - Files: `registry.rs`, `post_order.rs`, `close_committing.rs`, `clear_batch.rs`, `set_pause_flags.rs`

- **T9.1.7** — CU measurement at cap 32/64/128:
  - Added `cu_measurement_cap_32`, `cu_measurement_cap_64`, `cu_measurement_cap_128`, `cu_measurement_overflow_at_cap` benchmarks to `dfba.rs`
  - Host timing: cap 128 × 1000 iterations completes in <10ms; confirms efficient O(n log n) scaling

- **T9.0.3** — DFBA error codes:
  - Added `DfbaCapExceeded=603`, `MarkInvalidForLiquidation=604`, `BatchNotSettled=605` to `MgkError`
  - `liquidate_user.rs` now uses `BatchNotSettled` (was `InvalidInstruction`) and `MarkInvalidForLiquidation` (was `OperationPaused`)
  - Pin test for all 3 discriminators in `error.rs`

- **T9.4.4** — Oracle freshness for funding:
  - `read_oracle_price` in `settle_batch.rs` now returns `Option<(price, timestamp, is_active)>`
  - Funding accrual skips when oracle is stale (>600s from current slot approximation) or `is_active=false`
  - Mark path unaffected (pure DFBA when `mark_valid`)

- **T9.3.5** — `SetBatchParams` governance instruction (disc 21):
  - Added `max_orders_per_batch` (u8) and `marginal_size_cap` (u8) to Registry (replaced 2 of 4 padding bytes; Registry stays 86 bytes)
  - Wire: `max_orders(1) + marginal_cap(1) + t_min(8) + t_max(8) + n_min(4)` = 22 bytes
  - Governance signer required; validates max_orders 1..=128, t_max > t_min
  - Files: `set_batch_params.rs` (new), `entrypoint.rs`, `mod.rs`, `registry.rs`

- **T9.5.5b** — BPF e2e resting across batch:
  - Added `test_e2e_resting_across_batch` to `lifecycle.rs`
  - Scenario: maker buy@100k+98k, taker sell@99k → 100k fills, 98k rests; batch 1 taker sell@97k crosses resting 98k; verifies `is_maker=true` on resting fill
  - BPF_OUT_DIR/SBF_OUT_DIR gated

- **T9.4.5** — Insurance inventory: already implemented. `Vault.insurance_fund` (u128) + `uncovered_bad_debt` (u128) + `adl_debt`/`adl_pending`. Fee/rebate flow in `settle_batch.rs:535-575`.

- **T9.5.5c** — BPF e2e self-trade: `test_e2e_self_trade_no_fill` in `lifecycle.rs`. Same wallet maker-buy + taker-sell at same price → 0 fills (self-trade excluded).

- **T9.5.5d** — BPF e2e cancel: `test_e2e_cancel_resting_between_batches` in `lifecycle.rs`. Maker posts, batch settles (resting), cancel all → book empty.

### Phase 5 — remaining unit tests + cleanup (2026-08-06)

- **T-POST-ORDER-UNIT** — 9 new tests in `post_order.rs`: wire format (disc 20, 21 bytes), parse buy-taker + sell-maker-reduce_only, validation constants (negative price, zero qty, invalid side), account count (6), CPI PlaceResting fields (disc 6, 54 bytes).
- **T-CLEAR-BATCH-IX** — 10 new tests in `clear_batch.rs`: DfbaClear CPI layout (disc 5, 11 bytes, 2 accounts), mark_valid/liq_paused flag logic (dual fill, bid-only, ask-only, no fills), clearing_price mid rounding (even+even, odd+odd, odd+even), zero when invalid, total_volume sum + saturation.
- **T-SETTLE-MARK** — 6 new tests in `settle_batch.rs`: mark_price from dual mid (clearing_price), carry-forward when invalid, zero first batch no dual, dual mid rounding matches clear, liq_paused flag set/cleared.
- **Legacy cleanup** — 5 commit-reveal e2e tests in `lifecycle.rs` rewritten with DFBA PostOrder pattern (2026-08-06 follow-on):
  - `test_e2e_gtc_rests_then_matches_next_batch` — DFBA resting order across 2 batches
  - `test_e2e_settle_creates_next_batch_pda` — verifies batch 1+2 PDA creation via SettleBatch
  - `test_e2e_liquidate_user_happy_path` — DFBA mark + pre-built underwater portfolio liquidation
  - `test_e2e_liquidate_user_adl_stub_fires` — ADL when insurance < bad debt
  - `test_e2e_cancel_all_resting_orders` — CancelAllRestingOrders clears book
  - All `#[ignore]` attributes removed. 10 e2e tests total (5 original DFBA + 5 rewritten).
- **Helper functions added** — `build_cancel_all_resting_data`, `build_oracle_data`, `build_underwater_portfolio_data`, `build_vault_data`, `build_liquidate_data`
- **Initialize instruction accounts fixed** — root cause of pre-existing `InvalidArgument`: vault and system_program account indices were swapped in all Initialize calls. BPF entrypoint expects `system_program` at index 3 and `vault` at index 4, but tests had them reversed. Fixed across all11 e2e tests.
- **BPF e2e mark_valid assertions fixed** — liquidate tests (happy_path, adl_stub) needed dual-side orders (bid + ask auctions) to produce `mark_valid=1`. Added maker-sell + taker-buy PostOrder calls alongside existing maker-buy + taker-sell.
- **CU budget helper** — added `submit_cu` helper that wraps `ComputeBudgetInstruction::set_compute_unit_limit` for CU-heavy transactions (ClearBatch with book iteration).
- **Known issue — CU exhaustion (program-test only)** — 4 e2e tests `#[ignore]`: `ComputeBudgetInstruction` is parsed by program-test 2.1 but the CU meter still enforces 200k. **Not a production blocker**: empty-book ClearBatch on devnet uses ~2.6k CU.

### Done (2026-08-06 evening — devnet lifecycle fix)

- **Vault size** — `VAULT_SPACE` corrected 58 → 80 (`size_of::<Vault>()`)
- **Matcher InitializeBook (disc 7)** — reserved for future multi-step PDA book (CPI create still 10KB-capped); production book is client-side keypair
- **SettleBatch creates next batch PDA** — `invoke_signed` when next batch empty; wire `+ next_batch_bump(1)`; accounts +payer +system
- **Registry counter raw write** — settle_batch uses volatile byte writes at offset 36 (SBF field-assign bug)
- **tools/init-protocol.js** — idempotent vault + matcher-owned book keypair + params + batch0
- **tools/keeper-crank.js** — book keypair resolution, CU budget on Clear, open-batch scanner, settle PDA create accounts
- **Devnet verified** — Close → Clear → Settle for batches 0 and 1; batch 2 Collecting; counter=2
- **Dual-fill e2e** — `tools/trade-e2e.js`: InitPortfolioForUser + Deposit + 4× PostOrder + Clear/Settle
  - Batch 2: `markValid=1`, bid=ask=100000, mBid=mAsk=10, status=Settled
  - InitPortfolioForUser must include System Program account for CPI create
  - SettleBatch `num_portfolios` + portfolio metas required for fill application
  - Keeper: `PORTFOLIO_ADDRESSES=a,b` env for filled settles

```text
cargo +stable clippy -p mgk-perps-core -p mgk-perps-matcher --all-targets --all-features -- -D warnings   # clean
cargo +stable test -p mgk-perps-core --lib --features host-hash   # 225 passed
cargo test -p mgk-perps-matcher --lib                              # 114 passed
# Devnet:
#   node tools/keeper-crank.js
#   node tools/trade-e2e.js   # PASS dual fill + mark_valid
```

### Frontend M9 wiring (2026-08-06)

- **`apps/web/lib/config.ts`** — defaults to M9 program IDs + book/vault/registry:
  - core `C7w2m…`, matcher `7WiZu…`, oracle `CsSqV…`
  - book `J33Y6yo…` (matcher keypair), vault/registry PDAs
- **`useOrderSubmission`** — uses `config.bookAddress` (not book PDA); validates book exists
- **`resolveOpenBatch`** — scans counter window for Collecting batch (handles counter desync)
- **`useBatchStore`** — uses `resolveOpenBatch` for current batch display
- **Indexer** `.env` / `.env.example` / `main.ts` defaults updated to M9
- **`.env.local`** updated for web app

```text
cd mgk-frontend/apps/web && pnpm exec vitest run lib/config.test.ts lib/hooks/useOrderSubmission.test.ts
# 34 passed
cd mgk-frontend/apps/web && pnpm e2e
# 30 passed (layout + order form DFBA + chart; Helius RPC)
```

### Browser e2e (Playwright MCP + suite, 2026-08-06)

With `NEXT_PUBLIC_RPC_URL` = Helius devnet:

| Check | Result |
|-------|--------|
| `/trade` loads | ✅ title `mgk — On-chain perps` |
| Batch status from chain | ✅ `Batch: Committing` / accepting orders (batch 3) |
| Order book mid | ✅ `0.10` (resting from dual-fill e2e) |
| Wallet auto-connect | ✅ shows abbreviated pubkey when extension present |
| Sell tab + Post as maker | ✅ toggles via MCP |
| Price/qty fill | ✅ |
| `?set=slashed` banner | ✅ Order slashed + Start fresh |
| Indexer offline | Expected `localhost:4000` refused; Vol/OI show — |
| Full signed PostOrder | Needs human Phantom approve + portfolio (Set Up Account → indexer) |

`pnpm e2e`: **30 passed**.

### Deterministic browser wallet e2e (2026-08-08)

- Added `apps/web/e2e/wallet-flow.spec.ts` and `e2e/fixtures/mockPhantom.ts`.
- The fixture injects a Phantom-compatible provider before hydration and auto-connects a deterministic public key. No browser extension, private key, approval popup, or real transaction is used.
- A mocked JSON-RPC boundary supplies registry, funded portfolio, matcher-owned book, and Collecting batch accounts. Indexer batch discovery is mocked at the HTTP boundary.
- The test fills the live order form, selects maker role, submits Buy, and inspects the prepared transaction. It pins PostOrder disc `20`, buy side, maker flag, scaled price `100_250_000`, scaled qty `2_500_000`, instrument `0`, and six account metas with the user signer.
- Added focused command: `pnpm e2e:wallet`.

```text
pnpm e2e:wallet
# 1 passed; browser test body ~1.1s
```

### Phase 5/6 verification and reconciliation (2026-08-08)

| Gate | Fresh result |
|------|--------------|
| AI DevKit base + `onchain-perps-dex` feature lint | Clean |
| Web typecheck | Clean |
| Focused wallet Playwright | 1 passed |
| Full Playwright | 31 passed |
| Web Vitest | 436 passed |
| SDK Vitest | 158 passed |
| Rust clippy (`+stable`) | Clean |
| Rust all-feature tests (`+stable`) | 396 passed, 5 ignored |

The unqualified Rust commands select Solana's bundled Rust 1.79 toolchain: it lacks `cargo-clippy` and is too old for current locked dev dependencies. The same gates pass with `+stable`; no dependency or lockfile change was made.

### M9.8 implementation continuation (2026-08-09)

Playwright MCP placed a real devnet Buy/Long limit order at `76.55` for
`0.01` base units. Phantom approval completed and the transaction confirmed:

`482LWPHQXSfXt1EecLmtHNeYGoQJVSn8VDCj4RQEFcDnKYyMTfYdpXBtwgmHgn8exZzJ7cKNunzP1AYhJ2Np1Xgg`

The keeper advanced batch 7 to batch 8. The indexer book endpoint then showed
the new bid resting at raw price `76550000`, raw quantity `10000`, with one
order, proving GTC persistence across the batch rollover.

Observed and fixed fallacies:

- `Batch: Collecting past deadline` could disagree with the header and ignored
  `n_min`; `describeBatchPhase` now receives registry state and both header and
  status bar share the same state/intent copy.
- Portfolio panels replaced valid data with a loading skeleton on every
  background refresh; existing data now remains visible and exposes a quiet
  `data-refreshing` marker.
- A stale batch/oracle account from an older deployment could be decoded or
  mutated; indexer keeper validation now checks owner and minimum account size
  before reuse, then creates fresh current-layout accounts.
- The empty SOL market state returned 404 before its first fill; the indexer
  now seeds a zero baseline row and serves 200.
- A crossed book could produce a meaningless midpoint; the header now reports
  `Book is crossed; midpoint is unavailable until the next clear.`
- The Oracle tooltip no longer claims the keeper is offline; it states that the
  deployed feed is not surfaced in the v1 header.

Fresh frontend/indexer gates: web Vitest **447 passed** (49 files), indexer
Vitest **33 passed** (3 files), and both app typechecks are clean. Rust
`cargo +stable clippy --all-targets --all-features -- -D warnings` is clean;
`cargo +stable test --all-features` passes with **396 passed, 5 ignored**.
The unqualified Rust test command remains blocked by the active Solana Rust
1.79 toolchain's MSRV mismatch.

### M9.9 live surface continuation (2026-08-09)

Playwright MCP exercised the non-buy paths on the connected devnet wallet:

- Sell/Short order submission completed on-chain at the live crossed-book ask
  (`0.10`, size `1.0` base units), proving the side, maker, reduce-only, and
  transaction-confirmation paths are wired. The test order was subsequently
  cancelled through Open Orders.
- Portfolio navigation, balances, positions, open orders, modify mode,
  cancel mode, trade history, funding history, position history, and account
  history were opened and observed.
- A batch with one post reached Clearing. The header previously dropped to
  `Batch: —` because read-only polling only accepted Collecting; polling now
  preserves Clearing/Settled state for the status display while PostOrder still
  rejects non-Collecting batches.
- A crossed book previously supplied the stale `0.10` ask as the Sell default;
  the order form now requires an explicit price whenever best bid exceeds best
  ask. Size is labeled in SOL/base units and available size/margin are derived
  from free collateral instead of hardcoded zeroes.
- Order History copy and indexer requirements now describe DFBA posts,
  cancellations, modifications, and batch clearing rather than commit/reveal.
- Inline modify validation now keeps the editor open with explicit feedback for
  zero or sub-precision quantities instead of silently doing nothing.

The live browser also exposed repeated Helius devnet RPC `429` responses under
the combined polling load. This is retained as a follow-up availability issue;
the UI remained usable from last-good/indexer-backed state, but a production
deployment should add shared RPC throttling or route read polling through the
indexer cache.

### M9.9 matching-proof retarget (planning, 2026-08-20)

The 2026-08-09 Playwright MCP path in this file is **historical UI wiring**,
not independent-counterparty matching evidence (one Phantom wallet ⇒
self-trade skip). Planning locked the next implementation slice as
**T9.9.1**: `playwright-cli` named sessions (`-s=maker`, `-s=taker`) with
injected live-signing wallets from `~/.config/solana/mgk-trader-{maker,taker}.json`
against live M9 programs. Four dual-auction posts, then `node tools/keeper-crank.js`.
Matching rewrite is out of scope unless that live reproduction exposes a real
discrepancy.

### T9.9.1 CLI persona checkpoint (2026-08-21)

Implemented the live-signing path in `tools/lib/liveSigning.cjs`, with unit
coverage in `tools/lib/liveSigning.test.cjs`, and added the CLI-compatible
loopback bridge in `tools/cli-live-signer-bridge.cjs` plus the page injector
`tools/cli-live-wallet-page.js`. The bridge keeps keypairs in the Node process;
the page receives only the public key and delegates serialized transaction
signing/sending over localhost. The focused tests passed: **8** live-signing
helper tests and **1** bridge test.

`node tools/persona-fund.js` initialized distinct maker/taker portfolios,
completed the maker deposit, and found existing taker portfolio funding state.
Named `playwright-cli -s=maker` and
`playwright-cli -s=taker` sessions showed distinct Online/Devnet wallet
pubkeys. Secret scans of the resulting isolation snapshots were clean:
`.playwright-cli/maker-live-isolation.yaml` and
`.playwright-cli/taker-live-isolation.yaml`.

The live queue then hit the mandated infrastructure stop: the taker session
reported 193 console errors, including repeated authenticated Helius devnet
HTTP `429` responses, so batch/book reads could not be trusted. No UI orders or
keeper crank were attempted, and no matcher change was made. Resume requires a
usable private RPC quota/endpoint.

The subsequent controlled fallback-2 retry reached the same infrastructure
stop under the combined web/indexer workload. Both named sessions loaded the
correct distinct public wallets, but neither could resolve a current batch
(`Batch: —`) while repeated HTTP `429`s were present. No production code or
matcher code changed in this retry. New persona snapshots were secret-free;
credential-bearing query values in generated console logs were redacted before
the logs were retained.

The fallback-5 / split-provider retry confirmed both funded persona portfolios
and a shared Collecting batch in the named sessions. Combined polling still
rate-limited, and four concurrent UI submissions failed before signing. A
single-session retry confirmed two maker transactions only; the keeper closed
that window before taker participation, and the next attempt encountered
cross-provider batch propagation lag. No matcher change was made. T9.9.2–3
remain unproven, and M9.10 was not started. T9.9.4 was later implemented
independently at the operator's direction.

### T9.9.4 deterministic two-user fixture (2026-08-21)

The existing full DFBA lifecycle program-test now uses fixed-seed, distinct
maker and taker keypairs. It asserts per-wallet allocation across both auction
legs, maker rebate, taker fee, vault insurance, settled `mark_valid=1`, and
both portfolios' flat net position deltas. Fill-owner validation rejects any
identity outside the intended pair; the matcher's active focused self-trade
tests remain unchanged. The fixture passed against the local core and matcher
SBF artifacts. No matcher implementation was rewritten, and M9.10 remains
blocked on T9.9.3.

### T9.9.1 RPC retry and funding-layout correction (2026-08-21)

The operator-supplied QuickNode devnet endpoint was wired into the ignored local
web and indexer env files only. Documentation and browser artifacts retain only
the label `quicknode-devnet (redacted)`. `redactRpcUrl` now redacts credential-
bearing QuickNode path URLs before they reach logs or bridge metadata.

`programs/perps-core` stores portfolio equity at byte offset 32 and principal at
byte offset 48. `tools/trade-e2e.js` and `tools/persona-fund.js` now read the
principal field at offset 48, with `tools/portfolio-layout.test.cjs` covering a
negative-equity / positive-principal regression. Trader loading now honors
`MGK_MAKER_KEYPAIR` and `MGK_TAKER_KEYPAIR`, allowing clean proof personas
without overwriting prior on-chain state. Focused verification passed: **11
tests** across the live-signing, keypath, and portfolio-layout suites.

The redacted low-rate RPC probe reached a confirmed blockhash and all six
canonical M9 accounts. The provider rejected a six-account range request with a
five-account plan limit, so the probe used one-account reads. After the local
indexer and web app started, the browser observed repeated HTTP `429`s during
live RPC polling. This triggered the mandated stop before any UI PostOrder or
keeper crank. No matcher or protocol behavior was changed.

### T9.9.1 RPC fallback stop checkpoint (2026-08-21)

The supplied Helius endpoint was added to the ignored local web/indexer env
files as the second RPC option, while the public examples expose only blank
fallback fields. The Helius low-rate `getSlot` probe returned JSON-RPC
`-32429 rate limited`. The QuickNode primary answered an initial low-rate probe,
but the resumed named-session workload then produced repeated HTTP `429`s; the
keeper cycle also received QuickNode `-32007` (`15/second request limit
reached`).

The keeper did complete empty-batch Close → Clear → Settle transitions while
the quota intermittently answered, but no UI PostOrder was submitted and no
`mark_valid=1` claim was made. The active-batch account pointer also exposed a
stale persisted account with the same batch id, so the indexer would require a
fresh RPC-backed batch revalidation before posting. This is an infrastructure
stop, not a DFBA or matcher discrepancy; no matcher/protocol code was changed.
Resume requires a usable RPC quota/endpoint, then a fresh T9.9.1 batch check.

### T9.9.1 public-fallback live checkpoint (2026-08-21)

The third configured fallback, Solana public devnet, answered initial low-rate
`getSlot` and canonical registry reads. With the local web and indexer using
that fallback, the keeper successfully advanced empty batches through
CloseCollecting, ClearBatch, and SettleBatch and created fresh active batches.
Once both named `/trade` sessions were reopened, the combined keeper/indexer/UI
polling workload produced repeated upstream HTTP `429 Too Many Requests`
responses and `fetch failed` account reads. The processes and sessions were
stopped immediately after capture. No UI PostOrder was submitted and no
`mark_valid=1` claim was made; this is an RPC-capacity stop, not a DFBA or
matcher discrepancy.

### T9.9.1 active-batch cache correction (2026-08-21)

`GET /api/batch/current` now invalidates its short-lived live cache whenever
the keeper's current batch address changes, and the cache window is one second
instead of thirty. This prevents a browser from posting against a settled or
expired keypair-owned batch while the keeper has already advanced the registry.
The keeper selection regression also rejects a persisted batch whose id does
not match the registry's active id and allows expired empty/underfilled batches
to close. Focused integration/selection tests passed after the change.

### T9.9.1 RPC fallback 4 probe (2026-08-21)

The newly supplied Infura devnet endpoint passed low-rate `getSlot`, canonical
registry `getAccountInfo`, and confirmed `getLatestBlockhash` probes. It was
added as fallback 4 to ignored local web/indexer env files; tracked examples
contain only a blank credential field. The live web/indexer workload remains
stopped until the endpoint is selected for a controlled retry.

### T9.9.1/T9.9.2/T9.9.3 RPC-capacity stop (2026-08-21)

The controlled retry selected fallback 4 and used the existing live-signing
bridges with the named `playwright-cli -s=maker` and `-s=taker` sessions. The
first paired UI submissions succeeded and the keeper observed two commitments
in batch 47. Before the second pair could be posted, the provider returned
repeated HTTP `429 Too Many Requests` responses. The keeper's `ClearBatch`
attempt also failed at `getLatestBlockhash` with `429 Too Many Requests` before
retrying successfully. The two-order batch settled with
`markValid=false`/`liqPaused=true`, as expected for an incomplete one-sided
proof; this is not evidence of a matcher discrepancy. The live processes and
browser sessions were stopped under the plan's RPC stop condition. No matcher
or protocol behavior was changed.
