---
phase: implementation
title: On-Chain Perps DEX — Phase 7 Implementation Check
description: Full working-tree alignment review against requirements, design, planning, testing, and fresh local plus read-only devnet evidence
date: 2026-08-24
status: not-aligned
feature: onchain-perps-dex
baseline: 910c1ebf415fbd4f9cb1120ad29be0302da51279
---

# On-Chain Perps DEX — Phase 7 Implementation Check

## Verdict

**Not aligned. Return to Execute Plan (`dev-implementation`) before Phase 8.**

The working tree contains the intended DFBA wire discriminators, dual-auction
path, persistent resting-order role, pause gates, liquidation mark gate, SDK/web
PostOrder flow, indexer health UI, and a finalized two-wallet devnet proof.
However, the review found security-critical account-substitution, risk,
self-trade/mark, book-liveness, and keeper-settlement defects. Major cap,
funding, accounting, SDK, indexer, health, web-resolution, signer, confirmation,
and arithmetic gaps also remain. Passing tests and finalized devnet
transactions do not cover or disprove these findings.

No production code, program deployment, transaction, keypair, environment, or
branch/worktree mutation was made during this check. Only this implementation
record and the associated planning/testing records were reconciled.

## Review boundary

- Baseline: `HEAD` = `910c1ebf415fbd4f9cb1120ad29be0302da51279`
  on `master`; the obsolete `feature-onchain-perps-dex` branch at `2fa405a` was
  not used.
- Scope: the full feature-related tracked and untracked working tree, including
  protocol, SDK, indexer, web, operational tools, tests, and lifecycle docs.
- Excluded as unrelated or generated: `docs/ifc-pitch/`, demo-only web assets,
  screenshots, `.playwright-*` captures, `.freebuff/`, downloaded skill files,
  local SQLite databases/WAL files, and build artifacts.
- Tracked generated/stale entries were reviewed as repository-hygiene findings,
  not as feature implementation: `mgk-frontend/apps/indexer/data/indexer.db-shm`
  and the deleted `.worktrees/*` entries.
- Parent lifecycle task tracing was not discoverable read-only; tracing is
  recorded as unavailable.

## Inventory and milestone mapping

| Milestone | Reviewed implementation and evidence |
|---|---|
| M9.0 contracts | `programs/common/src/{error,program_ids}.rs`; core/matcher instruction enums and entrypoints; SDK discriminator tables, encoders, state types and decoders; requirements/design wire tables |
| M9.1 matcher DFBA | `programs/perps-matcher/src/{entrypoint,instructions}.rs`, `state/{clearing,dfba}.rs`, inline unit tests, lifecycle fixtures |
| M9.2 book/PostOrder | core `instructions/post_order.rs`; matcher `state/{book,clob}.rs`; SDK `programs/core.ts`; web `useOrderSubmission.ts`, order form/open-order components and tests |
| M9.3 lifecycle | core `instructions/{create_batch,close_committing,clear_batch,settle_batch,set_batch_params}.rs`, `state/registry.rs`, `tests/lifecycle.rs`; keeper/crank tools |
| M9.4 risk/pause/oracle | core `instructions/{set_pause_flags,liquidate_user,settle_batch,post_order}.rs`, common math/account helpers, oracle state consumption, relevant tests |
| M9.5 verification | all Rust inline/lifecycle tests; SDK/indexer/web unit tests; Playwright Chromium suites; Node tool tests; SBF/native builds |
| M9.6 consumers | SDK `src/{index,instruction,programs,state}/**`; indexer decoders, store, backfill/syncer, REST and tests; web batch/account decoding and views |
| M9.7 deferred/docs | `docs/ARCHITECTURE.md`, requirements/design/planning/implementation/testing/deployment/monitoring records; legacy commit/reveal surfaces |
| M9.8 web | trade page/layout, config, batch and health stores, timeline/header/status/chart/history/portfolio/order components, E2E fixtures/specs and package scripts |
| M9.9 live proof | `tools/{persona-fund,keeper-crank,trade-e2e,cli-live-signer-bridge,portfolio-layout}*`, live-signing helper/tests, recorded transactions/accounts, August 24 implementation history |
| M9.10.1–3,5–7 | `tools/init-protocol.js`, keeper confirmation and selection, funding/mark settlement, reduce-only UI and paper-lot coverage |
| M9.10.4 health | indexer `healthTracker.ts`, `syncer.ts`, `store.ts`, `rest/health.ts`, `main.ts` and tests; web `useIndexerHealthStore.ts`, StatusBar/MarketHeader/ChartToolbar/TradeHistory and tests |

