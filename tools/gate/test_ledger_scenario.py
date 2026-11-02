import json
import subprocess
import sys
import unittest
from pathlib import Path

ADAPTER = Path(__file__).with_name("ledger_scenario.py")


def run(request):
    proc = subprocess.run(
        [sys.executable, str(ADAPTER)],
        input=json.dumps(request),
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout)


class LedgerScenarioTests(unittest.TestCase):
    def test_stress_vectors_reproduce_exact_conversion_drift(self):
        # Issue #8 vectors through the adapter: all-maker fills, so the fund
        # delta is the pure conversion drift quoted in the README.
        for first, second, expected in ((110_000_000, 120_000_000, -757_575),
                                        (120_000_000, 110_000_000, 757_577)):
            events = [
                {"account": "A", "quantity_lots": "100", "fill_price": "100000000",
                 "conversion_price": str(first), "maker": True},
                {"account": "B", "quantity_lots": "-100", "fill_price": "100000000",
                 "conversion_price": str(first), "maker": True},
                {"account": "A", "quantity_lots": "-100", "fill_price": "110000000",
                 "conversion_price": str(first), "maker": True},
                {"account": "C", "quantity_lots": "100", "fill_price": "110000000",
                 "conversion_price": str(first), "maker": True},
                {"account": "B", "quantity_lots": "100", "fill_price": "110000000",
                 "conversion_price": str(second), "maker": True},
                {"account": "C", "quantity_lots": "-100", "fill_price": "110000000",
                 "conversion_price": str(second), "maker": True},
            ]
            out = run({"fund": "20000000000",
                       "collateral": {"A": "0", "B": "100000000"},
                       "events": events})
            self.assertEqual(int(out["fund"]) - 20_000_000_000, expected)
            self.assertEqual(out["positions"], {})

    def test_within_fund_bad_debt_is_absorbed_without_debt_or_pause(self):
        events = [
            {"kind": "fill", "account": "V", "quantity_lots": "1000",
             "fill_price": "100000000", "conversion_price": "100000000", "maker": True},
            {"kind": "fill", "account": "W", "quantity_lots": "-1000",
             "fill_price": "100000000", "conversion_price": "100000000", "maker": False},
            {"kind": "withdraw", "account": "V", "amount": "800000000",
             "conversion_price": "100000000"},
            {"kind": "fill", "account": "V", "quantity_lots": "-1000",
             "fill_price": "20000000", "conversion_price": "20000000", "maker": True},
            {"kind": "fill", "account": "W", "quantity_lots": "1000",
             "fill_price": "20000000", "conversion_price": "20000000", "maker": False},
        ]
        out = run({"fund": "20000000000",
                   "collateral": {"V": "1000000000", "W": "1000000000"},
                   "events": events})
        self.assertEqual(out["debt"], "0")
        self.assertEqual(out["flags"], 0)
        self.assertEqual(out["collateral"]["V"], "0")
        self.assertEqual(out["fund"], "16201000000")


if __name__ == "__main__":
    unittest.main()
