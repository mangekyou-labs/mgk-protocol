---
phase: implementation
title: On-Chain Perps DEX — Internal CSO remediations (2026-08-24)
description: Compatible security remediations after comprehensive CSO on the feature-dfba-auction worktree. No deploy, authority change, or independent-audit claim.
feature: onchain-perps-dex
date: 2026-08-24
worktree: .worktrees/feature-dfba-auction
head: be6e590
---

# Implementation — DFBA mainnet-readiness CSO remediations

Work isolated to `/Users/kyler/repos/percolator/.worktrees/feature-dfba-auction`. Primary checkout was not modified.

## Scope

- Treat M9.0–M9.10 and 2026-08-24 devnet deployment as complete.
- Comprehensive internal CSO (2/10) on the actual working tree, including untracked files.
- TDD remediations for Critical/High and safety-relevant Medium findings.
- Preserve discriminators, layouts, PDA seeds, program IDs, SDK encodings, REST routes, DFBA matching.

## Code changes

| Area | Change | Compatibility |
|---|---|---|
| `mgk-common` `program_ids.rs` | `validate_matcher_program_id`, `validate_system_program_id` (`[0u8;32]`) | IDs unchanged |
| `perps-core` `pda.rs` | Fail-closed `is_canonical_vault` / `is_canonical_registry` via `try_find_program_address` | Seeds unchanged |
| InitPortfolioForUser / CreatePortfolio / InitPortfolio | Skip same user; `AlreadyInitialized` on other user; PDA match | Disc 19 / existing discs unchanged |
| Core entrypoint CPI sites | Matcher ID + vault/registry PDA + System Program ID | Account lists unchanged |
| `deposit.rs` | System Program ID before System CPI | Wire unchanged |
| `liquidate_user.rs` | Vault PDA, instrument owner, canonical oracle owner | Account list unchanged |
| Matcher `require_cpi` | Stack height > 1 on Solana; native no-op | **Not** full Core-caller auth (blocking design) |
| `tools/ops-oracle.js` | `require.main === module` guard; decode/health/sanitize; quorum minVenues + positivity; no ephemeral authority; 3s venue timeout; stopLoop | UpdatePrice disc 1 still 17 bytes |
| `tools/ops-keeper.js` | SDK-aligned Registry/Batch decode; 6-byte SettleBatch bump at `[5]`; LiquidateUser disc 9; fail-closed portfolio cap | Discs unchanged |
| Indexer REST | Candle resolution allowlist; no GPA on request path; book cache keyed by instrumentId | GET routes unchanged |
| SDK `encodeSettleBatch` | 6 bytes, optional bump default 0 | Compatible with on-chain missing-bump=0 |
| Web wallet | `WALLET_TX_SEND_OPTS.skipPreflight=false`; indexer batch address only if batchId matches; RPC URL credential warn-only | No public API break |
| Playwright fixtures | BPF `repr(C)` Portfolio + quoted book (test debt, not a product finding) | N/A |
| Core `Initialize` | Skip-reinit when governance or bump is set (`AlreadyInitialized=115`) | Disc 0 / 86-byte registry unchanged |
| Core `InitVault` | Skip-rezero when bump, balance, or insurance is set | Disc 15 / 80-byte vault unchanged |
| Core `SettleBatch` | Apply DFBA fills only if `matched_*` or `mark_valid`; parse DFBA vs CLOB still by length | Disc 8 / results wire / Batch layout unchanged |
| Oracle `Initialize` | Skip-reinit when `PriceOracle::validate()` is true | Disc 0 / 9-byte payload / 128-byte layout unchanged |

`compute_clearing`, allocation, and settlement semantics were **not** rewritten. Results pubkey was **not** added to Batch (layout break).

## Blocking design (not silently broken)

Full matcher Core-caller authentication needs the Instructions sysvar or an extra signer. Stopped as a migration task. Residual: any program can still CPI matcher after the stack-height gate.

Binding SettleBatch results to the ClearBatch output needs a results pubkey (or PDA) on Batch. Stopped — `_dfba_pad` is only 6 bytes. Residual: after a real Clear, a substituted matcher-owned results account at the same prices can still apply.

## Design alignment

- Active architecture is DFBA (`docs/ARCHITECTURE.md` rewritten).
- Design doc still DFBA; grant proposal marked historical (old IDs / commit-reveal narrative preserved, not active).
- Independent audit, Squads, CU/latency, incident/bounty/HA remain mainnet blockers.

## Verification evidence (this slice)

See `docs/ai/testing/2026-08-02-feature-onchain-perps-dex.md` Session CSO and `.superstack/security-reports/feature-dfba-auction-2026-08-24.md`.

| Gate | Result |
|---|---|
| `cargo +stable clippy --all-targets --all-features -- -D warnings` | clean (exit 0) after C03–C06 |
| `cargo +stable test --all-features` | common 48, oracle **7**, core **291**, lifecycle 7/4 ignored, matcher 116/1 ignored |
| `cargo +stable build --lib --all` | ok |
| `cargo build-sbf` | three `.so` rebuilt 2026-08-25 00:02 (oracle **13360**, core **145464**, matcher 120344) |
| `cd tools && npm test` | 69 pass / 0 fail |
| Frontend workspace (Node 22.19.0, prior close-out) | unchanged this wave: sdk 164, indexer 89, web 497, Playwright 39 |
| `git diff --check` | clean (exit 0) |
| `npx ai-devkit@latest lint` | pass (all checks passed) |
| `npx ai-devkit@latest lint --feature onchain-perps-dex` | pass; WARN no dedicated `onchain-perps-dex` worktree (using `feature-dfba-auction`) |

## Secrets/CI calibration (2026-08-25)

No new on-chain or frontend product change. Parallel secrets/CI scan calibrated into `.superstack/security-reports/feature-dfba-auction-2026-08-24.md`.

- Stale “Highs” already remediations: candle SQL allowlist, oracle 3s timeout + stopLoop, no ephemeral oracle keypair.
- Accepted / unauthorized to mutate: gitignored RENDER_API_KEY, Helius client RPC credential (warn-only), single upgrade EOA, indexer CORS, unpinned GHA + dead Kani, CSP `https:` wildcard (F-CSP-CONNECT).
- Focused C03–C06 regression tests re-run 2026-08-25: all `ok`. `git diff --check` clean.
- Node 22.19.0 frontend gates after `pnpm --filter indexer rebuild better-sqlite3`: sdk 164, indexer 89, web 497; `pnpm -r build` Next.js 16.2.9; `cd tools && npm test` 69 pass.
- Design alignment: remediations stay inside existing discs/layouts/IDs; matcher Core-caller sysvar and Batch results binding remain stopped migrations.
