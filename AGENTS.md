# AGENTS.md

## Build & verify

```sh
cargo test --all-features                              # CI test command
cargo clippy --all-targets --all-features -- -D warnings   # CI lint (warnings = errors)
cargo build-sbf                                         # Build all 4 on-chain programs for BPF (also: make build-bpf)
cargo build --lib --all                                 # Native lib build (also: make build)
```

**Order:** Run `cargo clippy` then `cargo test`. Clippy warnings are hard errors in CI.

## What's where

| Directory | Role | Key fact |
|---|---|---|
| `programs/oracle/` | Fallback price oracle (M1) | BPF target, `no_std`, Pinocchio |
| `programs/common/` | Shared account validation, errors, math | `no_std`, dev-only proptest |
| `programs/perps-core/` | Perps core (M3-M5 + M6 6g-6k) | BPF target, `no_std`, Pinocchio |
| `programs/perps-matcher/` | CLOB matching engine (M6 6a-6f) | BPF target, `no_std`, Pinocchio |

## Architecture conventions

### Pinocchio, not Anchor
There is no IDL, no Anchor macros, no `anchor-spl`. Programs use raw `process_instruction` entrypoints with `pinocchio::entrypoint!()`.

### Two-layer instruction pattern (every program)
1. `entrypoint.rs` — raw byte deserialization, account validation (using `mgk-common` helpers), then delegates
2. `instructions/*.rs` — pure business logic on already-validated types

Account validation helpers live in `programs/common/src/`: `validate_owner`, `validate_writable`, `validate_signer`, `borrow_account_data`, `borrow_account_data_mut`.

### Single-byte instruction discriminators
Instruction dispatch uses `instruction_data[0]` as a u8 discriminator — **not** Anchor's 8-byte SHA256 digest. Add new instructions by appending to the match in `entrypoint.rs`.

### Hardcoded program IDs
Fresh IDs per ADR 0004, byte arrays in `programs/common/src/program_ids.rs`, base58 mirrored in `deployments/devnet.json` (a test keeps the two in sync). Only public keys are committed; the keypairs live outside the repo.
- Perps core: `9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT`
- Matcher: `68MQqdugxZQA2F8GahhWZEusPnHbrfAXjqq2V9VCz8tK`
- Oracle: `GLAu9n48oqnVRKHNoqfpek3kZyGUJTJRPQKo7mF3qWmm`

### Deployment manifest
`deployments/devnet.json` is the single source of cluster, program IDs, registry/instrument/oracle/insurance/maker addresses and start slot. Not-yet-deployed entries are explicit `{"status":"pending"}` placeholders. Schema: `deployments/manifest.schema.json`; validator and tests: `cargo test -p mgk-deployment`.

### Versioned accounts
Every account type starts with an 8-byte `AccountHeader` (`programs/common/src/layout.rs`): discriminator, layout version, 6 reserved bytes. Loaders (`load_account`, `load_account_mut`, `init_account_mut`) check it: a wrong discriminator (including zeroed accounts) is `MgkError::InvalidAccountDiscriminator` (8), a wrong version is `MgkError::UnsupportedLayoutVersion` (9). New account types need a discriminator in `layout::discriminator` and an `AccountLayout` impl.

### Host vs SBF layout
SBF aligns `u128`/`i128` to 8, the host to 16. Account structs with 128-bit fields therefore carry explicit padding so every such field sits at its 16-aligned offset and the size is identical on both. Compile-time `const _: () = { assert!(offset_of!(..) ..) }` blocks pin this and are evaluated by both `cargo build` and `cargo build-sbf`. Keep them updated when changing a struct.

### no_std
All programs use `no_std`. Programs use `#[cfg_attr(target_os = "solana", no_std)]` so they can compile for both BPF and native test.

## Testing

Tests are inline in `#[cfg(test)] mod tests` blocks within instruction/state source files. Run per-crate:

```sh
cargo test -p mgk-perps-matcher      # 130 tests + 1 ignored
cargo test -p mgk-perps-core         # 280 lib tests (283 with --all-features) + 24 lifecycle (20 run, 4 ignored for CU)
cargo test -p mgk-oracle           # 9 tests
cargo test -p mgk-common           # 71 tests
cargo test -p mgk-deployment       # 20 tests
```

Lifecycle tests load the SBF programs: run `cargo build-sbf` first, then
`BPF_OUT_DIR=$PWD/target/deploy cargo test -p mgk-perps-core --test lifecycle --features host-hash`.
Without `BPF_OUT_DIR` they skip. Tests and clippy need a recent stable toolchain (`cargo +stable ...`);
the Solana toolchain behind `cargo build-sbf` is older.

## SBF build quirks

- `.cargo/config.toml` sets `sbpf-linker` as the BPF linker.
- `sbf-solana-solana.json` is a custom LLVM target spec for Solana BPF.
- `Cargo.lock` is checked in despite `.gitignore` — intentional for reproducible builds.

## Error codes

Shared `MgkError` enum in `programs/common/src/error.rs` with ranges:
- 0–99: common (8 = `InvalidAccountDiscriminator`, 9 = `UnsupportedLayoutVersion`)
- 100–199 router, 200–299 slab, 300–399 matching, 400–499 risk, 500–599 anti-toxicity
- 600–699: perps-core, in three sub-ranges
  - 600–602: core (`RevealDeadlineExpired`, `InstrumentMissingForLiquidation`, `OperationPaused`)
  - 603–606: DFBA (`DfbaCapExceeded`, `MarkInvalidForLiquidation`, `BatchNotSettled`, `ReduceOnlyViolation`)
  - 607–612: reserve and insurance, issue 23 / ADR 0003 (`VaultInvariantViolated`,
    `PortfolioExposureLimitExceeded`, `MarketExposureLimitExceeded`, `RiskOffFundBelowReserve`,
    `FundWithdrawalExceedsSurplus`, `RecoveryConditionsNotMet`)

Registry defaults: `Initialize` now writes `max_orders_per_batch = 64` and `marginal_size_cap = 64`
(via `Registry::initialize_in_place`). Before the account-header change it wrote fields by raw offset
and left both at 0, so this is a behaviour change; adjust later with `SetBatchParams`.

Re-initialization: the oracle `Initialize` rejects an account whose discriminator is not
`UNINITIALIZED` (`MgkError::AlreadyInitialized`).

Errors are cast to `u64` via `From<MgkError> for u64` and returned by entrypoints.
