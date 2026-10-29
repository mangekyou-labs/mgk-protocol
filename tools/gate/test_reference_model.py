import unittest
from fractions import Fraction

from reference_model import Fill, Ledger, Position


class ReferenceModelTests(unittest.TestCase):
    def test_entry_grid_known_long_and_short_vectors(self):
        scale = 10**12
        for direction, remainder, payout in [(1, 500_249_875_063, 20_009_989), (-1, 500_249_875_062, -20_009_990)]:
            ledger = Ledger(20_000_000_000, {"A": 1_000_000_000})
            ledger.apply_fill(Fill("A", direction * 1000, 100_000_000, 100_000_000, True))
            ledger.apply_fill(Fill("A", direction * 1001, 100_000_001, 100_000_000, True))
            self.assertEqual(ledger.positions["A"].entry_price, Fraction(100_000_000 * scale + remainder, scale))
            ledger.apply_fill(Fill("A", -direction * 2001, 101_000_000, 100_000_000, True))
            self.assertEqual(ledger.realized_lamports["A"], payout)

    def test_repeated_grows_round_toward_protocol_on_fixed_grid(self):
        scale = 10**12
        for direction in (1, -1):
            ledger = Ledger(20_000_000_000, {"A": 1_000_000_000})
            ledger.apply_fill(Fill("A", direction, 100_000_000, 100_000_000, True))
            for cycle in range(1024):
                price = 100_000_001 + cycle % 2
                weighted = (ledger.positions["A"].entry_price + price) / 2
                ledger.apply_fill(Fill("A", direction, price, 100_000_000, True))
                stored = ledger.positions["A"].entry_price
                self.assertEqual((stored * scale).denominator, 1)
                error = (stored - weighted) * direction
                self.assertGreaterEqual(error, 0)
                self.assertLess(error, Fraction(1, scale))
                ledger.apply_fill(Fill("A", -direction, price, 100_000_000, True))
                self.assertEqual(ledger.positions["A"].entry_price, stored)
            ledger.apply_fill(Fill("A", -direction, 100_000_000, 100_000_000, True))
            self.assertNotIn("A", ledger.positions)

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

    def test_taker_fee_is_capped_at_available_collateral_and_never_rejects_the_fill(self):
        ledger = Ledger(fund_lamports=1_000_000, collateral={"A": 20_000})
        ledger.apply_fill(Fill("A", 100, 100_000_000, 100_000_000, False))
        self.assertEqual(ledger.positions["A"].quantity_lots, 100)
        self.assertEqual(ledger.collateral["A"], 0)
        self.assertEqual(ledger.fees_lamports["A"], 20_000)
        self.assertEqual(ledger.fund_lamports, 1_020_000)
        self.assertEqual(ledger.vault_liability_lamports(), 1_020_000)

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


def _balanced_book(fund, per_side_accounts=2, lots=10_000):
    """Longs L0.. and shorts S0.. each holding `lots`, opened with maker fills."""
    collateral = {}
    for i in range(per_side_accounts):
        collateral[f"L{i}"] = 10_000_000_000
        collateral[f"S{i}"] = 10_000_000_000
    ledger = Ledger(fund_lamports=fund, collateral=collateral)
    for i in range(per_side_accounts):
        ledger.apply_fill(Fill(f"L{i}", lots, 100_000_000, 100_000_000, True))
        ledger.apply_fill(Fill(f"S{i}", -lots, 100_000_000, 100_000_000, True))
    return ledger


def _exhausted_ledger():
    ledger = Ledger(fund_lamports=5_000_000, collateral={"A": 0, "B": 100_000_000})
    ledger.apply_fill(Fill("A", 100, 100_000_000, 110_000_000, True))
    ledger.apply_fill(Fill("B", -100, 100_000_000, 110_000_000, True))
    ledger.apply_fill(Fill("A", -100, 110_000_000, 110_000_000, True))
    return ledger


