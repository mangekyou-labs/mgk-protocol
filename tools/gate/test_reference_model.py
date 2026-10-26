import unittest
from fractions import Fraction

from reference_model import Fill, Ledger, Position


class ReferenceModelTests(unittest.TestCase):
    def test_grow_reduce_flip_close_and_taker_fees(self):
        ledger = Ledger(fund_lamports=20_000_000_000, collateral={"A": 1_000_000_000})
        ledger.apply_fill(Fill("A", 100, 100_000_000, 100_000_000, False))
        self.assertEqual(ledger.positions["A"], Position(100, Fraction(100_000_000)))
        self.assertEqual(ledger.collateral["A"], 999_950_000)
        ledger.apply_fill(Fill("A", 100, 120_000_000, 120_000_000, True))
        self.assertEqual(ledger.positions["A"], Position(200, Fraction(110_000_000)))
        ledger.apply_fill(Fill("A", -50, 130_000_000, 130_000_000, True))
        self.assertEqual(ledger.positions["A"], Position(150, Fraction(110_000_000)))
        ledger.apply_fill(Fill("A", -200, 140_000_000, 140_000_000, True))
        self.assertEqual(ledger.positions["A"], Position(-50, Fraction(140_000_000)))
        ledger.apply_fill(Fill("A", 50, 140_000_000, 140_000_000, True))
        self.assertNotIn("A", ledger.positions)

    def test_stress_one_and_two_conversion_drift_exact_lamports(self):
        for first, second, expected in ((110_000_000, 120_000_000, -757_575),
                                        (120_000_000, 110_000_000, 757_577)):
            ledger = Ledger(fund_lamports=20_000_000_000, collateral={"A": 0, "B": 100_000_000})
            ledger.apply_fill(Fill("A", 100, 100_000_000, first, True))
            ledger.apply_fill(Fill("B", -100, 100_000_000, first, True))
            ledger.apply_fill(Fill("A", -100, 110_000_000, first, True))
            ledger.apply_fill(Fill("C", 100, 110_000_000, first, True))
            ledger.apply_fill(Fill("B", 100, 110_000_000, second, True))
            ledger.apply_fill(Fill("C", -100, 110_000_000, second, True))
            self.assertEqual(ledger.fund_lamports - 20_000_000_000, expected)
            self.assertEqual(ledger.collateral["A"], 1_000_000_000_000_000 // first)
            self.assertEqual(ledger.collateral.get("C", 0), 0)

    def test_winner_can_withdraw_before_loser_closes(self):
        ledger = Ledger(fund_lamports=20_000_000_000, collateral={"A": 0, "B": 100_000_000})
        ledger.apply_fill(Fill("A", 100, 100_000_000, 110_000_000, True))
        ledger.apply_fill(Fill("B", -100, 100_000_000, 110_000_000, True))
        ledger.apply_fill(Fill("A", -100, 110_000_000, 110_000_000, True))
        self.assertEqual(ledger.collateral["A"], 9_090_909)
        self.assertEqual(ledger.withdraw("A", 9_090_909), 9_090_909)
        self.assertEqual(ledger.collateral["A"], 0)
        self.assertEqual(ledger.positions["B"].quantity_lots, -100)
        with self.assertRaises(ValueError):
            ledger.withdraw("B", 70_909_091, 110_000_000)
        self.assertEqual(ledger.collateral["B"], 100_000_000)

    def test_exhaustion_and_debt_first_recovery(self):
        ledger = Ledger(fund_lamports=5_000_000, collateral={"A": 0, "B": 100_000_000})
        ledger.apply_fill(Fill("A", 100, 100_000_000, 110_000_000, True))
        ledger.apply_fill(Fill("B", -100, 100_000_000, 110_000_000, True))
        ledger.apply_fill(Fill("A", -100, 110_000_000, 110_000_000, True))
        self.assertEqual((ledger.fund_lamports, ledger.uncovered_bad_debt), (0, 4_090_909))
        self.assertTrue(ledger.trading_paused and ledger.withdrawals_paused)
        ledger.apply_fill(Fill("B", 100, 110_000_000, 120_000_000, True))
        self.assertEqual((ledger.fund_lamports, ledger.uncovered_bad_debt), (4_242_425, 0))
        self.assertTrue(ledger.trading_paused)
        ledger.top_up(10_000_000)
        self.assertTrue(ledger.trading_paused)

    def test_margin_reserve_and_withdrawable_exclude_unrealized_gains(self):
        ledger = Ledger(fund_lamports=20_000_000_000, collateral={"A": 1_000_000_000})
        ledger.apply_fill(Fill("A", 1_000, 100_000_000, 100_000_000, True))
        self.assertEqual(ledger.initial_margin("A", 100_000_000), 200_000_000)
        self.assertEqual(ledger.maintenance_margin("A", 120_000_000), 100_000_000)
        self.assertEqual(ledger.withdrawable("A", 120_000_000, reservations=50_000_000), 750_000_000)
        self.assertEqual(ledger.withdrawable("A", 80_000_000, reservations=50_000_000), 500_000_000)
        self.assertEqual(ledger.required_reserve(50_000), 20_000_000_000)

    def test_ceil_fee_and_protocol_favoring_conversion(self):
        ledger = Ledger(fund_lamports=1_000_000_000, collateral={"A": 100_000_000})
        ledger.apply_fill(Fill("A", 1, 101_000_000, 103_000_000, False))
        self.assertEqual(ledger.fees_lamports["A"], 491)
        ledger.apply_fill(Fill("A", -1, 102_000_000, 103_000_000, True))
        self.assertEqual(ledger.realized_lamports["A"], 9_708)

    def test_losing_trader_cannot_withdraw_locked_unrealized_loss(self):
        ledger = Ledger(fund_lamports=20_000_000_000, collateral={"B": 100_000_000})
        ledger.apply_fill(Fill("B", -100, 100_000_000, 110_000_000, True))
        self.assertEqual(ledger.withdrawable("B", 110_000_000), 70_909_090)
        with self.assertRaises(ValueError):
            ledger.withdraw("B", 70_909_091, 110_000_000)
        self.assertEqual(ledger.collateral["B"], 100_000_000)

    def test_fee_rejection_preserves_entire_ledger(self):
        ledger = Ledger(fund_lamports=1_000_000, collateral={"A": 0})
        before = ledger.vault_liability_lamports()
        with self.assertRaises(ValueError):
            ledger.apply_fill(Fill("A", 100, 100_000_000, 100_000_000, False))
        self.assertNotIn("A", ledger.positions)
        self.assertEqual(ledger.fund_lamports, 1_000_000)
        self.assertEqual(ledger.vault_liability_lamports(), before)

    def test_uncollectible_loss_does_not_remove_unmoved_vault_lamports(self):
        ledger = Ledger(fund_lamports=20_000_000, collateral={"A": 1_000_000})
        ledger.apply_fill(Fill("A", 100, 100_000_000, 100_000_000, True))
        before = ledger.vault_liability_lamports()
        ledger.apply_fill(Fill("A", -100, 90_000_000, 90_000_000, True))
        self.assertEqual(ledger.collateral["A"], 0)
        self.assertEqual(ledger.fund_lamports, 21_000_000)
        self.assertEqual(ledger.uncovered_bad_debt, 0)
        self.assertEqual(ledger.vault_liability_lamports(), before)

    def test_invalid_liquidator_leaves_takeover_unapplied(self):
        ledger = Ledger(fund_lamports=20_000_000, collateral={"A": 1_000_000_000})
        ledger.apply_fill(Fill("A", 100, 100_000_000, 100_000_000, True))
        before = (ledger.positions.copy(), ledger.collateral.copy(), ledger.fund_lamports)
        with self.assertRaises(ValueError):
            ledger.liquidate("A", "", 25, 100_000_000)
        self.assertEqual((ledger.positions, ledger.collateral, ledger.fund_lamports), before)

    def test_liquidator_receives_full_penalty_when_trader_is_short(self):
        ledger = Ledger(fund_lamports=100_000, collateral={"A": 100_000, "L": 1_000_000_000})
        ledger.apply_fill(Fill("A", 100, 100_000_000, 100_000_000, True))
        before = ledger.vault_liability_lamports()
        ledger.liquidate("A", "L", 25, 100_000_000)
        self.assertEqual(ledger.collateral["L"], 1_000_250_000)
        self.assertEqual(ledger.fund_lamports, 0)
        self.assertEqual(ledger.uncovered_bad_debt, 50_000)
        self.assertEqual(ledger.vault_liability_lamports(), before)
        self.assertTrue(ledger.trading_paused and ledger.withdrawals_paused)

    def test_liquidation_penalty_goes_to_liquidator_and_fund(self):
        ledger = Ledger(fund_lamports=20_000_000_000, collateral={"A": 1_000_000_000, "L": 1_000_000_000})
        ledger.apply_fill(Fill("A", 100, 100_000_000, 100_000_000, True))
        ledger.liquidate("A", "L", 25, 100_000_000)
        self.assertEqual(ledger.positions["A"].quantity_lots, 75)
        self.assertEqual(ledger.positions["L"].quantity_lots, 25)
        self.assertEqual(ledger.collateral["L"], 1_000_250_000)
        self.assertEqual(ledger.fund_lamports, 20_000_250_000)
        self.assertEqual(ledger.collateral["A"], 999_500_000)


if __name__ == "__main__":
    unittest.main()
