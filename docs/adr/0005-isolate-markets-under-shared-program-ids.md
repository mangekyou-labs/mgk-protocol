# Isolate layout-compatible markets under shared program IDs

Issue [#39](https://github.com/mangekyou-labs/mgk-protocol/issues/39) requires a throwaway market D′ whose insurance fund, pauses and lifecycle cannot affect the demo market. The deployed singleton registry and vault cannot provide that isolation. The user selected adding market isolation under the same program IDs, with a program upgrade and a rerun of every acceptance gate scenario.

This supersedes ADR 0004's rejection of additional accounts under an existing program ID **for layout-compatible market isolation only**. Its rule against migrating or reinterpreting incompatible account layouts still applies.

## Decision

An invocation carries one immutable market context. Unwrapped instructions use the default market and preserve its existing addresses. Core discriminator 29 and matcher discriminator 10 carry a 32-byte market seed followed by an existing instruction. Nested or truncated envelopes fail.

The scoped registry uses `[registry, market_seed]`. Its public key is included after the seed prefix of every child account: vault, instrument, portfolio, batch, book and results. Existing account bodies and versions remain unchanged. Ownership, account headers and canonical addresses authenticate the association before mutation. This applies to legacy instructions as well, so an unwrapped instruction cannot access scoped state. CPI authority and every target account must use the same context.

Creating a scoped market requires its governance signature and an additional initialization-only identity signature whose public key equals the market seed. This prevents another authority from claiming that namespace. The identity is not an ongoing authority. Initializers cannot reset stamped accounts; idempotent paths must validate and preserve existing state.

Each manifest and worker selects one context explicitly. Scans retain account addresses and validate canonical membership: account bodies alone do not identify the market. Each instrument has its own bound oracle account.

## Consequences

Markets have independent collateral, insurance, bad debt, open interest, order books, batch counters, settlement locks and pause flags. They share executable programs and upgrade authority, RPC capacity and network availability. This does not provide independent program upgrades.

The upgrade invalidates all earlier acceptance evidence. Local tests must cover default/scoped compatibility, crossed account substitutions, reinitialization, replay and independent lifecycle behavior. D′ runbooks still require live devnet evidence; local tests do not satisfy those rows. No upgrade, funding or pause transaction is authorized merely by recording this decision.