Relevant untracked source included the new `set_batch_params.rs`, indexer
sync/health/runtime/keeper-selection sources and tests, web health store and E2E
specs/fixtures, and `tools/`. Relevant tracked changes comprised all modified
feature files under `programs/`, `mgk-frontend/packages/sdk/`,
`mgk-frontend/apps/{indexer,web}/`, and `docs/ai/` shown by
`git diff --name-status 910c1eb`. Nothing in those sets was assumed correct
because it was already documented as done.

## Contract alignment observed

- Rust dispatch correctly uses single-byte discriminators: core `PostOrder=20`
  and `SetBatchParams=21`; matcher `DfbaClear=5`, `PlaceResting=6`, and
  `InitializeBook=7`.
- `PostOrder` is a 22-byte instruction and defaults to taker in the TypeScript
  encoder. Its matcher CPI is 54 bytes and preserves `is_maker` on the Rust
  resting-order layout.
- The Batch remains 160 bytes and carries bid/ask clears, matched quantities,
  `mark_valid`, and `liq_paused`. The intended Collecting → Clearing → Settled
  path and permissionless close/clear shape are present.
- Dual-mid is used when both result-header matched quantities are positive;
  invalid marks gate liquidation in
  `programs/perps-core/src/instructions/liquidate_user.rs:123-142`.
- Post and clear pause flags are enforced; direct cancel/modify and full-rest
  fields exist; custody lamports remain in core rather than matcher accounts.
- The indexer exposes `/api/healthz` and the web app models
  `warming|healthy|degraded|critical` plus reconnecting/unreachable display
  states. Unit and browser tests cover the displayed boundaries.
- The recorded M9.9 Close → Clear → Settle transactions are finalized on
  devnet. This proves execution of that deployed path, not source/deployment
  identity or semantic alignment.

## Findings

### Critical

#### C1 — SettleBatch accepts substitutable results, oracle, and portfolio accounts

- Evidence: `programs/perps-core/src/entrypoint.rs:792-812` derives unchecked
  variable account slices and validates only batch/registry/vault/instrument;
  it does not bind results to matcher ownership or a batch/book, validate the
  matcher program ID, validate portfolio owners/data sizes, or validate the
  oracle owner/instrument. `settle_batch.rs:238-273` trusts a header with no
  magic, batch ID, book ID, or seal; `settle_batch.rs:298-378` applies those
  fills through unsafe casts to caller-supplied portfolios. The oracle reader
  validates only magic at `settle_batch.rs:87-107`.
- Violation: account-validation/custody-isolation requirements and the shipped
  Batch/results/account-meta contract.
- Impact: a permissionless caller can race settlement with fabricated result
  bytes, manufacture sell-side equity or positions in supplied core portfolios,
  influence funding with a substitute oracle, or crash on malformed accounts.
- Missing tests: adversarial wrong-owner/wrong-size results, wrong matcher ID,
  results from another batch/book, duplicate/missing portfolios, fabricated
  fill conservation, wrong-owner/wrong-instrument oracle, and account-count
  overflow before slicing.

#### C2 — ClearBatch has the same unchecked account-list and arbitrary-CPI boundary

- Evidence: `programs/perps-core/src/entrypoint.rs:710-735` slices three
  caller-controlled variable regions before checking the computed end and
  validates only the batch and results writability. `clear_batch.rs:88-114`
  invokes the supplied matcher program; `clear_batch.rs:116-145` trusts its
  supplied results header to set mark and liquidation state.
- Violation: hardcoded program-ID, PDA/owner, and checked-account-meta
  requirements.
- Impact: an arbitrary executable or substitute results account can determine
  the batch's mark-valid header and downstream liquidation gate.
