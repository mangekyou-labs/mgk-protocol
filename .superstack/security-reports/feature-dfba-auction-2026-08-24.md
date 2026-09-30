---
title: DFBA Mainnet-Readiness Internal CSO Audit
mode: comprehensive
confidence_gate: 2/10
date: 2026-08-24
worktree: /Users/kyler/repos/percolator/.worktrees/feature-dfba-auction
head: be6e590
scope: tracked modifications + untracked files (not merely main...HEAD)
independent_audit: not claimed
deploy_mutation: none
---

# DFBA Mainnet-Readiness — Comprehensive Internal CSO Audit

**Mode:** Comprehensive (2/10 confidence gate).  
**This is local preparation, not the independent Solana audit required before mainnet.**  
No deployment, authority change, key rotation, or external publication was performed.

Scan included the worktree working tree (modified + untracked). Primary checkout `/Users/kyler/repos/percolator` was not modified.

## Stack summary (Phase 0)

| Layer | Detail |
|---|---|
| Language | Rust `no_std` Pinocchio 0.9.2 BPF programs; TypeScript Next.js 16 / Fastify indexer; Node 22 operator tools |
| Package managers | Cargo (lockfile checked in); pnpm workspace (`mgk-frontend`); npm (`tools/`) |
| Database | Indexer SQLite (read-only REST after T9.11.2); on-chain accounts for funds |
| Auth | Wallet signatures (Solana); governance signer; oracle authority; no JWT/session cookies |
| Deployment | Solana devnet (2026-08-24); Render workers (not mutated this slice); Vercel frontend |
| API | Core/Matcher/Oracle single-byte instructions; indexer GET-only REST; wallet-built txs |
| Matching | Pure DFBA (Collecting/Committing → Clearing → Settled); commit-reveal retired |

Canonical 2026-08-24 IDs: Core `C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx`, Matcher `7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC`, Oracle `CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ`, PriceOracle `5NSDGAaRqfxe6mkZG9fEAZdzK4r77nEBEobohZGYP6PN`, Instrument `Hz9UtmSXyKFnp1pGvrhrAmizMsvEkYRh5Eih1r7Lf1hG`.

## Attack surface (Phase 1)

| Entry | Type | Auth | Notes |
|---|---|---|---|
| perps-core entrypoint discs 0–24 | on-chain | signer / governance / permissionless crank | Custody sole in Core |
| perps-matcher Place/Cancel/Modify/CancelAll/DfbaClear/ClearAndMatch/ComputeClearing | on-chain CPI | stack-height CPI gate; InitializeBook ungated | Residual: any program can still CPI matcher |
| oracle UpdatePrice disc 1 (17 B) | on-chain | oracle authority | Wire unchanged this slice |
| Indexer Fastify GET REST | HTTP | none | CORS `{ origin: true }` |
| Next.js `/trade` | browser | wallet | No `use server`, no `middleware.ts`, no `dangerouslySetInnerHTML` |
| `tools/ops-keeper.js` / `ops-oracle.js` | operator CLI | keypair files | Health payloads sanitized |
| Render / Vercel | deploy | platform secrets | Not mutated |

## STRIDE (Phase 10) — condensed

| Component | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| Core custody (vault/portfolio) | Wallet spoof blocked by signer + PDA | Vault/registry canonical PDA after remediation | On-chain txs | Portfolio balances public | CU / RPC 429 | Reinit wipe **fixed** |
| Matcher DFBA | Direct wallet invoke **fixed** (stack height) | Book owned by matcher | Fill logs | Book public | CU cap 64 | **Any program CPI still possible** (blocking design) |
| Liquidation | Fake oracle owner **fixed** | Vault-as-insurance **fixed** | Tx receipts | Health public | Stale mark pauses liq | `mark_valid` gate retained |
| Indexer | N/A (read-only) | Tamper of SQLite is local | Logs | CORS reflection accepted | RPC lag | No fund movement |
| Oracle worker | Keypair file | Venue spoof → quorum | Health file | Sanitize strips secrets | Venue outage → stopLoop | Authority still single-key |

## Data classification (Phase 11)

| Class | Where | Transmission | Retention |
|---|---|---|---|
| Financial (positions, fills, vault) | On-chain + SQLite replica | RPC + REST | Chain infinite; SQLite disk |
| Auth credentials (keypairs, RENDER_API_KEY) | Gitignored `.env`; `~/.config/solana/`; Render secret files | Never in REST health | Operator-controlled |
| PII | Not collected | — | — |
| Program IDs / PDAs | Public by design | Explorer | Public |

## Dependency / CI evidence (Phases 3–4)

- `pnpm audit` (frontend workspace): metadata reported critical 3 / high 43 / moderate 31 / low 1 over 1425 deps. Next.js GHSAs reviewed; no Server Actions / `use server` path. **Accepted** as transitive unless a reachable RCE is shown.
- `cargo-audit` 0.22.2 at `/private/tmp/cargo-audit-cso` (`cargo +stable` install): 16 host/test-toolchain advisories (bytes 1.10.1 RUSTSEC-2026-0007, crossbeam-epoch, curve25519-dalek 3.2.0, ed25519-dalek 1.0.1, quinn-proto, rustls-webpki, tar, time) plus yanked keccak 0.1.5. **Not in pinocchio `no_std` SBF graph.** Do not bump `solana-sdk` 2.1. Yanked-check network timeouts → unresolved evidence, not a code defect.
- GHA `actions/checkout@v4` unpinned SHA in `verify.yml` and `mgk-frontend-ci.yml`. Kani job still invokes removed `model_safety`.
- Read-only devnet: Core/Matcher/Oracle BPFLoaderUpgradeable; Core upgrade slot 487386516. Upgrade authority on Core programdata `D1qAzxQvYWnpy2oDznxny5n5w1oTNkYFEZaMzTcBLYwk` is single wallet `ECmGsGAAPJimTwLk3SzkQ39pUQbaBj7U5qgSRRgYSFy` (mainnet blocker; **no rotation this slice**).

