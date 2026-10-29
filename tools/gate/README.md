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

If a realized loss or taker fee exceeds a trader's collateral, only the collectible lamports move to the fund; settlement never rejects a fill for that reason. A counterparty payout is credited in full and draws on the fund; any shortfall becomes uncovered debt and pauses trading and withdrawals. Every inflow (top-up, collected loss, fee) repays debt first. This keeps the modeled vault liability tied to actual lamport movements.

Exposure limits and recovery follow the reserve and insurance contract. `open_interest()` derives the long and short side from positions, and `reserve_requirement()` is 0.4 times the larger side. `check_post(account, signed_lots, reduce_only, resting_lots)` raises for an exposure-adding order that breaks the 10 SOL portfolio exposure limit, the 50 SOL per-side market exposure limit, the risk-off rule (fund at least 0.4 times larger side plus the order) or a trading pause; reduce-only orders always pass. `withdraw_fund(amount)` is limited to the surplus above the reserve and is blocked while debt is outstanding. `unpause(withdrawals, trading)` requires debt 0 and the reserve met, and trading cannot be unpaused while withdrawals stay paused.

The issue #8 stress vectors quote SOL to six decimal places. Exact protocol-favoring integer conversion yields **−757,575 lamports** for $110 then $120 and **+757,577 lamports** for the reverse; each rounds to the quoted **∓0.000758 SOL** at that display precision. The zero-fee exhaustion vector yields 4,090,909 lamports of uncovered debt and then 4,242,425 lamports in the fund after recovery. The self-tests assert the exact lamports, while the issue's decimal figures are presentation values.

Run the CI self-tests locally with:

```sh
python3 -m unittest discover -s tools/gate -p 'test_*.py'
```