- Missing tests: wrong matcher executable, wrong book/results owner or PDA,
  truncated variable lists, oversized counts, and CPI output identity/binding.

#### C3 — PostOrder omits collateral/risk enforcement and matcher/book binding

- Evidence: `programs/perps-core/src/instructions/post_order.rs:48-65` reads the
  registry before validation and validates neither the matcher ID nor book
  owner/PDA/instrument. Lines `67-89` check only quantity, price, side, batch
  status, and user ownership; there is no instrument account, tick/lot check,
  free-collateral or margin cap, position/reduce-only enforcement. Lines
  `103-117` CPI to the supplied program and then increment bookkeeping.
- Violation: M9 risk/cap requirements, reduce-only semantics, hardcoded program
  IDs, checked arithmetic, and account binding.
- Impact: users can post undercollateralized or invalid reduce-only orders and
  can use an arbitrary CPI target while core records the post as accepted.
- Missing tests: insufficient margin, tick/lot rejection, reduce-only opening or
  over-reducing, instrument mismatch, wrong matcher/book, CPI failure/false
  success, and `total_commitments` overflow.

#### C4 — Pre-STP matched quantities can manufacture a valid liquidation mark

- Evidence: matcher writes `bid.matched_qty` and `ask.matched_qty` before
  allocation/STP at `programs/perps-matcher/src/instructions.rs:543-594`, then
  commits those values to the header at `605-612`. STP removes same-user size
  in `state/dfba.rs:315-325`, and actual matched allocation is recomputed at
  `328-369`. Core nevertheless treats the pre-STP header as authoritative at
  `programs/perps-core/src/instructions/clear_batch.rs:124-145`.
- Violation: self-trade prevention, conservation, and D6 current-batch dual
  mark validity.
- Impact: one user can self-cross both auctions, produce zero actual fills, yet
  set arbitrary bid/ask header prices, `mark_valid=1`, and unpause liquidation.
- Missing tests: dual self-cross with zero post-STP fills must keep mark invalid;
  header matched quantities must equal maker/taker fill sums after STP.

#### C5 — Resting-order storage is permanently exhaustible after 256 placements

- Evidence: capacity is 256 (`state/book.rs:11-16`); placement always appends at
  the high-water `resting_count` (`144-182`). Cancellation clears a slot but
  does not reclaim it (`332-335`), despite the reuse claim at `396-400`.
  Fully-filled orders only update `filled_qty` at
  `instructions.rs:676-688`; they are not removed or reusable.
- Violation: persistent-rest availability and bounded-resource requirements.
- Impact: cumulative public posts can make a market return `BookError::Full`
  forever even when it has no live orders, requiring account migration or
  redeployment to recover.
- Missing tests: more than 256 cumulative place/cancel cycles, filled-slot
  reuse, mixed-price reuse, and long multi-batch persistence.

#### C6 — The production keeper omits DFBA user portfolios at settlement

- Evidence: `mgk-frontend/apps/indexer/src/keeper.ts:875-923` discovers users
  only from legacy commitment accounts. PostOrder-based DFBA normally has zero
  commitments, so it sends zero portfolios. Core only applies fills to supplied
  matching portfolios (`settle_batch.rs:330-378`) but still settles the batch.
  The M9.9 proof had to pass `PORTFOLIO_ADDRESSES` manually to a separate tool.
- Violation: M9.3 settlement, M9.6 consumer integration, and permissionless
  keeper completeness.
- Impact: normal keeper operation can finalize a filled batch without updating
  any user's position, equity, fee, margin, or funding state.
- Missing tests: PostOrder-only keeper settlement with two users; every result
  owner must map to exactly one writable core portfolio; reject missing owners.

### Major

#### M1 — Cap/overflow selection does not implement locked D2/D8 semantics

- Evidence: matcher allocates four independent 64-order regions and silently
  drops later orders in encounter order (`instructions.rs:381-428`), allowing
  up to 256 selected orders rather than a global cap of 64 from scratch 128.
  Core hardcodes `u64::MAX` for marginal size (`clear_batch.rs:88-92`) and never
  consumes Registry parameters. Registry stores marginal size in a `u8`
  (`state/registry.rs:36-43`).
