# Start a clean demo market under fresh program IDs; never migrate account layouts

Recovery abandons the existing devnet deployment (registry, batches, portfolios, vaults) rather than reconciling it. The accounting and margin contracts (ADR 0001, ADR 0002) change the batch, results and portfolio layouts, so old accounts cannot be read by the new code. The new demo market is deployed under newly generated program IDs, every account carries a discriminator and a layout-version byte checked on load, and the old deployment is left untouched and unsupported. Programs stay upgradeable, but only for layout-compatible changes; any future layout change pauses the market and starts a new demo market.

## Considered Options

- **Reconcile existing accounts with one-off migrations.** Rejected: a migration per changed layout, for worthless devnet SOL and a batch chain that is already broken (registry counter points at a missing batch).
- **Upgrade the existing program IDs and create new market accounts under them.** Rejected: old-layout accounts would remain owned by the new code and every instruction would have to reject them; one missed check is a misread.

## Consequences

Earlier devnet balances are not carried over and the UI says so. A single checked-in deployment manifest becomes the source of every address. Program rollback is only possible to a layout-compatible binary; otherwise the response is pause and fix forward.
