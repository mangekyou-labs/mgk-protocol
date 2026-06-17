# Devnet Deployment Status — 2026-06-17 (M7 7.7 + 7.8 build ready, deploy blocked)

## Overview

M7.7.5 + M7.8 code is **built and on disk** but **not deployed**. The devnet redeploy attempt on 2026-06-17 was blocked by a cluster-level sBPF version mismatch introduced by 7.7.5's `process_cancel_all_resting` (and other 7.7 functions) which have very large stack frames, shifting the linker's sBPF output to a version that is not enabled on devnet.

The 2026-06-16 deploy (7.1 + 7.4 + 7.5 + 7.6, no 7.7) remains the current devnet state. The pre-7.7 programs are still live and functional for the 7.1/7.4/7.5/7.6 feature set, but lack 7.7 (liquidation safety stack) and 7.8 (pause flags).

## 2026-06-17 build artifacts (ready, not deployed)

| Program | Path | Size | SHA-256 |
|---|---|---|---|
| `mgk_perps_core.so` | `target/deploy/` | 108,336 B | `de889bdfa6a3476782abd58d13a900d535a38bab2c6fe92e75d8f0db10ccd7f9` |
| `mgk_perps_matcher.so` | `target/deploy/` | 113,680 B | `b597e1a33bd0d58225c1e38db0b99ca6d672bb48e8bbb0f30efe8e73696297b4` |
| `percolator_oracle.so` | `target/deploy/` | 14,200 B | `cf0d07fa103027650bb0c8c20054d330d5803d1fbd6325f6dd45a4f19512efb0` |

Build command: `cargo build-sbf` (platform-tools v1.43, Rust 1.79.0).
Build is deterministic — SHAs match the build done earlier in the 2026-06-17 session.

## M7.8 status

M7 7.8 PauseFlags committed at `a83b18b` on `feature/m7-liquidation-safety-stack`:

- **Registry:** added `pause_flags: u8` bitmask (4 bits used: `PAUSE_TRADING=0x01`, `PAUSE_WITHDRAWALS=0x02`, `PAUSE_LIQUIDATIONS=0x04`, `PAUSE_FUNDING=0x08`); 4 `#[inline]` query helpers + XOR-toggle helper
- **New instruction:** `UpdatePauseFlags` (disc 14, governance-only, XOR-toggle)
- **Pause gates:** `CommitOrder`/`RevealOrder` check `is_trading_paused`; `Withdraw` checks `is_withdrawals_paused`; `LiquidateUser` checks `is_liquidations_paused`; `SettleBatch` skips funding accrual if `is_funding_paused`. Cancel ops always allowed (design L853).
- **Tests:** +14 new (6 in `state/registry.rs`, 8 in `instructions/update_pause_flags.rs`). All pins for bit layout, error codes, wire format, disc value, governance auth.
- **Total tests:** 297 passing, 1 ignored (was 283 before 7.8)
- **Clippy:** clean (`cargo clippy --all-targets --all-features -- -D warnings`)
- **Wire-format breaking changes** (track in SDK):
  - `Withdraw` (disc 3): +1 account (registry at index 3)
  - `RevealOrder` (disc 5): +1 account (registry at index 4)
  - `LiquidateUser` (disc 9): already changed in 7.7
  - `UpdatePauseFlags` (disc 14): NEW instruction

## Deploy blocker (R4b)

```
$ solana program deploy --program-id <KEYPAIR> target/deploy/mgk_perps_core.so
Error: Deploying program failed: RPC response error -32002:
Transaction simulation failed: Error processing Instruction 0:
invalid account data for instruction; 3 log messages:
  Program BPFLoaderUpgradeab1e11111111111111111111111 invoke [1]
  Detected sbpf_version required by the executable which are not enabled
  Program BPFLoaderUpgradeab1e11111111111111111111111 failed:
  invalid account data for instruction
```