- Violation: D2 global `per_batch_order_cap=64`, scratch maximum 128, and D8
  overflow ordering best price → size → lower order ID.
- Impact: worse orders can displace better later orders; governance parameters
  are ineffective; clearing/fairness and compute bounds differ from design.
- Missing tests: global four-region overflow, book encounter order inversion,
  price/size/order-ID tie breaks, configured cap 32/64/128, and marginal sizes
  greater than 255.

#### M2 — STP removes ineligible same-user size before price eligibility

- Evidence: `state/dfba.rs:315-325` cancels every same-user maker/taker pair
  before `allocate_side` applies clearing-price eligibility at `328-347`.
- Violation: STP should prevent an actual self-match, not let an out-of-market
  order cancel eligible counterparty flow.
- Impact: users can suppress otherwise valid allocation and distort dust.
- Missing tests: eligible maker plus ineligible same-user taker in both auctions,
  with third-party eligible flow present.

#### M3 — Mark/funding behavior still deviates from D6/D7

- Evidence: an invalid first batch seeds mark from book/oracle at
  `settle_batch.rs:604-620`; funding is the old book-depth premium/SMA model at
  `110-169`, not `f(mark-index)`; it applies only to supplied portfolios at
  `645-653`. Freshness uses `SECS_PER_SLOT=4` at `634-642` although a Solana
  slot is approximately 0.4 seconds and compares slot-derived time with Unix
  timestamps, so ordinary positive timestamps appear perpetually fresh.
- Violation: D6 pure current-batch mark/carry-forward and D7 funding from mark
  versus fresh index, skipped when invalid/stale.
- Impact: invalid auction state can seed a mark, stale index data can continue
  funding, and omitted portfolios miss funding transfers.
- Missing tests: true Unix freshness boundaries, future timestamps, stale
  oracle, first invalid batch with empty/crossed book, exact D7 formula, and
  complete-portfolio funding conservation.

#### M4 — Fill accounting double-counts both receipt legs

- Evidence: `settle_batch.rs:298-329` adds every maker and taker receipt to
  `total_volume`/`total_notional`, then overwrites Batch totals at `568-580`.
  The read-only Batch 19 decode showed `total_volume=40,000` while the header
  had `matched_bid_qty=10,000` and `matched_ask_qty=10,000` (20,000 total
  matched contracts).
- Violation: conservation, one-contract/one-notional accounting, and stable
  Batch/indexer field semantics.
- Impact: Batch volume and notional are doubled relative to ClearBatch and can
  corrupt analytics, fee/audit reconciliation, and fallback mark math.
- Missing tests: Batch totals equal auction matched quantities, maker/taker
  receipt conservation, multi-maker single-taker allocation, and live account
  decode assertions.

#### M5 — Checked-arithmetic policy is not followed in financial state updates

- Evidence: settlement uses saturating position, equity, fee, volume, notional,
  insurance, debt, and counters throughout `settle_batch.rs:322-376` and
  `527-580`; deposit/withdraw saturate vault balance at
  `instructions/deposit.rs:62-71` and `withdraw.rs:61-70`.
- Violation: checked arithmetic and reject-on-overflow requirements.
- Impact: boundary failures silently clamp protocol accounting instead of
  reverting, hiding insolvency or conservation failures.
- Missing tests: every u64/u128/i128 boundary and atomic rejection with no
  partial mutation.

#### M6 — SDK/public layouts are incomplete and retain retired APIs

- Evidence: `packages/sdk/src/programs/core.ts:11-45` omits
  `SetBatchParams=21` and matcher `InitializeBook=7` and has no encoders; it
  still publishes Commit/Reveal encoders at `87-149`. Registry fields at Rust
  offsets 82–83 are described as padding and not decoded
  (`state/registry.ts:4-17,42-54`; `state/types.ts:176-188`). TypeScript
  `RestingOrder` omits Rust `is_maker` (`state/types.ts:159-170` versus
  `state/book.rs:21-34`), and no complete Instrument decoder is exposed.
- Violation: cross-language wire/account layout parity and retirement of
  commit/reveal.
