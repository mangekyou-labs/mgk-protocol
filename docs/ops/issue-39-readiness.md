# Issue #39 rollout readiness — 2026-11-03

Issue #39 is **not complete**. This record covers read-only investigation and the
public monitoring configuration prerequisite. No D′ market was provisioned, no
transactions were sent, no secrets were read, and no service was deployed as part
of this change. The required D′ rows remain **not run**.

## Source and evidence boundary

The readiness branch started from integration commit
`52a7bdba0606700fe94be3fcc2714c3cb16e0da9` (master's merge of #38).
The deployed manifest is [deployments/devnet.json](../../deployments/devnet.json),
with start slot `517959329`. The earlier provisioning branch
`feature-issue-17-provisioning` at `727221f` predates that merge; its worker and
service behavior must not be treated as evidence that current master is deployed.
The manifest pins addresses, not the currently running hosted service commit.

The read-only investigation captured confirmed devnet `getMultipleAccounts`
at **2026-11-03 02:03:20 UTC**, context slot **518059091**, from
`https://api.devnet.solana.com`. Its raw response was retained locally in
`/tmp/mgk-issue-39-chain.json` during the investigation; that temporary file is not
a durable repository artifact. Values below are a timestamped observation, not a
continuing health guarantee. A subsequent readiness-worktree refresh encountered
sandbox DNS failure and did not replace this observation.

Before decoding, the readiness check verified non-executable accounts, their
owners, RPC space against decoded byte length, and sufficient layout size.
`decodeAccount` from the shared layout package then validated discriminator and
layout version. All four observed lengths exactly matched the checked-in layouts:

| Manifest account | Expected / observed owner | Bytes | Header discriminator / version | Observed state |
| --- | --- | --- | --- | --- |
| Registry | core `9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT` | 94 | 1 / 1 | batch counter 1; pause flags 0; one instrument |
| Instrument | core `9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT` | 352 | 6 / 1 | instrument 0 active; mark price 0 |
| PriceOracle | oracle `GLAu9n48oqnVRKHNoqfpek3kZyGUJTJRPQKo7mF3qWmm` | 128 | 9 / 1 | active; price 0; timestamp 0; no valid fresh price |
| Vault / insurance | core `9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT` | 80 | 5 / 2 | insurance 20,000,000,000 lamports; uncovered debt 0; long/short OI 0 |

Vault v2 is intentional: do not assume all accounts use version 1. The insurance
figure is the decoded `insuranceFund`, not the account's rent-inclusive balance.
These observations do not establish that a current batch has progressed or that
quotes, settlement, or any worker are live.

## Public fee payer configuration

[deployments/monitoring.json](../../deployments/monitoring.json) now names the
known provisioned public accounts. In the same confirmed snapshot, all three
were non-executable system-owned accounts with empty data:

| Role | Public address | Observed lamports |
| --- | --- | --- |
| Keeper | `FnuTgyBSp7wmvymWEFEQafYfqsgUZEXd8YxP5SWWkm2` | 500,000,000 |
| Oracle | `72dFyhGoA5uNep2XFTv4saMJVPecSNcthXZkaquUXHue` | 500,000,000 |
| Maker | `DPs1NM3TeR9f9WQBgqrT27dmf8F4DoJJVyBpqT5NGr4o` | 1,000,000,000 |

Each exceeded the configured fee floor of 10,000,000 lamports at observation.
This removes the missing-address configuration blocker in `/api/status`; it does
not establish a green aggregate status or that hosted workers use these signers.
The rollout budget's keeper/oracle 2 SOL each and demo maker 10 SOL remain funding
targets, distinct from the minimum fee health floor. Funded maker public address
does not prove a deposited and funded maker portfolio.

## Candidate hosted endpoints

Hostnames below were inferred from service names, not verified through an
operator-owned deployment record. The follow-up capture began at
**2026-11-03 02:04:09 UTC** (local raw evidence:
`/tmp/mgk-issue-39-endpoints-retry.json`).

| Candidate endpoint | Observed result | Interpretation limit |
| --- | --- | --- |
| `https://mgk-indexer.onrender.com/api/healthz` | HTTP 200; `status: healthy`, RPC reachable; processed/indexed slot and last successful sync null | HTTP/RPC liveness does not prove backfill, current manifest, or rollout readiness |
| `https://mgk-indexer.onrender.com/api/status` | HTTP 404 | Required aggregate status was unavailable at this candidate URL; the response alone does not identify the deployed commit |
| `https://mgk-oracle.onrender.com/healthz` | HTTP 200; `lastError: waiting for PRICE_ORACLE_ADDRESS/INSTRUMENT_ADDRESS (set at #38 deploy)` | Matches the old provisioning contract; not fresh oracle publication or evidence current master is deployed |
| `https://mgk-keeper.onrender.com/healthz` | HTTP 503 | Candidate request failed; does not establish the state of the intended worker deployment |

Earlier requests timed out for the indexer/oracle/keeper, and the candidate maker
`https://mgk-maker.onrender.com/healthz` returned 404. Current `render.yaml`
defines oracle, keeper, and maker as background workers without HTTP servers;
worker HTTP routes are not their readiness contract. Confirm actual service IDs,
pinned commits, public URLs, configured manifest and monitoring paths, and
sanitized logs before drawing deployment conclusions. External uptime monitor
provisioning and actual email/Slack alert delivery remain unverified.

## D′ isolation blocker and selected direction

R3 in [the rollout plan](../plans/sol-devnet-demo-rollout.md) requires an isolated
D′ under the **same program IDs**. The current implementation cannot provide an
independent registry/vault/fund/pause domain under those IDs:

- Core [Initialize](../../programs/perps-core/src/instructions/initialize.rs)
  requires the canonical `[registry]` PDA and rejects initialized registry data.
  The vault uses the singleton `[vault]` seed.
- Registry owns the global batch counter and pause flags. Vault owns insurance,
  debt, collateral balance, and open interest. Batch derivation uses
  `[batch, counter]`; adding an instrument shares that state rather than isolating
  it. [Keeper validation](../../tools/keeper-worker.js) enforces the canonical
  registry and vault, so alternate random manifest accounts cannot bypass this.
- Running fault or exhaustion scenarios on the existing singleton affects the
  demo's real fund and global pauses. The legacy `tools/init-protocol.js` is not
  an isolated D′ provisioner and must not be used as a substitute.

The user selected **market isolation under the same program IDs**, accepting a
program upgrade and rerunning all gate evidence. Add market namespaces throughout
the programs and dependent tooling, upgrade the candidate, then rerun the gate.
This changes the frozen candidate and invalidates existing gate evidence; prior
results cannot qualify the upgraded candidate. Isolation design exploration is
in progress; this configuration/documentation change does not implement it.

The alternative would be an explicit specification exception allowing separate
program IDs for D′, with a separately recorded deployment. That alternative was
not selected and does not satisfy the existing same-ID requirement.

## Remaining rollout work and evidence

Start current pinned services in the required order: oracle, validate a fresh
nonzero quorum-backed publication, then keeper, maker, and indexer. Verify maker
portfolio funding, batch progress, two-sided quotes, indexer backfill, aggregate
status, and delivered alerts. Operator provisioning must keep RPC credentials
and signer material outside the repository. Admin funding and pause/unpause
operations require the authorized signature flow after the isolation implementation
is available for deployment and rehearsal.

| Required D′ row | Status | Evidence still required |
| --- | --- | --- |
| P0-31 | **not run** | Stop oracle and maker, lower fee SOL below floor, capture fail-closed behavior after 60 s and fired status/UI checks, then restore |
| P0-32 | **not run** | Rehearse both runbooks with genuine Cleared >120 s and genuine uncovered debt; prove recovery, withdrawals unpaused before trading |
| P1-4 | **not run** | Browser evidence of the pause banner and paused-state UI |

Stopping the maker leaves GTC orders on chain; existing `makerDepth` tests resting
bid/ask presence, not process liveness or quote age. Agree the fault scenario
that removes/depletes quotes or change that contract before claiming its check
fired. Stopping oracle alone may allow a 2 s keeper to settle before staleness;
coordinate a real batch remaining Cleared before stale settlement attempts.
Pause-only simulation does not prove insurance exhaustion.

Follow [Cleared >2 min](../runbooks/cleared-unsettled.md) and
[insurance exhaustion](../runbooks/insurance-exhausted.md). For each D′ row retain
timestamps, deployment and service commits, batch IDs, confirmed signatures,
status JSON, delivered alerts, before/after snapshots, and browser artifacts
where applicable. Run `tools/runtime/audit.js` after recovery; settlement
invariant 5 also needs paired pre/post snapshots. Gate reporting must keep D′
rows unrun until that evidence exists; local test tier L cannot replace D′.

## Local validation of this prerequisite change

`node --test tools/render-blueprint.test.js` passed all five existing tests.
A read-only configuration check validated each public address as a 32-byte base58
key, matched the three captured system accounts and maker manifest address,
checked observed fee balances against the configured floor, and confirmed the
floor values were unchanged. All local Markdown links resolved.

The existing `/api/status` route coverage is in
`mgk-frontend/apps/indexer/src/cpiReplay.test.ts`. It was inspected but not rerun:
this worktree lacks frontend dependencies, and this change adds no route logic.
No new behavior tests or frontend bootstrap were needed for static configuration
and documentation. Rust clippy, cargo tests, and SBF builds were not run because
no Rust source changed. These checks do not qualify rollout or gate completion.