## Secrets (Phase 2)

- `.env` present, gitignored (`.gitignore:69:.env`), not in git history as a tracked add. **Do not print values.**
- Fingerprints only: file sha256 prefix `25e1c09eaaa1ef7b`; `RENDER_API_KEY` value sha256 prefix `763450c1aee3`; prefix class `rnd_`; length 32. **LOW** (gitignored operator secret). No rotation authorized.

## Formal verification

Fender, QEDGen, and Kani/`model_safety` are unavailable or broken in CI. Invariant-class remediations used unit tests + proptest-class host tests. **This report does not claim formal verification.**

---

## Findings

### [CRITICAL] CSO-2026-08-24-C01: InitPortfolioForUser could overwrite an initialized portfolio

**Confidence:** 9/10  
**Phase:** 9 A01 / STRIDE E  
**Location:** `programs/perps-core/src/instructions/init_portfolio_for_user.rs`  
**Status:** **Resolved** (compatible)

**Description:** 3-account keeper path could rewrite `portfolio.user` for an already-initialized account. Missing fail-closed PDA match allowed a non-canonical account of the same size.

**Exploit Scenario:** Keeper (or any 3-account caller) re-inits a victim portfolio PDA with another user, wiping balances/positions.

**Evidence:** Pre-fix path wrote `user` without `AlreadyInitialized` when existing user ≠ zero. Host `find_program_address` panics (Pinocchio stub); production checks now use `try_find_program_address` fail-closed.

**Remediation:** `may_overwrite_portfolio_user` only if existing user is `[0;32]`; `payer_may_init_portfolio` for 2-account requires payer==user; `portfolio_pda_matches` fail-closed. Same user → Ok; other user → `AlreadyInitialized=115`.

**Regression tests:** `already_initialized_portfolio_must_not_be_overwritten`, `two_account_path_rejects_mismatched_user`, `portfolio_account_must_match_derived_pda`.

**Priority:** P0 — fixed.

### [CRITICAL] CSO-2026-08-24-C02: Deposit/withdraw/liquidate accepted any Core-owned account as vault

**Confidence:** 9/10  
**Phase:** 9 A01 / STRIDE T  
**Location:** `programs/perps-core/src/entrypoint.rs`, `pda.rs`, `liquidate_user.rs`, deposit/withdraw paths  
**Status:** **Resolved** (compatible)

**Description:** Vault identity was “owned by Core”, not canonical `["vault"]` PDA. An attacker-controlled Core-owned account could be substituted as insurance/vault.

**Exploit Scenario:** Direct SOL out of a decoy “vault” or insurance credit against the wrong account.

**Remediation:** `require_canonical_vault` / `require_canonical_registry` on deposit, withdraw, liquidate, settle, init_vault. Host impostor tests fail closed when `try_find_program_address` returns `None`.

**Regression tests:** `pda.rs` impostor tests; `liquidate_rejects_non_vault_as_insurance_account`.

**Priority:** P0 — fixed.

### [HIGH] CSO-2026-08-24-H01: Deposit System Program ID not authenticated

**Confidence:** 9/10  
**Phase:** 9 A01 / CPI  
**Location:** `programs/perps-core/src/instructions/deposit.rs`, entrypoint Deposit  
**Status:** **Resolved** (compatible)

**Exploit Scenario:** Fake System Program CPI steals lamports on deposit.

**Remediation:** `validate_system_program_id` requires `[0u8;32]`.

**Regression tests:** `rejects_spoofed_system_program_id`, `deposit_rejects_spoofed_system_program`.

**Priority:** P0 — fixed.

### [HIGH] CSO-2026-08-24-H02: Matcher program ID not authenticated on Core CPI

**Confidence:** 9/10  
**Phase:** 9 A01 / CPI  
**Location:** PostOrder / ClearBatch / SettleBatch / Cancel / Modify / CancelAll  
**Status:** **Resolved** (compatible)

**Exploit Scenario:** Core CPI into a spoofed matcher that returns attacker fills/marks.

**Remediation:** `validate_matcher_program_id` at all Core CPI / book-PDA sites.

**Regression tests:** `rejects_spoofed_matcher_program_id`, `post_order_rejects_spoofed_matcher_program`.

**Priority:** P0 — fixed.

### [HIGH] CSO-2026-08-24-H03: CreatePortfolio / InitPortfolio reinit + missing PDA

**Confidence:** 8/10  
**Phase:** 9 A01  
**Location:** `create_portfolio.rs`, `init_portfolio.rs`  
**Status:** **Resolved** (compatible)

**Remediation:** Same skip-same-user / `AlreadyInitialized` / PDA match as C01.

**Regression tests:** `create_portfolio_must_not_overwrite_initialized_user`.

**Priority:** P0 — fixed.

### [HIGH] CSO-2026-08-24-H04: Matcher mutations callable as top-level instructions