- Impact: governance/clients cannot construct or observe shipped parameters;
  consumers misdecode role; obsolete APIs imply unsupported behavior.
- Missing tests: Rust/TypeScript golden bytes for every public account and
  instruction discriminator, including Registry, Instrument, RestingOrder and
  all matcher instructions.

#### M7 — Historical indexer ingestion is not transaction-faithful

- Evidence: `apps/indexer/src/syncer.ts:69-84` resolves only static keys, so v0
  lookup-table program/account indexes are incomplete. For each historical
  SettleBatch it fetches current Batch/results account bytes at `98-123`, which
  can be overwritten/reused after that transaction. It converts batch, price,
  and quantity BigInts to Number at `143-151` and `179-185`.
- Violation: cursor/backfill correctness, v0 account-meta layout, and lossless
  wire persistence.
- Impact: historical signatures can be attributed current state, ALT
  transactions missed, and 64-bit values rounded.
- Missing tests: loaded-address resolution, multiple historical mutations of
  the same account, closed/reused results, and values above `2^53-1`.

#### M8 — Health can report reconciliation that never happened

- Evidence: `syncer.ts:334-345` calls `recordPollSuccess(head)` before any
  chunk commits; `healthTracker.ts:76-83` moves `lastReconciledSlot` to that
  head. A later chunk failure at `syncer.ts:367-386` leaves the SQLite cursor
  behind while health already reports head reconciliation. `updateBackfill` is
  not called by runtime code, `main.ts:59-66` parses `SKIP_BACKFILL=false` as
  true, `store.ts:255-260` tests reads rather than writes, and batch polling
  derives a PDA although the keeper uses keypair batches (`syncer.ts:281-290`).
- Violation: `/api/healthz` truthfulness, cursor/backfill metadata, and
  `IndexerHealthStatus` boundaries.
- Impact: the UI can label stale/missing data healthy and present empty
  backfill metadata; current batch events can disappear.
- Missing tests: head poll success followed by chunk failure, actual write
  failure/read-only DB, string false env, runtime backfill metadata, and
  keypair-based active batch resolution.

#### M9 — Web batch resolution depends on the indexer and trusts mismatched IDs

- Evidence: `apps/web/lib/onchainAccounts.ts:59-97` falls back to deterministic
  PDAs even though live batches are keypair accounts. The indexer resolver
  ignores `expectedBatchId` and explicitly trusts divergent IDs at `106-125`.
  Related timeline code independently derives PDAs. The deprecated reveal hook
  returns an empty success signature at `useOrderSubmission.ts:263-280`.
- Violation: active-batch configuration contract, truthful degraded operation,
  and retirement of legacy public behavior.
- Impact: trading cannot resolve the live batch when the indexer is down, can
  post against a stale/mismatched batch when it is up, and old callers receive
  false reveal success.
- Missing tests: indexer outage with keypair batch, expected-ID mismatch, stale
  Collecting response, transition races, and rejected legacy reveal calls.

#### M10 — Local signer bridge signs arbitrary transactions

- Evidence: `tools/lib/liveSigning.cjs:61-84` signs or broadcasts any serialized
  legacy/versioned transaction. The bridge regression deliberately signs and
  sends a `SystemProgram.transfer` at
  `tools/cli-live-signer-bridge.test.cjs:9-21,54-71`.
- Violation: M9.9 signer-bridge isolation guarantee.
- Impact: any process or browser context that reaches the loopback endpoint can
  request arbitrary transfers or program calls from the persona wallet.
- Missing tests/policy: allowlisted program IDs/discriminators/accounts,
  expected fee payer, origin/session token, replay/expiry checks, and rejection
  of System Program transfers.

#### M11 — Keeper reports slot advancement as transaction confirmation

- Evidence: `apps/indexer/src/keeper.ts:70-103` returns a signature after three
  slots advance, or immediately when the first slot read fails, without
  inspecting signature status or transaction error.
- Violation: operational confirmation and health-reporting contract.
- Impact: failed close/clear/settle operations can be logged as success and
  advance local keeper state.
- Missing tests: finalized/confirmed success, execution error, blockhash expiry,
  dropped signature, rate-limited status polling, and restart reconciliation.