class InsuranceFundLimitTests(unittest.TestCase):
    def test_open_interest_is_tracked_per_side_from_positions(self):
        ledger = _balanced_book(fund=0, per_side_accounts=2, lots=300)
        self.assertEqual(ledger.open_interest(), (600, 600))
        ledger.apply_fill(Fill("L0", -100, 100_000_000, 100_000_000, True))
        self.assertEqual(ledger.open_interest(), (500, 600))
        self.assertEqual(ledger.reserve_requirement(), Ledger.required_reserve(600))

    def test_position_cap_is_ten_sol_per_portfolio(self):
        ledger = Ledger(fund_lamports=1_000_000_000_000, collateral={"A": 10_000_000_000})
        ledger.check_post("A", 10_000)
        ledger.check_post("A", -10_000)
        with self.assertRaises(ValueError):
            ledger.check_post("A", 10_001)
        ledger.apply_fill(Fill("A", 9_000, 100_000_000, 100_000_000, True))
        ledger.check_post("A", 1_000)
        with self.assertRaises(ValueError):
            ledger.check_post("A", 1_001)
        # Same-side resting orders count toward the worst case.
        with self.assertRaises(ValueError):
            ledger.check_post("A", 600, resting_lots=401)
        ledger.check_post("A", 600, resting_lots=400)
        # Reducing is never an exposure add.
        ledger.check_post("A", -9_000, reduce_only=True)

    def test_open_interest_cap_is_fifty_sol_per_side(self):
        ledger = _balanced_book(fund=1_000_000_000_000, per_side_accounts=4, lots=10_000)
        self.assertEqual(ledger.open_interest(), (40_000, 40_000))
        ledger.apply_fill(Fill("L4", 9_999, 100_000_000, 100_000_000, True))
        ledger.apply_fill(Fill("S4", -9_999, 100_000_000, 100_000_000, True))
        ledger.check_post("M", 1)
        with self.assertRaises(ValueError):
            ledger.check_post("M", 2)
        with self.assertRaises(ValueError):
            ledger.check_post("M", -2)
        ledger.check_post("M", 2, reduce_only=True)

    def test_risk_off_requires_fund_for_larger_side_plus_order(self):
        ledger = _balanced_book(fund=10_000_000_000, per_side_accounts=2, lots=10_000)
        self.assertEqual(ledger.reserve_requirement(), 8_000_000_000)
        ledger.check_post("M", 5_000)
        with self.assertRaises(ValueError):
            ledger.check_post("M", 5_001)
        with self.assertRaises(ValueError):
            ledger.check_post("M", -5_001)
        # Closing orders keep working while the fund is short of the reserve.
        thin = _balanced_book(fund=1, per_side_accounts=2, lots=10_000)
        with self.assertRaises(ValueError):
            thin.check_post("M", 1)
        thin.check_post("L0", -10_000, reduce_only=True)

    def test_paused_trading_rejects_only_exposure_adding_orders(self):
        ledger = _exhausted_ledger()
        with self.assertRaises(ValueError):
            ledger.check_post("B", -1)
        ledger.check_post("B", 100, reduce_only=True)

    def test_fund_withdrawal_is_limited_to_surplus_above_required_reserve(self):
        ledger = _balanced_book(fund=10_000_000_000, per_side_accounts=2, lots=10_000)
        before = ledger.vault_liability_lamports()
        with self.assertRaises(ValueError):
            ledger.withdraw_fund(2_000_000_001)
        with self.assertRaises(ValueError):
            ledger.withdraw_fund(0)
        self.assertEqual(ledger.fund_lamports, 10_000_000_000)
        self.assertEqual(ledger.withdraw_fund(2_000_000_000), 2_000_000_000)
        self.assertEqual(ledger.fund_lamports, 8_000_000_000)
        self.assertEqual(ledger.vault_liability_lamports(), before - 2_000_000_000)
        with self.assertRaises(ValueError):
            ledger.withdraw_fund(1)

    def test_donations_are_surplus_above_the_backing_and_never_reach_the_ledger(self):
        ledger = Ledger(1_000_000, {"a": 5_000})
        backing = ledger.vault_liability_lamports()
        ledger.donate(777)
        self.assertEqual(ledger.vault_liability_lamports(), backing)
        self.assertEqual(ledger.vault_lamports_above_rent(), backing + 777)
        self.assertEqual(ledger.fund_lamports, 1_000_000)
        ledger.top_up(10)
        self.assertEqual(ledger.vault_lamports_above_rent(), backing + 10 + 777)
        with self.assertRaises(ValueError):
            ledger.donate(-1)

    def test_fund_withdrawal_is_blocked_while_debt_is_outstanding(self):
        ledger = _exhausted_ledger()
        with self.assertRaises(ValueError):
            ledger.withdraw_fund(1)

    def test_exhausted_fund_credits_winner_in_full_and_pauses_everything(self):
        ledger = _exhausted_ledger()
        self.assertEqual(ledger.collateral["A"], 9_090_909)
        self.assertEqual((ledger.fund_lamports, ledger.uncovered_bad_debt), (0, 4_090_909))
        self.assertTrue(ledger.trading_paused and ledger.withdrawals_paused)
        self.assertEqual(ledger.vault_liability_lamports(), 9_090_909 + 100_000_000 - 4_090_909)

    def test_unpause_requires_zero_debt_and_met_reserve_with_withdrawals_first(self):
        ledger = _exhausted_ledger()
        with self.assertRaises(ValueError):
            ledger.unpause(withdrawals=True)
        # A top-up that only clears the debt leaves the fund below the reserve.
        ledger.top_up(4_090_909)
        self.assertEqual((ledger.fund_lamports, ledger.uncovered_bad_debt), (0, 0))
        self.assertEqual(ledger.open_interest(), (0, 100))
        self.assertEqual(ledger.reserve_requirement(), 40_000_000)
        with self.assertRaises(ValueError):
            ledger.unpause(withdrawals=True)
        ledger.top_up(40_000_000)
        with self.assertRaises(ValueError):
            ledger.unpause(trading=True)
        self.assertTrue(ledger.trading_paused and ledger.withdrawals_paused)
        ledger.unpause(withdrawals=True)
        self.assertFalse(ledger.withdrawals_paused)
        self.assertTrue(ledger.trading_paused)
        ledger.unpause(trading=True)
        self.assertFalse(ledger.trading_paused)

    def test_unpause_can_clear_both_flags_in_one_call(self):
        ledger = _exhausted_ledger()
        ledger.apply_fill(Fill("B", 100, 110_000_000, 120_000_000, True))
        ledger.top_up(1)
        ledger.unpause(withdrawals=True, trading=True)
        self.assertFalse(ledger.trading_paused or ledger.withdrawals_paused)

    def test_top_up_repays_debt_before_the_fund(self):
        ledger = _exhausted_ledger()
        ledger.top_up(1_000_000)
        self.assertEqual((ledger.fund_lamports, ledger.uncovered_bad_debt), (0, 3_090_909))
        ledger.top_up(4_000_000)
        self.assertEqual((ledger.fund_lamports, ledger.uncovered_bad_debt), (909_091, 0))

    def test_winner_withdraws_profit_while_loser_position_stays_open(self):
        ledger = Ledger(fund_lamports=20_000_000_000, collateral={"A": 0, "B": 100_000_000})
        ledger.apply_fill(Fill("A", 100, 100_000_000, 110_000_000, True))
        ledger.apply_fill(Fill("B", -100, 100_000_000, 110_000_000, True))
        ledger.apply_fill(Fill("A", -100, 110_000_000, 110_000_000, True))
        before = ledger.vault_liability_lamports()
        self.assertEqual(ledger.withdraw("A", 9_090_909), 9_090_909)
        self.assertEqual(ledger.vault_liability_lamports(), before - 9_090_909)
        self.assertEqual(ledger.open_interest(), (0, 100))


if __name__ == "__main__":
    unittest.main()