**Confidence:** 9/10 (direct invoke) / 8/10 (any-program CPI residual)  
**Phase:** 9 A01 / STRIDE E  
**Location:** `programs/perps-matcher/src/instructions.rs` `require_cpi`  
**Status:** **Partially resolved** — wallet-direct blocked; **Core-caller auth is a blocking design/migration task**

**Description:** PlaceResting, CancelResting, ModifyResting, CancelAll, DfbaClear, ClearAndMatch, ComputeClearing were permissionless. Full Core-only caller checks need the Instructions sysvar or an extra signer — a wire/account-layout break **not taken** this slice (compatibility rule).

**Exploit Scenario (residual):** A malicious program CPIs matcher and mutates the book / clearing without going through Core custody/pause gates.

**Remediation (compatible):** `sol_get_stack_height() > 1` on Solana; native no-op. InitializeBook remains ungated (setup).

**Regression tests:** `direct_matcher_invocation_is_rejected`, `native_require_cpi_is_a_no_op`.

**Priority:** P0 residual → **accepted as blocking design** (not silently broken). Mainnet must add Core-caller authentication.

### [HIGH] CSO-2026-08-24-H05: LiquidateUser missing instrument/oracle owner and vault PDA

**Confidence:** 8/10  
**Phase:** 9 A01  
**Location:** `liquidate_user.rs`  
**Status:** **Resolved** (compatible)

**Remediation:** instrument owner check; `oracle_owner_is_canonical`; vault PDA. Fake oracle ignored for price.

**Regression tests:** `spoofed_oracle_owner_is_not_canonical`, `liquidate_rejects_non_vault_as_insurance_account`.

**Priority:** P0 — fixed.

### [MEDIUM] CSO-2026-08-24-M01: ops-oracle `main()` ran on `require()`; health/sanitize helpers missing

**Confidence:** 8/10  
**Phase:** 9 A10 / operator safety  
**Location:** `tools/ops-oracle.js`  
**Status:** **Resolved** (compatible; UpdatePrice disc 1 wire unchanged)

**Exploit Scenario:** `npm test` / accidental import started a live oracle cycle (`PublicKey(undefined)` or posting with fallback/ephemeral keypair). Health fail-closed tests existed but were unimplemented.

**Remediation:** `if (require.main === module)` guard; export `PRICE_ORACLE_SIZE=128`, `PRICE_ORACLE_MAGIC=0x4c43524f4c435250n`, `decodePriceOracleAccount`, `evaluateOracleHealth` (warn @ 3 failures / 60s; critical+stopLoop @ 10 / 600s), `sanitizeHealthPayload` (SECRET_KEYS + rpcUrl/apiKey/keypair/secret).

**Regression tests:** `tools/ops-oracle.test.js` (layout, health, sanitize). `cd tools && npm test` → 69 pass (close-out).

**Priority:** P1 — fixed.

### [MEDIUM] CSO-2026-08-24-M02: Indexer CORS `origin: true`

**Confidence:** 7/10  
**Phase:** 9 A02  
**Location:** `mgk-frontend/apps/indexer/src/main.ts:28`  
**Status:** **Accepted** — GET-only public market data; no cookies/credentials. Follow-up: allowlist if indexer ever takes authenticated writes.

**Priority:** P2.

### [MEDIUM] CSO-2026-08-24-M03: GitHub Actions unpinned `@v4` + dead Kani job

**Confidence:** 7/10  
**Phase:** 4 / 9 A03 A08  
**Location:** `.github/workflows/verify.yml`, `mgk-frontend-ci.yml`  
**Status:** **Accepted this slice** (CI hardening, not fund-flow). Pin SHAs + retire `model_safety` job before mainnet.

**Priority:** P2.

### [MEDIUM] CSO-2026-08-24-M04: Single-wallet upgrade authority

**Confidence:** 10/10 (read-only chain evidence)  
**Phase:** 5 / STRIDE E  
**Location:** Core programdata `D1qAzxQv…` upgrade authority `ECmGsGAAPJimTwLk3SzkQ39pUQbaBj7U5qgSRRgYSFy`  
**Status:** **Accepted mainnet blocker.** No rotation authorized this slice.

**Priority:** P0 for mainnet, out of slice.

### [LOW] CSO-2026-08-24-L01: Gitignored RENDER_API_KEY

**Confidence:** 8/10  
**Phase:** 2  
**Status:** **Accepted.** Location `.env` (gitignored). Fingerprints only (see Secrets). Prefer Render secret files / vault. No rotation this slice.

**Priority:** P3.

### [LOW] CSO-2026-08-24-L02: Four CU-ignored program-test cases

**Confidence:** 6/10 as security (likely harness)  
**Phase:** 9 A10  
**Status:** **Accepted as test debt** unless later proven a production CU defect. Mainnet still requires CU-cap evidence.

**Priority:** P2 engineering.

### [INFO] CSO-2026-08-24-I01: Host cargo-audit / pnpm audit transitive vulns

Not in SBF pinocchio graph / not in Server Actions path. Do not bump solana-sdk 2.1. Yanked-check timeout = unresolved scan evidence.

### [INFO] CSO-2026-08-24-I02: Pinocchio host PDA stub always `None`

Production fail-closed (`None => not canonical`). Tests must not unwrap `find_program_address` on host.

---

### [HIGH] CSO-2026-08-24-F-KEEPER-LAYOUT: ops-keeper Registry/Batch decode offsets were wrong

**Confidence:** 9/10  
**Phase:** 9 A06 / operator lifecycle  
**Location:** `tools/ops-keeper.js`  
**Status:** **Resolved** (compatible)