#### M12 — Live fee configuration conflicts with locked D3

- Evidence: `tools/init-protocol.js:26-31` initializes maker fee to `-2` bps,
  while D3 requires maker `0` and taker `5` bps.
- Violation: D3 and T9.10.1.
- Impact: live economics and insurance/rebate flow differ from the normative
  design and test assumptions.
- Missing tests: deployment/config audit that compares all live/default
  parameters to locked design values.

### Minor

- The web lint command exits zero but reports nine unused-variable warnings in
  tests/components/hooks/config/health-store code. Web unit tests also emit
  React `act(...)` and missing WalletProvider stderr, reducing signal quality.
- All pnpm commands warn that packages request Node 22 while verification ran
  on Node `v24.10.0` with pnpm `8.15.9`; supported-engine CI is not demonstrated.
- `cargo build-sbf` emits one dead-code warning for `allocate_fills` in matcher
  clearing code. It is not a stack-offset overflow.
- Host `T-CU-*` timing tests demonstrate algorithmic timing, not on-chain
  compute units. Planning previously labeled them as CU proof.
- Chart health copy consumes backend status in places where the six-state web
  display status is required, so reconnecting/unreachable can be flattened.

### Hygiene

- Feature lint warns that the dedicated feature worktree is missing. This was
  documented, not repaired.
- Deleted tracked `.worktrees/feature-onchain-perps-dex` and
  `.worktrees/m7-liquidation-safety-stack` entries are stale worktree metadata.
- `mgk-frontend/apps/indexer/data/indexer.db-shm` is tracked generated SQLite
  state. Additional untracked databases/WALs, screenshots, Playwright captures,
  downloaded skill content, demo/pitch files, and generated lockfiles/artifacts
  should be classified deliberately before a commit; they were not deleted.
- No valid parent lifecycle task context was available for task tracing.

## Fresh verification evidence

Commands were run in repository-required order. Exact commands that fail under
the repository's selected Solana Rust toolchain are retained as failures; a
successful `+stable` fallback is additional evidence, not a rewrite of the
failure.

| Command | Exit / result | What it proves and does not prove |
|---|---|---|
| `npx ai-devkit@latest lint` | 0, pass | Lifecycle docs parse/lint; not code alignment |
| `npx ai-devkit@latest lint --feature onchain-perps-dex` | 0, pass with missing-feature-worktree warning | Feature docs are structurally valid; isolation warning remains |
| `cargo clippy --all-targets --all-features -- -D warnings` | 1, fail: `cargo-clippy` unavailable in selected Solana toolchain | Exact CI command is not runnable in this environment |
| `cargo +stable clippy --all-targets --all-features -- -D warnings` | 0, pass | Stable host targets are warning-free; does not replace the exact-toolchain failure |
| `cargo test --all-features` | 101, fail: Solana `rustc 1.79.0-dev` cannot compile resolved dependencies | Exact repository command is not reproducible with current resolution/toolchain |
| `cargo +stable test --all-features` | 0; **397 passed, 5 ignored, 0 failed** | Host/unit/program-test coverage passes. Breakdown: common 45, oracle 5, core unit 225, lifecycle 8 pass/4 ignored, matcher 114 pass/1 ignored |
| `cargo build-sbf` | 0, pass; four programs built; one dead-code warning | SBF compilation succeeds with **no stack-offset overflow**; does not execute ignored lifecycle cases |
| `cargo build --lib --all` | 0, pass | Native libraries build |
| `pnpm --filter @mgk/sdk test` | 0; **158/158** | Existing SDK tests pass; missing public discriminators/layout parity are untested |
| `pnpm --filter @mgk/sdk typecheck` / `build` | 0 / 0 | SDK types and package build under Node 24 |
| `pnpm --filter indexer test` | 0; **87/87** | Existing decoder/store/health/sync tests pass; historical-state/ALT/precision gaps remain |
| `pnpm --filter indexer typecheck` / `build` | 0 / 0 | Indexer typechecks/builds under Node 24 |
| `pnpm --filter web test` | 0; **492/492** with stderr warnings | Web unit assertions pass; runtime warnings remain |
| `pnpm --filter web typecheck` | 0 | Web TypeScript passes |
| `pnpm --filter web build` | first 1 in network sandbox (Google Fonts); escalated rerun 0 with workspace-root warning | Production Next build succeeds with network; hermetic/offline build is not proven |
| `pnpm --filter web lint` | 0 with **9 warnings** | No lint errors; warning-clean claim is false |
| `pnpm --filter web e2e --project=chromium` | first 1 (`EPERM` bind); escalated rerun 0, **39/39** | Full Chromium suite passes when loopback server binding is allowed |
| `pnpm --filter web e2e:wallet` | 0, **1/1** | Focused deterministic mocked-wallet PostOrder flow passes; it is not live signing |
| `node --test tools/lib/liveSigning.test.cjs tools/cli-live-signer-bridge.test.cjs tools/portfolio-layout.test.cjs tools/trade-e2e.test.cjs` | first 1 in sandbox (**12 pass/1 fail**, loopback `EPERM`); escalated rerun 0, **13/13** | Tool helpers pass with loopback access; arbitrary-transfer test exposes M10 |

