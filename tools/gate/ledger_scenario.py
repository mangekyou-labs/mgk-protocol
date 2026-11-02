"""JSON stdin/stdout adapter for independent ledger runtime expectations.

Feeds observed signed events (fills, deposits, withdrawals, fund moves) to
the issue #14 Fraction ledger in on-chain order and prints the expected
lamport state. Mirrors the event bridge the smoke suite uses against
`reference_model.Ledger`; kept separate so several harness suites share one
adapter instead of copying the bridge.
"""
import json
import sys
from fractions import Fraction

from reference_model import Ledger, Fill


def run(request):
    ledger = Ledger(int(request["fund"]),
                    {account: int(value) for account, value in request["collateral"].items()})
    usd_totals = {}
    for event in request["events"]:
        kind = event.get("kind", "fill")
        if kind == "top_up":
            ledger.top_up(int(event["amount"]))
            continue
        if kind == "donate":
            ledger.donate(int(event["amount"]))
            continue
        if kind == "deposit":
            ledger.collateral[event["account"]] = ledger.collateral.get(event["account"], 0) + int(event["amount"])
            continue
        if kind == "withdraw_fund":
            ledger.withdraw_fund(int(event["amount"]))
            continue
        if kind == "withdraw":
            ledger.withdraw(event["account"], int(event["amount"]), int(event["conversion_price"]))
            continue
        if kind == "unpause":
            ledger.unpause(event["withdrawals"], event["trading"])
            continue
        account = event["account"]
        before = ledger.realized_micro_usd.get(account, Fraction(0))
        ledger.apply_fill(Fill(account, int(event["quantity_lots"]), int(event["fill_price"]),
                               int(event["conversion_price"]), bool(event["maker"])))
        delta = ledger.realized_micro_usd.get(account, Fraction(0)) - before
        # The i128 display counter quantizes each event toward the protocol;
        # conversion above stays exact.
        usd_totals[account] = usd_totals.get(account, 0) + delta.numerator // delta.denominator
    positions = {
        account: {"qty": str(p.quantity_lots),
                  "entry_numerator": str(p.entry_price.numerator),
                  "entry_denominator": str(p.entry_price.denominator)}
        for account, p in ledger.positions.items()
    }
    return {
        "collateral": {a: str(v) for a, v in ledger.collateral.items()},
        "fund": str(ledger.fund_lamports),
        "debt": str(ledger.uncovered_bad_debt),
        "reserve": str(ledger.reserve_requirement()),
        "open_interest": [str(side) for side in ledger.open_interest()],
        "flags": int(ledger.trading_paused) | (2 if ledger.withdrawals_paused else 0),
        "liability": str(ledger.vault_liability_lamports()),
        "above_rent": str(ledger.vault_lamports_above_rent()),
        "positions": positions,
        "realized_usd": {a: str(v) for a, v in usd_totals.items()},
        "realized_lamports": {a: str(v) for a, v in ledger.realized_lamports.items()},
        "fees": {a: str(v) for a, v in ledger.fees_lamports.items()},
    }


if __name__ == "__main__":
    print(json.dumps(run(json.load(sys.stdin))))
