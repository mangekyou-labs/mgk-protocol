# Issue #39 rollout readiness — 2026-11-03

Issue #39 remains **open** and PR #72 remains **draft**. D′ is deployed and
funded, workers are live, and both recovery procedures have been exercised.
The exhaustion recovery and flat withdrawal completed at slot 518207459.
P0-31 still lacks complete fault/alert evidence; indexer backfill and CI also
remain release blockers. This is not a production sign-off.

## Dated correction — public rollout and rehearsal evidence

This update supersedes the earlier local-only observations retained below.
The operator signed public devnet transactions; the agent used read-only chain
probes and the authorized Render suspend/resume actions. The agent did not read
keypair files or sign/send transactions. Production frontend settings were not
changed; the restored trade UI was deployed as a D′ preview.

The shared manifest is [devnet-dprime.json](../../deployments/devnet-dprime.json),
with market seed `GBz4U7gb3nqALmtBBYajKgngFjbEsjPzM86X7ZADPwt4`, registry
`CbwTpmDgb6KKfBpv156754dXBpCoKPyjGt1kmJAb8mtR`, and start slot `518144057`.
D′ uses the same program IDs as the default market, with separate registry,
vault, portfolios, book and batches. Its initial insurance and maker collateral
were 3 SOL each. The [deployment record](../ai/deployment/2026-11-03-issue-39-dprime.md)
records executable hashes, service pins and the preview.

### Current D′ gate assessment

| Required row | Assessment | Evidence and remaining limits |
| --- | --- | --- |
| P0-31 | **partial; not passed** | [Fault snapshot](evidence/issue-39-2026-11-03/p031-failclosed.json): oracle age 245 s, batch 201 Cleared for 178 s, keeper 8,671,680 lamports below the 10M floor; oracle/batch/fee checks critical. [Recovery](evidence/issue-39-2026-11-03/p031-recovered.json): batch 211 and fresh price. Stopping maker left resting GTC depth `ok`; a maker-stop depth/liveness check and actual external alert delivery remain unproved. Pause UI evidence exists below, but is not proof of each outage banner. |
| P0-32 | **procedures exercised; final gate review pending** | The post-upgrade batch-201 stall/recovery above also exercises the Cleared >2 min runbook. The exhaustion sequence below proves real debt, auto-pause, debt repayment, ordered unpause and a successful flat withdrawal. No successful taker reduce-only close occurred: liquidation removed the position first. Runbook follow-up and transaction-paired invariant evidence remain explicit limits. |
| P1-4 | **pass for recorded preview** | Reviewed [paused](evidence/issue-39-2026-11-03/p1-4-pause-banner.png) and [unpaused](evidence/issue-39-2026-11-03/p1-4-unpaused.png) screenshots, with [flags 3](evidence/issue-39-2026-11-03/p1-paused-status.json) and [flags 0](evidence/issue-39-2026-11-03/p1-unpaused-status.json). The resumed screenshot shows two-sided quotes and a fresh oracle. Any frontend change requires rerunning this browser row. |

An earlier batch-92 Cleared rehearsal preceded the matcher upgrade at slot
518171780, so it does not qualify the current executable. Batch 201's 178 s
stall and subsequent recovery occurred after that upgrade and are the current
Cleared-runbook evidence. Do not present the old batch-92 capture as a new pass.

### Insurance exhaustion and recovery

At 11:47:17 UTC, the [pre-crash account snapshot](evidence/issue-39-2026-11-03/p032-precrash.json)
showed taker +300 lots, maker −300, fund 80,150,434 lamports and zero debt.
Taker equity was 799,849,566 lamports, exceeding the original 0.4 SOL estimate:
[transaction history](evidence/issue-39-2026-11-03/p032-taker-transactions.json)
confirms two separate 0.4 SOL deposits before the buy. This explains the smaller
actual shortfall. The oracle service was suspended at 11:47:35 UTC; the operator
then posted the $20 crash price.

The maker's `LiquidateUser` succeeded at slot **518205530**, signature
`2jKZ9AXRCSz8mg9G6JfSuFax3P7vi4J1qxeUeVkxNzhkTiVWEf9eBUcHTKe2jA6S7WY7FBfN6CDhNWQfYtW7cbEL`.
Both positions became flat, fund reached zero, debt became **212,857,100
lamports**, and pause flags became **3**. The [account observation summary](evidence/issue-39-2026-11-03/p032-exhaustion-observation.json)
explains its provenance; the [status response](evidence/issue-39-2026-11-03/p032-exhausted-status.json)
independently records zero insurance and flags 3. The taker's attempted
reduce-only close failed simulation with custom 606 because no position remained;
that attempt did not send a close transaction.

The operator's confirmed recovery transactions are recorded with logs, fees,
slots and lamport deltas in the history linked above and in the
[signature list](evidence/issue-39-2026-11-03/p032-operator-recovery-signatures.json):

