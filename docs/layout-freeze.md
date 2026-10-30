# Protocol layout freeze (#25)

This checkpoint freezes the current program account layouts, versions, one-byte instruction discriminators, and packed instruction bodies. A later change requires explicit user approval before editing the program layout/version or accepting regenerated fixtures. Do not update golden files merely to make CI pass. Record the approved reason and migration in this document and an ADR when behavior changes.

## Frozen accounts

All account headers start with discriminator and version at bytes 0 and 1. Native struct padding is part of the wire format. Sizes and every nested field offset are generated from actual Rust types in `programs/perps-core/examples/export_layouts.rs`, committed in `mgk-frontend/packages/layout/program-layouts.json`, and decoded by the portable `@mgk/layout` module.

| Account | Bytes | Discriminator | Version |
| --- | ---: | ---: | ---: |
| Batch | 176 | 2 | 1 |
| Commitment | 176 | 3 | 1 |
| Instrument | 352 | 6 | 1 |
| OrderBook | 3128 | 7 | 1 |
| Portfolio | 2848 | 4 | 3 |
| PriceOracle | 128 | 9 | 1 |
| Registry | 94 | 1 | 1 |
| SlabHeader | 200 | 10 | 1 |
| Vault | 80 | 5 | 2 |
| BatchResults | 51 + 58 × fills (maximum 12) | 8 | 1 |

BatchResults is packed: account header 8, envelope 9, DFBA header 34, then fill records. Its fixture comes from the actual matcher serializer, not a mirror encoder. Slab uses its Rust header and the areas addressed by its offset fields; OrderBook uses its Rust header plus 256 resting orders and the trailing order counter. Instrument oracle address begins at byte 68. Portfolio v3 is 2848 bytes and Registry is 94 bytes.

## Instruction formats and consumers

`mgk-frontend/packages/layout/instructions.js` is the shared format table and encoder for all core (0–28), matcher (0–9), and oracle (0–4) instructions, including disabled legacy dispatches. Fields are packed little-endian; account alignment must never be applied to instruction bodies. SettleBatch optionally appends the next-batch bump. Initialize includes registry parameters and all three bumps; AddInstrument is 60 bytes including discriminator. SDK, indexer and tools use this table; SDK typed wrappers preserve their public interfaces.

All off-chain account readers use `@mgk/layout`; SDK wrappers add PublicKey and domain types. `scripts/check-layouts.sh` regenerates fixtures in a temporary directory and compares them byte-for-byte. CI also runs portable, SDK, indexer, dashboard and operational tests. A fixture mismatch requires investigation and user approval for an actual layout change.

## Deployment and transaction boundary

The dashboard validates `deployments/devnet.json` through the public manifest loader. Program and account identities come only from this manifest. Pending accounts disable signing; transport endpoint environment variables remain supported. The current batch is derived from registry state, never a fixed manifest or environment override.

Transaction success requires an error-free confirmed or finalized signature status. Submission, processed status, elapsed slots and RPC failures cannot report success. Expiration, execution failure and confirmation timeout reject.

## Approved behavior checkpoint

The #53 decision preserves all current behavior: exposure admission checks use current open interest at post/modify; risk-off requires reduce-only even for closes; no separate loser-shortfall counter exists; SetPauseFlags cannot clear trading/withdrawal pauses and slashed legacy deposits do not credit the fund. See [ADR 0003](adr/0003-insurance-fund-is-the-cash-backed-counterparty-to-realized-pnl.md). No on-chain behavior or account layout changes are part of this freeze.