**Description:** Host decoder treated `batchIdCounter` as a number at the wrong offset and misread `nMin` / `totalCommitments` / `markValid`. A live keeper could skip settlement, crank the wrong batch, or treat an uncleared book as settled.

**Exploit Scenario:** Operator process reads `mark_valid=0` as valid (or the reverse) and settles against the wrong portfolio set.

**Remediation:** SDK-aligned `decodeBatch` / `decodeRegistry` (`batchIdCounter` bigint @36, `nMin` u32 @52, `totalCommitments` u32 @56, `markValid` @152). `capSettlementPortfolios` fail-closed. `liquidationPassDue` + `runLiquidationPass` with LiquidateUser disc 9. Instrument/oracle resolved before settled. `buildSettleBatchIx` 6-byte with bump at `[5]`. `MAX_SETTLE_PORTFOLIOS=20`. `require.main === module`.

**Regression tests:** `tools/ops-keeper.test.js` decode/cap/liquidation/settle-ix cases. `cd tools && npm test` → 69 pass.

**Priority:** P0 — fixed.

### [HIGH] CSO-2026-08-24-F-SQLI-CANDLES: candle resolution interpolated into SQL

**Confidence:** 8/10  
**Phase:** 9 A05  
**Location:** `mgk-frontend/apps/indexer/src/rest/routes.ts`  
**Status:** **Resolved** (compatible; GET route unchanged)

**Description:** Untrusted `resolution` query could leave the allowlist and be interpolated into SQLite.

**Exploit Scenario:** Attacker hits `/api/candles?resolution=...` and reads or mutates local SQLite.

**Remediation:** `CANDLE_RESOLUTIONS = {1m,5m,1h}`; anything else → 400.

**Regression tests:** indexer integration — unallowlisted resolution returns 400.

**Priority:** P0 — fixed.

### [HIGH] CSO-2026-08-24-F-ORACLE-QUORUM: oracle quorum fail-open + ephemeral authority

**Confidence:** 8/10  
**Phase:** 9 A10 / STRIDE T  
**Location:** `tools/ops-oracle.js`  
**Status:** **Resolved** (UpdatePrice disc 1 / 17-byte wire unchanged)

**Description:** Quorum could accept a single venue or a non-positive price; missing keypair could mint an ephemeral authority; venue fetches had no timeout; `require()` started `main()`.

**Exploit Scenario:** One spoofed venue, or a generated key that is not the on-chain oracle authority, posts a mark.

**Remediation:** `loadOracleKeypair` throws (no ephemeral); `selectQuorumPrice` `minVenues=2` + positivity; `fetchWithTimeout` 3s on `VENUE_FETCHERS`; cycle fail-closed via `evaluateOracleHealth.stopLoop`; `require.main === module`.

**Regression tests:** `ops-oracle.test.js` (quorum, positivity, ephemeral refusal, health stopLoop).

**Priority:** P0 — fixed.

### [HIGH] CSO-2026-08-24-F-LIQ-DEAD: keeper liquidation pass was dead / mis-encoded

**Confidence:** 8/10  
**Phase:** 9 A01 / lifecycle  
**Location:** `tools/ops-keeper.js`  
**Status:** **Resolved** (disc 9 LiquidateUser wire unchanged)

**Description:** Liquidation discovery/pass did not encode LiquidateUser (disc 9) against resolved instrument/oracle, so underwater accounts could persist across batches.

**Remediation:** `runLiquidationPass` builds disc 9; instrument + oracle accounts resolved before settle.

**Regression tests:** `tools/ops-keeper.test.js` liquidation-pass encoding.

**Priority:** P0 — fixed.

### [MEDIUM] CSO-2026-08-24-F-GPA-DOS: indexer REST `getProgramAccounts` on the request path

**Confidence:** 8/10  
**Phase:** 1 / 9 A06  
**Location:** `mgk-frontend/apps/indexer/src/rest/routes.ts` (was `findLiveBatchAccount`)  
**Status:** **Resolved** on REST; **accepted remnant** in leftover `indexer/src/keeper.ts` and operator `tools/ops-keeper.js`

**Description:** Unauthenticated `GET /api/batch/current` scanned program accounts, amplifying RPC cost and returning a live batch that was not the configured candidate.

**Exploit Scenario:** Repeat unauth GETs force GPA load; a stale keypair plus scan could advertise the wrong batch address.

**Remediation:** Removed `findLiveBatchAccount`. `/api/batch/current` uses registry + configured/derived candidates only. Stale keypair is ignored without a scan.

**Regression tests:** `integration.test.ts` — `gpaCalls===0` on request path and on stale keypair.

**Priority:** P1 — REST fixed. Operator GPA remains for liquidation discovery (not request-path).

### [MEDIUM] CSO-2026-08-24-F-INDEXER-TRUST: web trusted indexer batch address without batch-id match

**Confidence:** 8/10  
**Phase:** 9 A01 / STRIDE T  
**Location:** `mgk-frontend/apps/web/lib/onchainAccounts.ts`, `lib/trade/indexerBatch.ts`  
**Status:** **Resolved** (REST JSON shape unchanged)

**Description:** `fetchIndexerBatchAddress` accepted any address the indexer returned, even when `batchId` did not match the expected on-chain counter.

**Exploit Scenario:** A compromised or stale indexer points the wallet at another batch PDA; the UI posts into the wrong window.

