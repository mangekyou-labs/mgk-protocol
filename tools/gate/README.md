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

`collateral` holds expected lamports for each trader. `fund_lamports` and `uncovered_bad_debt` complete the vault liability equation. The model also tracks positions, realized micro-USD, realized lamports, fees, pause flags, and computes initial/maintenance margin, withdrawable collateral, and required reserve. It does not infer fills, authenticate an oracle, or replace the gate's on-chain invariant checker.

The issue #8 stress vectors quote SOL to six decimal places. Exact protocol-favoring integer conversion yields **−757,575 lamports** for $110 then $120 and **+757,577 lamports** for the reverse; each rounds to the quoted **∓0.000758 SOL** at that display precision. The zero-fee exhaustion vector yields 4,090,909 lamports of uncovered debt and then 4,242,425 lamports in the fund after recovery. The self-tests assert the exact lamports, while the issue's decimal figures are presentation values.

Run the CI self-tests locally with:

```sh
python3 -m unittest discover -s tools/gate -p 'test_*.py'
```