| Operation | Slot | Result |
| --- | --- | --- |
| TopUp 1.7 SOL | 518206463 | Debt repaid first; fund 1,487,142,900 lamports |
| Unpause withdrawals | 518206499 | Flags 3 → 1 |
| Unpause trading | 518206526 | Flags 1 → 0 |
| Flat deposit 0.05 SOL | 518206563 | Vault +50,000,000 lamports |
| Flat withdraw 0.05 SOL | 518207459 | Vault −50,000,000; wallet +49,995,000 after 5,000 lamport fee |

The first withdrawal simulations returned custom 602 despite flags 0 because
batch 432 was Cleared with the global settlement lock set. `Withdraw` uses the
same message for the governance pause and the settlement lock. Resuming the
oracle at 11:52:53 UTC allowed the keeper to settle it. The operator's temporary
withdrawal helper then waited for a clear lock and retried only rejected
simulations; it never retries a sent transaction or uncertain confirmation.
Its five safety tests passed before operator use.

The [recovery status](evidence/issue-39-2026-11-03/p032-recovery-status.json)
shows oracle, batch, maker depth, fees, insurance, pause and RPC all `ok`, with
only indexer `warn` (58,079 slots behind). The
[recovery accounts](evidence/issue-39-2026-11-03/p032-recovery-live.json) show
zero taker equity and no position after withdrawal. A later Cleared phase in
that snapshot is a normal new batch, not evidence of another governance pause.

The [read-only recovery audit](evidence/issue-39-2026-11-03/p032-recovery-audit.json)
at slot 518207977 reports **zero violations**: vault identity, signed auction
quantity, receipt application, nonnegative withdrawable balance, collateral
and open-interest consistency pass where evaluable. Eligible fill size cannot
be evaluated with no cleared batch awaiting settlement; the reduce invariant
needs paired snapshots around a settling transaction. These are **not evaluated**,
not passes. No open positions remain for the net-position consistency check.

### Remaining work

Keep #39 open and PR #72 draft until P0-31 and P0-32 have their full required
evidence. Confirm actual external alert delivery, complete the missing maker
fault/UX evidence, and retain transaction-paired snapshots for invariant 5.
Complete indexer backfill, show the early fills without duplicates, and recheck
health. Free Render instances have ephemeral storage and can sleep after idle
periods: keep `/healthz` warm during drills and do not redeploy/reset the indexer
just to update documentation. Match all required service/source pins and rerun
affected evidence after off-chain changes. CI failures and their fixes are
tracked separately from the known local rustc-1.79 layout-build limitation.

## Historical investigation — retained as observed

The following sections describe the earlier 02:03 UTC investigation and local
candidate verification. Statements such as “not deployed” or “not run” below are
historical and superseded by the dated correction above; they are retained to
preserve the evidence boundary.

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
D′ under the **same program IDs**. The deployed candidate observed above has a
singleton registry and vault: its batch counter, insurance fund, debt, and pause
flags cannot isolate D′ from the demo. Adding another instrument is insufficient.
The legacy `tools/init-protocol.js` is not an isolated D′ provisioner.

The user selected **market isolation under the same program IDs**, accepting a
program upgrade and rerunning all gate evidence. The local implementation follows
[ADR 0005](../adr/0005-isolate-markets-under-shared-program-ids.md): an explicit
market identity scopes registry, child accounts, instructions, workers, and
indexer storage while preserving legacy addresses and layouts. Real local SBF
tests exercise isolated settlement, insurance exhaustion, and pause recovery.

This candidate is **not deployed**. Upgrading changes the frozen executable bytes
and invalidates every prior gate result. Rerun all gate evidence against the
upgraded candidate, including default-market compatibility and every D′ row.

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

## Local validation of the isolation candidate

Fresh integrated verification passed:

- Rust clippy with all targets/features and warnings denied, followed by all-feature
  tests: 524 passed, six existing tests ignored. Candidate SBF artifacts built.
- Two real-SBF market-isolation scenarios: default plus two scoped markets,
  cross-market substitution and replay rejection, real insurance exhaustion,
  debt repayment, and withdrawals-before-trading recovery.
- Real keeper and maker CLI scenarios in both default and scoped contexts:
  four passed. Default lifecycle smoke, book growth, and indexer startup passed.
- Harness/audit/context tests: 47 passed; worker/layout tests: 54 passed.
- Indexer: 115 tests passed and TypeScript build passed. Web: 488 tests passed
  and typecheck passed. SDK build and 156 tests passed.
- Both standards and spec reviews completed; all three findings were fixed and
  rechecked, including regression coverage for cross-market storage/configuration
  and failed malformed CPI handling.

The web production build could not fetch Google Fonts in this environment.
These local checks do not qualify any public rollout or D′ gate row.