**Remediation:** `indexerReportedBatchId` + `indexerBatchMatchesExpected`; address used only when IDs match.

**Regression tests:** `indexerBatch.ts` + `onchainAccounts.test.ts` mismatch/match/address-only.

**Priority:** P1 — fixed.

### [MEDIUM] CSO-2026-08-24-F-SKIP-PREFLIGHT: wallet init/deposit/withdraw skipped RPC preflight

**Confidence:** 8/10  
**Phase:** 9 A10 / wallet funds  
**Location:** `mgk-frontend/apps/web/lib/hooks/useAccountActions.ts`  
**Status:** **Resolved** (instruction layout unchanged)

**Description:** `skipPreflight: true` sent failing custody txs to the cluster, wasting fees and hiding simulation errors.

**Remediation:** `WALLET_TX_SEND_OPTS = { skipPreflight: false }` for init/deposit/withdraw.

**Regression tests:** `walletTxOpts.test.ts`; `useAccountActions.test.ts` source must not contain `skipPreflight: true`. Re-audit grep: zero matches in `*.{ts,tsx,js}`.

**Priority:** P1 — fixed.

### [MEDIUM] CSO-2026-08-24-F-SDK-SETTLE: SettleBatch encoding omitted next-batch bump

**Confidence:** 7/10  
**Phase:** 9 A08  
**Location:** `mgk-frontend/packages/sdk/src/programs/core.ts`  
**Status:** **Resolved** in SDK (compatible). **Accepted remnant:** leftover `indexer/src/keeper.ts` still encodes 5 bytes (on-chain defaults bump 0).

**Description:** On-chain `process_settle_batch_inner` reads `next_batch_bump` at payload `[4]` after stripping disc (`data[4]` of the 6-byte ix). SDK previously omitted the bump.

**Remediation:** `encodeSettleBatch` is 6 bytes, bump at `[5]`, default 0.

**Regression tests:** SDK `core.test.ts` 6-byte layout.

**Priority:** P1 — SDK fixed; remnant 5-byte encoder is on-chain compatible.

### [MEDIUM] CSO-2026-08-24-F-BOOK-CACHE: book cache not keyed by instrument

**Confidence:** 7/10  
**Phase:** 9 A06  
**Location:** `mgk-frontend/apps/indexer/src/rest/routes.ts`  
**Status:** **Resolved**

**Remediation:** cache is `Map<number, …>` keyed by `instrumentId`.

**Regression tests:** indexer REST/book tests in the workspace suite.

**Priority:** P2 — fixed.

### [LOW] CSO-2026-08-24-F-HELIUS-PUBLIC: billed RPC credential in `NEXT_PUBLIC_RPC_URL`

**Confidence:** 9/10  
**Phase:** 2 / 9 A02  
**Location:** gitignored `mgk-frontend/apps/web/.env.local` consumed by `lib/config.ts`  
**Status:** **Accepted this slice (warn-only).** Rotation unauthorized.

**Description:** Client bundle embeds a provider URL that contains `api-key=`. The value is not printed; `rpcUrlContainsCredential` warns at boot/build.

**Remediation this slice:** warn only. Follow-up: server-side RPC proxy + rotate the billed key (ops, out of slice).

**Regression tests:** `rpcUrl.ts` / `config.test.ts` — api-key URL does not throw.

**Priority:** P2 ops (not this slice).

### [INFO] CSO-2026-08-24-F-E2E-LAYOUT: Playwright T9.10.7 fixture used host-packed Portfolio/Book

**Status:** Test debt, **not a product finding.** Mock `encodePortfolioWithPosition` now matches BPF `repr(C)` (positions_len @144, Position[] @152, qty +8, entry +16). Mock book writes bestBid/bestAsk. Prepare-close assertions aligned to `encodePostOrder` (side@[1], is_maker@[2], price i64@3). Deterministic trade+wallet: **39 passed**.

### [CRITICAL] CSO-2026-08-24-C03: Initialize overwrote live registry governance

**Confidence:** 9/10  
**Phase:** 9 A01 / STRIDE E  
**Location:** `programs/perps-core/src/instructions/initialize.rs`  
**Status:** **Resolved** (compatible)

**Description:** After create-if-needed, Initialize always wrote `governance @ 0` and reset batch params/instrument from the caller payload. `process_initialize_inner` required only that the caller signed; it did not check `registry.governance`.

**Exploit Scenario:** Any signer submits Initialize against the live 86-byte registry PDA and becomes governance, then SetPauseFlags / SetBatchParams / SetFundingParams.

**Evidence:** Pre-fix path wrote 32-byte governance unconditionally. TDD red: `initialized_governance_must_not_be_overwritten` / `initialized_bump_must_not_be_overwritten` failed while `registry_already_initialized` returned false.

**Remediation:** `registry_already_initialized(governance, bump)` is true when governance ≠ `[0;32]` or bump ≠ 0. After PDA create-if-needed, live registry returns `AlreadyInitialized=115` before any field write. First-init zeros still write.

**Regression tests:** `uninitialized_registry_may_be_written`, `initialized_governance_must_not_be_overwritten`, `initialized_bump_must_not_be_overwritten`.

**Priority:** P0 — fixed.

### [CRITICAL] CSO-2026-08-24-C04: InitVault zeroed a live vault

**Confidence:** 9/10  
**Phase:** 9 A01 / STRIDE T  
**Location:** `programs/perps-core/src/instructions/init_vault.rs`  
**Status:** **Resolved** (compatible)

