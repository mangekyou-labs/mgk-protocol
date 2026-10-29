"""JSON stdin/stdout adapter for independent takeover runtime expectations."""
import json
import sys
from fractions import Fraction

from reference_model import Ledger, Position


def run(request):
    ledger = Ledger(int(request["fund"]),
                    {account: int(value) for account, value in request["collateral"].items()})
    ledger.positions = {
        account: Position(int(position["qty"]), Fraction(str(position["entry"])))
        for account, position in request["positions"].items()
    }
    ledger.reservations = {account: int(value) for account, value in request.get("reservations", {}).items()}
    before = ledger.vault_liability_lamports()
    steps = ledger.takeover(request["account"], request["liquidator"], int(request["price"]))
    assert ledger.vault_liability_lamports() == before
    return {
        "steps": steps,
        "collateral": {account: str(value) for account, value in ledger.collateral.items()},
        "positions": {account: {"qty": str(position.quantity_lots),
                                "entry_numerator": str(position.entry_price.numerator),
                                "entry_denominator": str(position.entry_price.denominator)}
                      for account, position in ledger.positions.items()},
        "fund": str(ledger.fund_lamports), "debt": str(ledger.uncovered_bad_debt),
        "flags": int(ledger.trading_paused) | (2 if ledger.withdrawals_paused else 0),
        "realized_lamports": {account: str(value) for account, value in ledger.realized_lamports.items()},
        "realized_micro_usd": {account: str(value) for account, value in ledger.realized_micro_usd.items()},
        "fees": {account: str(value) for account, value in ledger.fees_lamports.items()},
        "reservations": {account: str(value) for account, value in ledger.reservations.items()},
        "open_interest": [str(value) for value in ledger.open_interest()],
        "liability": str(ledger.vault_liability_lamports()),
    }


if __name__ == "__main__":
    print(json.dumps(run(json.load(sys.stdin))))