All pnpm runs emitted an engine warning: packages request Node 22, while the
runner was Node `v24.10.0`/pnpm `8.15.9`.

## Read-only devnet confirmation

No transaction was submitted or resubmitted. `solana confirm -u devnet`
reported the probe, Close, Clear, and Settle signatures as finalized:

- probe `63NfxmCkaN4PLbC3DW8FusszBHZYBbKP324f1DwiyZjnTxbQbJPn6NXNDXEY668LJXmtyVVfee7gWhYtr7YDfWDi`
- Close `5EPWEA3qHQf4eB6v2HQnGJbCBLb85urfqsFpqzyext9XnMVGwEXjFsa3QykqyXzmg8nuqvKPv3LAP2fr6USbsXv4`
- Clear `5t4LPoaHdwu5DsKMRbw9HLZte5Ww5Uph4TAPY7BGwaq66wB1J8Q2hQNCJ3eAhEfBr2SiVN3JjimjrNYUT2iaNUzT`
- Settle `4apD1UuMX5Zfmxu9AnW9LFtBeMdhZ8t3bhWEcq84yvnfKyvvLG5389FgUCR2X8M8wGkUXhWRtLSNt2aqPhEqQRgR`

Verbose Settle status was `Ok`, slot `487207426`, finalized at
`2026-08-24 08:34:20 +07`, consuming 20,803 compute units. Read-only account
queries confirmed the deployed core/matcher/oracle programs as executable and
Batch 19, results, and both persona portfolios as program-owned accounts.

Direct Batch 19 bytes decoded to status Settled, clearing price `42,525,000`,
four posts, five settled fill receipts, bid/ask clears `50,000` and
`85,000,000`, matched bid/ask `10,000` each, `mark_valid=1`, and
`liq_paused=0`. They also decoded `total_volume=40,000`, which is inconsistent
with the 20,000 total matched contracts and independently corroborates M4.

These reads do not prove that the current working-tree source hashes match the
deployed programs, nor do they repair C1–C6. Historical 2026-08-21 RPC 429/stop
checkpoints remain valid history; they were later superseded only for the M9.9
execution proof by the successful August 24 run.

## Required follow-up routing

1. Return to Execute Plan (`dev-implementation`) for C1–C6 and M1–M12. Start
   with authenticated/bound account contracts, post risk validation,
   post-STP header conservation, reusable book storage, and result-driven
   keeper portfolio discovery.
2. Use `dev-design` only where normative intent is genuinely missing. The
   current requirements/design are already clear for global cap/overflow,
   current-batch mark, D7 funding, maker fee 0, checked arithmetic, and signer
   isolation; those must not be silently redefined in code or docs.
3. Add adversarial and invariant tests named in each finding, then run Phase 8
   `dev-testing` with the exact toolchain issue resolved and all ignored
   security-relevant lifecycle cases either executed or explicitly justified.
4. Run Phase 9 `dev-review` only after implementation and testing alignment.
   Mainnet/security review remains mandatory; no deployment is recommended from
   this state.