**Description:** `process_init_vault` always called `Vault::initialize_in_place`, which zeros `balance` and `insurance_fund`. Entrypoint canonical-PDA check stopped overlay, not wipe of the real vault.

**Exploit Scenario:** Permissionless InitVault on the canonical vault PDA sets deposits and insurance to 0.

**Evidence:** TDD red: `vault_with_balance_must_not_be_zeroed` failed while the helper returned false.

**Remediation:** `vault_already_initialized(balance, insurance, bump)` if any is non-zero → `AlreadyInitialized=115`. Uninitialized (all zero) still inits. Disc 15 and vault layout unchanged.

**Regression tests:** `uninitialized_vault_may_be_zeroed`, `vault_with_balance_must_not_be_zeroed`, `vault_with_insurance_must_not_be_zeroed`, `vault_with_bump_must_not_be_reinitialized`.

**Priority:** P0 — fixed.

### [CRITICAL] CSO-2026-08-24-C05: SettleBatch applied DFBA fills from results length alone

**Confidence:** 8/10  
**Phase:** 9 A01 / STRIDE T  
**Location:** `programs/perps-core/src/instructions/settle_batch.rs`  
**Status:** **Resolved** (compatible) with documented residual

**Description:** `dfba_mode` was true when `results_data.len() >= DFBA_HDR + DFBA_FILL` even if `matched_bid_qty`, `matched_ask_qty`, and `mark_valid` were all 0. Results were not authenticity-bound to ClearBatch. Anyone can `CreateAccount` with owner = matcher.

**Exploit Scenario:** On a Clearing batch that never ran ClearBatch, a crank passes a matcher-owned buffer with a DFBA header + fills and SettleBatch mutates portfolios.

**Evidence:** TDD red: `empty_book_results_length_must_not_apply_fills` failed while the helper kept the length-only OR.

**Remediation:** Format vs apply split: parse DFBA when `len >= 34`; `should_apply_dfba_fills` is true only if header fits **and** (`matched_bid_qty > 0` || `matched_ask_qty > 0` || `mark_valid != 0`). Empty-book settle still transitions. Fill records remain maker+taker (~2× matched). Results pubkey is **not** stored on Batch (`_dfba_pad` is 6 bytes — layout break if required).

**Residual (accepted / blocking if authenticity-by-PDA is required):** After a real ClearBatch, a substituted matcher-owned results account at the same clearing prices can still apply. Binding results to Batch needs an extra pubkey field (stopped, not a silent layout change).

**Regression tests:** `empty_book_results_length_must_not_apply_fills`, `matched_bid_qty_enables_dfba_fill_apply`, `matched_ask_qty_enables_dfba_fill_apply`, `mark_valid_enables_dfba_fill_apply`, `undersized_results_never_apply_dfba_fills`.

**Priority:** P0 — length-OR fixed; residual documented.

### [CRITICAL] CSO-2026-08-24-C06: Oracle Initialize overwrote authority

**Confidence:** 9/10  
**Phase:** 9 A01 / STRIDE S  
**Location:** `programs/oracle/src/instructions.rs`  
**Status:** **Resolved** (compatible)

**Description:** Oracle Initialize had no `validate()` / already-init check. Any signer + writable oracle account set `authority = signer` via `PriceOracle::new`.

**Exploit Scenario:** Re-init the live PriceOracle, steal UpdatePrice authority, push a fake mark.

**Evidence:** TDD red: `magic_oracle_must_not_be_reinitialized` failed while `oracle_already_initialized` returned false.

**Remediation:** `oracle_already_initialized` is `oracle.validate()` (magic + version). Live feed → `ProgramError::InvalidAccountData`. Zeroed account still inits. Disc 0 / 9-byte payload / 128-byte layout unchanged.

**Regression tests:** `zeroed_oracle_may_be_initialized`, `magic_oracle_must_not_be_reinitialized`.

**Priority:** P0 — fixed.

---

## Re-audit (close-out, 2026-08-24)

Rescanned changed security paths on the worktree (tracked + untracked). Primary checkout was not modified.

| Check | Result |
|---|---|
| `skipPreflight:\s*true` in `*.{ts,tsx,js}` | 0 matches |
| REST `getProgramAccounts` / `findLiveBatchAccount` in `routes.ts` | gone |
| Remaining `getProgramAccounts` | leftover `indexer/src/keeper.ts`, operator `tools/ops-keeper.js`, e2e mock — accepted |
| SDK `encodeSettleBatch` | 6 bytes, bump at `[5]` |
| `CANDLE_RESOLUTIONS` allowlist | 400 on anything else |
| Matcher `require_cpi` | stack-height only (H04 persistent design blocker) |
| Canonical IDs / discriminators / PDA seeds | unchanged |
| `compute_clearing` / allocation / settlement math | not rewritten |
| Upgrade authority | still single wallet `ECmGsGAAPJimTwLk3SzkQ39pUQbaBj7U5qgSRRgYSFy` (no rotation) |
| `pnpm audit --prod` | 66 transitive (2C/34H/29M/1L) — accepted I01 |
| cargo-audit host graph | 16 host/test-toolchain advisories, not in pinocchio SBF graph — accepted I01 |
| Formal verification | still unavailable; not claimed |

**pnpm -r build (Node 22.19.0, this close-out):** sdk tsc, indexer tsc, Next.js 16.2.9 compiled. Build prints the billed-RPC warning without printing the key.

## Re-audit (C03–C06 skip-reinit / fill-gate, 2026-08-24)