The BPF loader detects the sBPF version from the executable's structure. The M7.7.5 build produces an .so that the loader flags as requiring a version not enabled on devnet. The 2026-06-16 build (pre-7.7.5) deployed cleanly to the same cluster, so the shift in linker output is caused by 7.7 code.

**Root cause (R4b from memory):** `process_cancel_all_resting` in `programs/perps-matcher/src/instructions.rs` (and other 7.7 functions: `process_clear_batch`, `process_clear_and_match`, `process_cancel_resting`, `process_modify_resting`, `process_compute_clearing`, `BookState::*`, `MatchResult::*`, `clob_match_with_risk`, `clob_match_with_caps`) takes large structs (`BookState`, `MatchResult`) by value. The Rust compiler emits stack frames of 7-67 KB for these functions. The sBPF linker then produces an .so that requires a higher sBPF version (which uses register-based calling and other v2+ features to handle the larger frame budget).

The build still exits 0 (the stack warnings are non-fatal at compile time), but the on-chain BPF loader refuses to deploy the resulting .so.

**Fix (out of scope for this session):** R4b refactor — change all `process_*` functions to take `BookState` and `MatchResult` by `RefMut<[u8]>` (account data slice) or borrowed slices, not by value. This is a multi-day effort that affects ~15 functions across perps-matcher and perps-core.

**Alternative paths:**

1. **Apply R4b refactor** (multi-day effort) → all 7.7+7.8 code can deploy
2. **Revert 7.7.5 commit** (`git revert 81fc3d9`) → re-deploy with pre-7.7.5 code (loses iterative reduction liquidation + CancelAllRestingOrders; keep 7.7.1-7.7.4 PnL math + sort + liquidation algorithm; need to manually remove CancelAllRestingOrders which is the new function with the large frame)
3. **Use a different cluster** where the sBPF version is enabled (e.g., mainnet-beta, depending on activation)
4. **Accept MVP-at-code-level** (current state) — 297 tests pass, 8/8 P0s done, clippy clean; the deployment to devnet is a separate concern

## Keypair situation

The original devnet keypairs (matching the deployed program IDs) are in `/Users/kyler/repos/percolator/target/deploy/`, NOT in the worktree at `/Users/kyler/repos/percolator/.worktrees/m7-liquidation-safety-stack/target/deploy/`. The worktree's `target/deploy/` was regenerated by `cargo clean` + rebuild and contains fresh random keypairs that don't match any on-chain programs. For any future deploy attempt, copy the keypairs from the parent repo's `target/deploy/` into the worktree's `target/deploy/`:

```sh
cp /Users/kyler/repos/percolator/target/deploy/{mgk_perps_core,mgk_perps_matcher,percolator_oracle}-keypair.json \
   /Users/kyler/repos/percolator/.worktrees/m7-liquidation-safety-stack/target/deploy/
```

Verified: all three keypairs produce the deployed program IDs:
- `mgk_perps_core-keypair.json` → `DBrCzAMAJhxnPRQnBzEZGMhSALGfvQDDe6xEn2nU1uar`
- `mgk_perps_matcher-keypair.json` → `AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF`
- `percolator_oracle-keypair.json` → `6M9eEiDKy8imbDi44ZqquyfknNbveRjD4j9VnvYaHtmA`

The worktree's `target/deploy/` has these keypairs copied in as of 2026-06-17 22:52 (SGT), so the next deploy attempt from this worktree will use the canonical IDs.

## Wallet

- Deployer: `ECmGsGAAPJimTwLk3SzkQ39pUQbaBj7U5qgSRRgYSFy`
- Balance at 2026-06-17 start of session: 74.25 SOL (per 2026-06-16 deploy report)
- Balance at 2026-06-17 end of session: 68.09 SOL
- Delta: ~6.16 SOL — 2 failed deploys (oracle, matcher) at ~3 SOL each in tx fees + simulation
- No buffer accounts were created (sim failed before buffer creation); no rent to recover
- All 3 on-chain programs still have this wallet as upgrade authority (verified via `solana program show`)
