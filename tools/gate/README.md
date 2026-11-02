# Independent lamport reference model

`reference_model.py` is a Python standard-library ledger derived from the SOL demo accounting, margin, and insurance contracts. It imports no program or SDK code. Supply observed signed fills in settlement order, with prices in micro-USD per SOL and signed quantities in 0.001 SOL lots. The conversion price supplied for each fill is assumed to have passed the oracle validity checks; a nonpositive price is rejected.

```python
from reference_model import Fill, Ledger

ledger = Ledger(fund_lamports=20_000_000_000, collateral={"trader": 1_000_000_000})
ledger.apply_fill(Fill("trader", 100, 100_000_000, 110_000_000, maker=False))
ledger.apply_fill(Fill("trader", -100, 110_000_000, 110_000_000, maker=False))
print(ledger.collateral, ledger.fund_lamports, ledger.uncovered_bad_debt)
print(ledger.vault_liability_lamports())
```

`collateral` holds expected lamports for each trader. `fund_lamports` and `uncovered_bad_debt` complete the vault liability equation. Call `withdraw(account, lamports, conversion_price, reservations=0)` for a position-bearing account; the model checks unrealized loss, initial margin and reservations. A flat account may omit the conversion price so a stale oracle does not trap idle collateral. The model also tracks positions, realized micro-USD, realized lamports, fees, pause flags, and computes initial/maintenance margin, withdrawable collateral, and required reserve. It does not infer fills, authenticate an oracle, or replace the gate's on-chain invariant checker.

If a realized loss or taker fee exceeds a trader's collateral, only the collectible lamports move to the fund; settlement never rejects a fill for that reason. A counterparty payout is credited in full and draws on the fund; any unpaid part becomes uncovered bad debt and pauses trading and withdrawals. Every inflow (top-up, collected loss, fee) repays debt first. This keeps the modeled vault liability tied to actual lamport movements.

Exposure limits and recovery follow the reserve and insurance contract. `open_interest()` derives the long and short side from positions, and `reserve_requirement()` is 0.4 times the larger side. `check_post(account, signed_lots, reduce_only, resting_lots)` raises for an exposure-adding order that breaks the 10 SOL portfolio exposure limit, the 50 SOL per-side market exposure limit, the risk-off rule (fund at least 0.4 times larger side plus the order) or a trading pause; reduce-only orders always pass. `withdraw_fund(amount)` is limited to the surplus above the reserve and is blocked while debt is outstanding. `unpause(withdrawals, trading)` requires debt 0 and the reserve met, and trading cannot be unpaused while withdrawals stay paused.

The issue #8 stress vectors quote SOL to six decimal places. Exact protocol-favoring integer conversion yields **−757,575 lamports** for $110 then $120 and **+757,577 lamports** for the reverse; each rounds to the quoted **∓0.000758 SOL** at that display precision. The zero-fee exhaustion vector yields 4,090,909 lamports of uncovered debt and then 4,242,425 lamports in the fund after recovery. The self-tests assert the exact lamports, while the issue's decimal figures are presentation values.

`takeover(account, liquidator, conversion_price)` models issue #24 atomically: reject nonnegative maintenance health, cancel the victim's `reservations`, transfer `max(1, remaining_lots // 4)` until healthy or flat, and check the liquidator's initial margin (including its remaining reservations) after every step. It returns the lot quantities closed in each step. `liquidate(...)` remains the low-level single-step accounting primitive. Both trade at the supplied validated conversion price and preserve the vault liability while guaranteeing the liquidator's 1% penalty; uncovered payouts pause trading and withdrawals. `takeover_scenario.py` accepts a JSON scenario on stdin and prints independent expectations for the runtime tests.

Run the CI self-tests locally with:

```sh
python3 -m unittest discover -s tools/gate -p 'test_*.py'
```

## Gate report (`report.js`)

`GATE_ROWS` holds all 35 P0 and 4 P1 acceptance-gate rows with the one required evidence tier per row from the issue #11 resolution (D devnet, D (browser), D′ throwaway devnet market, L local runtime on identical bytecode, M manual). `buildReport({commit, cluster, programs, rows})` renders the pinned Markdown run record: source commit, cluster, and each program ID with its `.so` SHA-256. Rows not supplied read `not run`; a `pass` supplied at any tier other than the row's required tier throws — there is no tier substitution. The checked-in template is [docs/acceptance/TEMPLATE.md](../../docs/acceptance/TEMPLATE.md).

```sh
node tools/gate/report.js --manifest candidate.json --cluster devnet --rows rows.json --output docs/acceptance/<date>-<commit>.md
node --test tools/gate/report.test.js
```

Rows JSON is an array of `{id, status, tier, batchIds?, signatures?, notes?}` (status `pass`, `fail`, or `not run`).

## Latency recorder (`latency.js`)

`LatencyRecorder` takes explicit millisecond timestamps (`sign(id, at, {coldStart})`, `accept(id, at)`, `settle(id, at)`; `at` defaults to `Date.now()`). `exclude(id, reason)` removes a declared-unhealthy sample from every count and percentile. `summary()` reports nearest-rank percentiles (sort ascending, take rank `ceil(p/100 * n)` — an observed sample, never an average) and a verdict that passes only with at least 30 included orders spanning at least 30 minutes (first sign to last settle) including a cold start, accepted p95 at most 5000 ms, settled p50 at most 20000 ms, and settled max at most 60000 ms; any signed-but-unsettled order fails the verdict. The exported constants `MIN_ORDERS`, `MIN_SPAN_MS`, `ACCEPTED_P95_MAX_MS`, `SETTLED_P50_MAX_MS`, and `SETTLED_MAX_MS` pin those thresholds.

```sh
node --test tools/gate/latency.test.js
```

## Soak driver (`soak.js`)

`runSoak({durationMs, pollMs, stuckClearedMs, now, sleep, observe, audit})` polls `observe()` (returning `{currentBatchId, batches: [{id, status}]}` with status `cleared`, `settled`, or other) for the duration — 2 h and a 120000 ms stuck-Cleared budget by default — then runs `audit()` exactly once, even when polling failed. It fails on a batch id skipped between polls (missing batch), a batch held in Cleared past the budget, any observe error, or any audit violation, and returns `{pass, failures, batchesSeen, polls, auditViolations}`. Tests inject a fake clock so they run without real waiting; `observeDeployment` wires observation to `readProtocolState` and the CLI wires the final audit to `auditDeployment`.

```sh
node tools/gate/soak.js --rpc https://api.devnet.solana.com --deployment deployments/devnet.json
node --test tools/gate/soak.test.js
node --test tools/gate/gate.test.js   # harness proof; requires MGK_CANDIDATE_MANIFEST
```

The soak CLI prints the JSON verdict and exits 0 on pass, 1 on fail, and 2 on usage or RPC errors.