Rescanned the four on-chain paths in the worktree after TDD remediations. Primary checkout was not modified. Frontend/operator trees were not changed this wave.

| Check | Result |
|---|---|
| `registry_already_initialized` before registry/instrument writes | present; `AlreadyInitialized=115` |
| `vault_already_initialized` before `initialize_in_place` | present; bump/balance/insurance |
| `should_apply_dfba_fills` length-only OR | **gone**; apply gated on `matched_*` / `mark_valid` |
| DFBA vs CLOB parse | still length ≥ 34 for format; apply is separate |
| `oracle_already_initialized` / `validate()` | present; disc 0 unchanged |
| Results pubkey on Batch | **not added** (layout break); residual after real Clear accepted |
| `compute_clearing` / allocation math | not rewritten |
| Discriminators / PDA seeds / program IDs | unchanged |
| Matcher `require_cpi` | still stack-height only (H04) |
| Upgrade authority | still single wallet `ECmGsGAAPJimTwLk3SzkQ39pUQbaBj7U5qgSRRgYSFy` (no rotation) |
| Frontend / Playwright | unchanged this wave (prior 39/39) |
| Formal verification | still unavailable; not claimed |

## Compatibility

No discriminator, account layout, PDA seed, program ID, SDK encoding, REST route, or DFBA `compute_clearing`/allocation/settlement semantic change. Matcher Core-caller auth **stopped** as a blocking design task rather than adding Instructions sysvar. SDK SettleBatch grew an optional trailing bump byte (default 0); on-chain already treated missing bump as 0.

## Disposition vs independent audit

| Bar | This slice |
|---|---|
| Internal CSO + TDD remediations | Done |
| Independent Solana audit | **Still required** |
| Multisig upgrade authority | **Still required** |
| Canonical mainnet IDs | **Still required** |
| Latency / CU-cap production evidence | **Still required** |
| Incident / bug-bounty / HA | **Still required** |
| Formal verification | **Unavailable; not claimed** |
| T9.11.12–13 deploy/smoke | **Out of scope** (no mutation) |

## Confidence calibration

- Total findings recorded: 31 (on-chain 18 + frontend/operator 13) including residuals/accepted
  - CRITICAL: 6 (C01–C06, avg ~9/10) — all resolved at the compatible bar; C05 residual (post-Clear results substitution) accepted pending layout-breaking results binding
  - HIGH: 9 (CSO H01–H05 + F-KEEPER-LAYOUT, F-SQLI-CANDLES, F-ORACLE-QUORUM, F-LIQ-DEAD) — 8 resolved; H04 partial/accepted design
  - MEDIUM: 9 (M01–M04 + F-GPA-DOS, F-INDEXER-TRUST, F-SKIP-PREFLIGHT, F-SDK-SETTLE, F-BOOK-CACHE) — safety-relevant items resolved; M02–M04 accepted; F-SDK-SETTLE remnant 5-byte keeper.ts accepted (compatible)
  - LOW: 4 (L01, L02, F-HELIUS-PUBLIC, F-CSP-CONNECT) — accepted
  - INFO: 3 (I01, I02, F-E2E-LAYOUT)
- Unresolved Critical/High fund-flow: **0** (H04 residual = documented design blocker; C05 post-Clear substitution = layout-break follow-on)
- Unresolved safety-relevant Medium: **0**
- False positives filtered: source maps, TODOs, test keypairs, public PDAs, IDL absence (Pinocchio), Playwright fixture packing (test debt); secrets/CI subagent “no security-reports” and unused-helper Criticals vs current tree
- Mode: Comprehensive 2/10 gate
- History: this file is the first report; close-out re-audit appended 2026-08-24; C03–C06 re-audit appended same date; secrets/CI calibration appended 2026-08-25

## Remediation roadmap (remaining)

| Priority | Item | Effort |
|---|---|---|
| P0 mainnet | Independent audit + Squads upgrade authority + Core-caller matcher auth (sysvar) | design/migration |
| P0 design | Bind SettleBatch results to ClearBatch (extra Batch field / PDA) — stopped to preserve layout | migration |
| P1 | Pin GHA SHAs; remove dead Kani job | hours |
| P2 | CU un-ignore / CU-cap evidence; indexer CORS allowlist if writes added; RPC proxy + rotate billed Helius key; tighten CSP `connect-src` after proxy | days |
| P3 | Operator secret vault; host cargo-audit toolchain hygiene; delete leftover `indexer/src/keeper.ts` GPA/5-byte encoder | days |

---

## Phases 6–8 (coverage, 2026-08-25)

| Phase | Result |
|---|---|
| 6 Webhooks / outbound | No inbound webhook handlers, no `pull_request_target`. Operator outbound HTTP is venue fetch (`ops-oracle.js` 3s timeout) and Solana RPC. TLS not disabled. |
| 7 LLM / AI | No OpenAI/Anthropic/chat-completions path in product runtime. CSO skill telemetry is anonymous + already prompted. |
| 8 Skills | Installed CSO/dev-lifecycle skills are documentation + shell telemetry. No product `curl \| bash` installer. Skill `curl\|bash` patterns are not a runtime fund-flow defect. |

### [LOW] CSO-2026-08-24-F-CSP-CONNECT: `connect-src` includes scheme wildcards

**Confidence:** 7/10  
**Phase:** 9 A02  
**Location:** `mgk-frontend/apps/web/next.config.ts` `buildCsp`  
**Status:** **Accepted this slice (P2).** Not a funds/auth Medium.

