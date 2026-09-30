# mgk — Build Context

## Project
- **Name**: mgk (formerly percolator; rebrand completed 2026-08-05)
- **Description**: On-chain perpetual futures exchange with Dual Flow Batch Auction (DFBA) matching, persistent GTC book, and cross-margin. Built on Solana using Pinocchio (not Anchor). Commit-reveal CLOB (M1–M8) is retired.
- **Status**: M9.0–M9.10 complete; 2026-08-24 DFBA programs on devnet. M9.11 code complete (T9.11.1–11). T9.11.12–13 post-merge deploy/smoke are out of the internal CSO slice (no mutation). Mainnet blocked on independent audit, multisig authorities, CU/latency evidence, incident/bug-bounty/HA.

## Stack
- **Language**: Rust (`no_std`, zero-allocation, BPF-compatible) + TypeScript (Next.js 16 web, Fastify indexer, Node 22 tools)
- **Framework**: Pinocchio (no Anchor macros, no IDL, single-byte discriminators)
- **Platform**: Solana BPF
- **Testing**: `cargo +stable test --all-features`, `cargo +stable clippy --all-targets --all-features -- -D warnings`
- **Verification**: Formal verification (Fender / QEDGen / Kani `model_safety`) is **unavailable**. Do not claim FV. Host unit + proptest-class tests cover remediations. Four lifecycle e2e cases remain `#[ignore]` (program-test CU harness debt, not proven production defects).

## Architecture

### Programs (4)

| Program | Crate | Program ID (devnet 2026-08-24) | Role |
|---|---|---|---|
| oracle | `mgk-oracle` | `CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ` | Fallback / multi-venue index (admin-pushed) |
| perps-core | `mgk-perps-core` | `C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx` | Custody, batch lifecycle, liquidation, funding |
| perps-matcher | `mgk-perps-matcher` | `7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC` | DFBA dual auction (CPI target from core) |
| common | `mgk-common` | (library) | Account validation, errors, math, types |

PriceOracle account: `5NSDGAaRqfxe6mkZG9fEAZdzK4r77nEBEobohZGYP6PN`. Instrument: `Hz9UtmSXyKFnp1pGvrhrAmizMsvEkYRh5Eih1r7Lf1hG`.

### Patterns
- **Instruction dispatch**: single-byte u8 discriminator (`instruction_data[0]`)
- **Layers**: `entrypoint.rs` (raw byte deserialization + account validation) → `instructions/*.rs` (pure business logic)
- **PDAs**: seed-prefixed (`b"portfolio"`, `b"batch"`, `b"book"`, `b"vault"`, `b"registry"`); production canonical checks fail closed on host PDA stub
- **CPI**: Core → Matcher (one-way). Matcher mutations require stack height > 1 on Solana. Full Core-caller authentication is a blocking design/migration (Instructions sysvar).
- **Custody**: Core program is the only program authorized to move user funds
- **Matching**: Collecting/Committing → Clearing → Settled; `mark_valid` dual-clear gate
- **Testing**: inline `#[cfg(test)] mod tests`; integration in `programs/perps-core/tests/lifecycle.rs`

### Error Ranges
- 0–99: common
- 100–199: router (legacy)
- 200–299: slab (legacy)
- 300–399: matching
- 400–499: risk
- 600–699: perps-core DFBA (`AlreadyInitialized=115`, `ReduceOnlyViolation=606`, …)
- 700–799: perps-matcher (reserved)

## Design

- **Design doc**: `docs/ai/design/feature-onchain-perps-dex.md` (DFBA)
- **Public architecture**: `docs/ARCHITECTURE.md` (DFBA as of 2026-08-24)
- **Key mechanic**: Dual Flow Batch Auction — two independent uniform-price auctions; makers never match makers
- **Collateral**: SOL-only
- **Oracle**: admin fallback + multi-venue index for funding; mark is pure DFBA dual mid

## Build Status

- **Current milestone**: M9.10 Done (T9.10.1–7) + devnet deploy 2026-08-24 (core upgrade slot 487386516). M9.11.1–11 code Done. Internal CSO (M9.12) Done 2026-08-24 in `feature-dfba-auction` worktree; secrets/CI calibration 2026-08-25. Independent mainnet audit **not** complete.
- **Milestones completed**: M1–M8 (historical commit-reveal), M9.0–M9.10 (DFBA)
- **Tests**: `cargo +stable test --all-features` — common 48, oracle 7, core lib 291, lifecycle 7 pass / 4 ignored, matcher 116 pass / 1 ignored (2026-08-24 CSO C03–C06)
- **Clippy**: `cargo +stable clippy --all-targets --all-features -- -D warnings` clean
- **SBF**: `cargo build-sbf` artifacts 2026-08-25 00:02 — oracle 13360, core 145464, matcher 120344
- **Indexer checks**: workspace typecheck + **89** tests under Node 22.19.0 after `better-sqlite3` ABI 127 rebuild; REST GPA removed
- **Frontend**: sdk 164, web 497 vitest; Playwright trade+wallet **39 passed**; `pnpm -r build` Next.js 16.2.9
- **Tools**: `cd tools && npm test` — 69 pass
- **CU-ignored tests**: remain test debt unless proven a security defect
- **Program IDs**: canonical arrays in `programs/common/src/program_ids.rs`

## Blocking Issues (mainnet)

| Issue | Status |
|---|---|
| Independent Solana audit | Required; this CSO is internal only |
| Multisig upgrade authority | Single wallet `ECmGsGAAPJimTwLk3SzkQ39pUQbaBj7U5qgSRRgYSFy` (no rotation this slice) |
| Matcher Core-caller authentication | Stack-height only; sysvar is a layout-breaking follow-on |
| SettleBatch results authenticity | Length-OR fixed; binding results pubkey to Batch is a layout-breaking follow-on |
| Latency p50/p99 + CU-cap at 64 | Evidence still open |
| Incident / bug-bounty / HA | Open |
| T9.11.12–13 Render/Vercel cutover | Out of CSO slice (no mutation) |

### Test Inventory (2026-08-24 CSO)

| Crate | Tests |
|---|---|
| `mgk-common` | 48 |
| `mgk-oracle` | 7 |
| `mgk-perps-matcher` | 116 (+ 1 ignored) |
| `mgk-perps-core` (lib) | 291 |
| `mgk-perps-core/tests/lifecycle.rs` | 7 e2e pass, 4 ignored (CU harness) |
| `tools/` | 69 |
| `@mgk/sdk` | 164 |
| indexer | 89 |
| web vitest | 497 |
| Playwright trade+wallet | 39 |

### Key docs
- Planning: `docs/ai/planning/2026-08-02-feature-onchain-perps-dex.md`
- Testing: `docs/ai/testing/2026-08-02-feature-onchain-perps-dex.md`
- CSO: `.superstack/security-reports/feature-dfba-auction-2026-08-24.md`