**Description:** Host allowlists for Solana/Helius/Pyth/TradingView/indexer are present, then `https:`, `wss:`, and `ws:` are appended so wallet adapters can reach a user-configured RPC. That wildcard largely defeats the host list for `connect-src` (and `img-src` also allows `https:`).

**Exploit Scenario:** XSS in the Next app (today: `'unsafe-inline'` scripts) could POST wallet-adjacent data to any HTTPS origin. No XSS is confirmed.

**Remediation (follow-on):** Drop `https:` from `connect-src` after a server-side RPC proxy (same ops follow-on as F-HELIUS-PUBLIC). Do not break arbitrary `NEXT_PUBLIC_RPC_URL` in this slice.

**Priority:** P2.

---

## Secrets / CI parallel scan vs live tree (2026-08-25)

A read-only secrets/CI subagent produced 16 findings. It is **not** treated as ground truth. Calibration against this worktree:

| Subagent ID | Claim | Live tree | Disposition |
|---|---|---|---|
| CSO-01 | Render API key in gitignored `.env` (0644) | Matches L01. Fingerprints only. | **Accepted.** No rotation / chmod that would print values. |
| CSO-02 | Helius in `NEXT_PUBLIC_RPC_URL` | Matches F-HELIUS-PUBLIC; `config.ts` warns, does not throw. | **Accepted.** Rotation unauthorized. |
| CSO-03 | Single upgrade EOA | Matches M04. Core programdata `D1qAzxQvYWnpy2oDznxny5n5w1oTNkYFEZaMzTcBLYwk` authority `ECmGsGAAPJimTwLk3SzkQ39pUQbaBj7U5qgSRRgYSFy`. | **Accepted mainnet blocker.** No authority transfer. |
| CSO-04 | Indexer SQL candle interpolation | **Stale.** `CANDLE_RESOLUTIONS` allowlist in `routes.ts`; unlisted → 400. | **Already resolved** (F-SQLI-CANDLES). |
| CSO-05 | CORS `{ origin: true }` | Matches M02. GET-only. | **Accepted.** |
| CSO-06 | Unpinned GHA / dead Kani / `main` vs `master` | `verify.yml` already `on: [master]`. `actions/checkout@v4` still unpinned. Kani job still invokes removed `model_safety`. | **Accepted** as M03 (CI, not fund-flow). |
| CSO-07 | Local `target/deploy` keypairs | Gitignored; not live program IDs. | **P2 accepted.** |
| CSO-08 | gitignore vs tracked Cargo.lock / indexer DBs | Hygiene. Cargo.lock is intentional. | **P3 accepted.** |
| CSO-09 | pnpm audit counts | Matches I01 transitive. | **Accepted.** |
| CSO-10 | cargo-audit unresolved / yanked-check timeout | Matches I01 unresolved scan evidence. | **Accepted.** Do not claim Rust clean. |
| CSO-11 | CSP `connect-src https:` | **Confirmed:** allowlist plus `"https:"` / `"wss:"` / `"ws:"`. | Recorded as F-CSP-CONNECT **accepted P2**. |
| CSO-12 | ops-oracle missing timeouts | **Stale.** `fetchWithTimeout` 3s + `stopLoop`. | **Already resolved** (F-ORACLE-QUORUM). |
| CSO-13 | Ephemeral oracle keypair | **Stale.** `loadOracleKeypair` throws; no `Keypair.generate()` in production worker. | **Already resolved** (F-ORACLE-QUORUM). |
| CSO-14 | Docs path leak | Speculative. | **P3 accepted.** |
| CSO-15 | Skill curl\|bash / telemetry | Telemetry anonymous + prompted. Not product runtime. | **P3 accepted.** |
| (meta) | Claimed `.superstack/security-reports` absent | **False.** This file and `history.md` exist. | Filtered. |

No new Critical/High fund-flow. No new safety-relevant Medium requiring code this slice. Keys were not rotated. Primary checkout was not modified.

## Re-audit (secrets/CI calibration, 2026-08-25)

| Check | Result |
|---|---|
| `skipPreflight:\s*true` in `*.{ts,tsx,js}` | 0 matches |
| REST `findLiveBatchAccount` | gone |
| `CANDLE_RESOLUTIONS` | present; non-allowlisted 400 |
| `fetchWithTimeout` / `loadOracleKeypair` / `require.main === module` | present in `ops-oracle.js` |
| `registry_already_initialized` / `vault_already_initialized` / `should_apply_dfba_fills` / `oracle_already_initialized` | present |
| Focused tests (2026-08-25) | C03–C06 regression names all `ok` (oracle 2, vault 4, initialize 3, settle fill-apply 5, portfolio skip-reinit 1) |
| `git diff --check` | clean |
| Discriminators / PDA seeds / program IDs | unchanged |
| `compute_clearing` | not rewritten |
| Upgrade authority / Helius / RENDER_API_KEY | not mutated |
| Formal verification | still unavailable; not claimed |

## Design alignment (2026-08-25)

- Active design/architecture: DFBA (`docs/ai/design/feature-onchain-perps-dex.md`, `docs/ARCHITECTURE.md`).
- Compatible remediations (skip-reinit, PDA/ID checks, fill apply gate, operator fail-closed) do not change single-byte discs, account layouts, PDA seeds, program IDs, REST routes, or `compute_clearing`.
- Stopped (not silently broken): matcher Core-caller sysvar; Batch results pubkey binding.
- Historical commit-reveal remains labeled historical only.
