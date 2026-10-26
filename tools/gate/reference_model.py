"""Independent integer/Fraction ledger for the restricted SOL perpetuals demo.

Inputs are observed signed fills (lots of 0.001 SOL), micro-USD prices and
validated conversion prices. This module deliberately imports no program or SDK
code. One event is applied at a time in observed settlement order.
"""
from copy import deepcopy
from dataclasses import dataclass, field
from fractions import Fraction

LAMPORTS_PER_SOL = 1_000_000_000
LOTS_PER_SOL = 1_000
TAKER_FEE_BPS = 5
BPS = 10_000


def _ceil(value: Fraction) -> int:
    return -(-value.numerator // value.denominator)


def _credit(value: Fraction) -> int:
    return value.numerator // value.denominator


def _lamports(micro_usd: Fraction, conversion_price: int) -> Fraction:
    if conversion_price <= 0:
        raise ValueError("conversion price must be positive")
    return micro_usd * LAMPORTS_PER_SOL / conversion_price


@dataclass(frozen=True)
class Position:
    quantity_lots: int
    entry_price: Fraction


@dataclass(frozen=True)
class Fill:
    account: str
    quantity_lots: int
    fill_price: int
    conversion_price: int
    maker: bool = False


@dataclass
class Ledger:
    fund_lamports: int
    collateral: dict[str, int] = field(default_factory=dict)
    positions: dict[str, Position] = field(default_factory=dict)
    uncovered_bad_debt: int = 0
    trading_paused: bool = False
    withdrawals_paused: bool = False
    realized_micro_usd: dict[str, Fraction] = field(default_factory=dict)
    realized_lamports: dict[str, int] = field(default_factory=dict)
    fees_lamports: dict[str, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.fund_lamports < 0 or self.uncovered_bad_debt < 0 or any(v < 0 for v in self.collateral.values()):
            raise ValueError("negative initial balance")

    def _inflow(self, amount: int) -> None:
        repayment = min(amount, self.uncovered_bad_debt)
        self.uncovered_bad_debt -= repayment
        self.fund_lamports += amount - repayment

    def _outflow(self, amount: int) -> None:
        paid = min(amount, self.fund_lamports)
        self.fund_lamports -= paid
        self.uncovered_bad_debt += amount - paid
        if self.uncovered_bad_debt:
            self.trading_paused = True
            self.withdrawals_paused = True

    def _realize(self, account: str, usd: Fraction, price: int) -> None:
        self.realized_micro_usd[account] = self.realized_micro_usd.get(account, Fraction(0)) + usd
        if usd >= 0:
            amount = _credit(_lamports(usd, price))
            self.collateral[account] = self.collateral.get(account, 0) + amount
            self.realized_lamports[account] = self.realized_lamports.get(account, 0) + amount
            self._outflow(amount)
        else:
            amount = _ceil(_lamports(-usd, price))
            available = self.collateral.get(account, 0)
            collected = min(amount, available)
            self.collateral[account] = available - collected
            self.realized_lamports[account] = self.realized_lamports.get(account, 0) - collected
            self._inflow(collected)
            # The unpaid portion moves no lamports. The fund takes the loss
            # when a counterparty payout is credited, not a second time here.

    def apply_fill(self, fill: Fill) -> None:
        # A rejected event must have the same all-or-nothing effect as a
        # transaction. Work on a copy and publish only after every check passes.
        next_state = deepcopy(self)
        next_state._apply_fill(fill)
        self.__dict__.update(next_state.__dict__)

    def _apply_fill(self, fill: Fill) -> None:
        if not fill.account or fill.quantity_lots == 0 or fill.fill_price <= 0 or fill.conversion_price <= 0:
            raise ValueError("invalid fill")
        old = self.positions.get(fill.account)
        qty = fill.quantity_lots
        realized = Fraction(0)
        if old is None:
            self.positions[fill.account] = Position(qty, Fraction(fill.fill_price))
        elif old.quantity_lots * qty > 0:
            total = abs(old.quantity_lots) + abs(qty)
            entry = (abs(old.quantity_lots) * old.entry_price + abs(qty) * fill.fill_price) / total
            self.positions[fill.account] = Position(old.quantity_lots + qty, entry)
        else:
            closed = min(abs(old.quantity_lots), abs(qty))
            sign = 1 if old.quantity_lots > 0 else -1
            realized = Fraction(closed * sign, LOTS_PER_SOL) * (fill.fill_price - old.entry_price)
            remaining = old.quantity_lots + qty
            if remaining == 0:
                del self.positions[fill.account]
            elif remaining * old.quantity_lots > 0:
                self.positions[fill.account] = Position(remaining, old.entry_price)
            else:
                self.positions[fill.account] = Position(remaining, Fraction(fill.fill_price))
        if realized:
            self._realize(fill.account, realized, fill.conversion_price)
        if not fill.maker:
            notional = Fraction(abs(qty) * fill.fill_price, LOTS_PER_SOL)
            fee = _ceil(_lamports(notional * TAKER_FEE_BPS / BPS, fill.conversion_price))
            self._charge_fee(fill.account, fee)

    def _charge_fee(self, account: str, fee: int) -> None:
        available = self.collateral.get(account, 0)
        if fee > available:
            raise ValueError("insufficient collateral for fee")
        self.collateral[account] = available - fee
        self.fees_lamports[account] = self.fees_lamports.get(account, 0) + fee
        self._inflow(fee)

    def liquidate(self, account: str, liquidator: str, quantity_lots: int, conversion_price: int) -> None:
        next_state = deepcopy(self)
        next_state._liquidate(account, liquidator, quantity_lots, conversion_price)
        self.__dict__.update(next_state.__dict__)

    def _liquidate(self, account: str, liquidator: str, quantity_lots: int, conversion_price: int) -> None:
        if not account or not liquidator or account == liquidator or quantity_lots <= 0 or conversion_price <= 0:
            raise ValueError("invalid liquidation")
        old = self.positions[account]
        if quantity_lots > abs(old.quantity_lots):
            raise ValueError("liquidation exceeds position")
        direction = 1 if old.quantity_lots > 0 else -1
        # Both sides transact at the oracle price; the takeover cannot create
        # or destroy base exposure.
        self._apply_fill(Fill(account, -direction * quantity_lots, conversion_price, conversion_price, True))
        self._apply_fill(Fill(liquidator, direction * quantity_lots, conversion_price, conversion_price, True))
        notional = Fraction(quantity_lots * conversion_price, LOTS_PER_SOL)
        penalty = _ceil(_lamports(notional / 100, conversion_price))
        available = self.collateral.get(account, 0)
        paid = min(available, penalty * 2)
        self.collateral[account] = available - paid
        self.collateral[liquidator] = self.collateral.get(liquidator, 0) + penalty
        # Collected collateral repays any debt first. The fund covers the
        # liquidator's guaranteed 1%; an uncovered remainder becomes debt.
        # The fund's own 1% share is credited only when actually collected.
        self._inflow(paid)
        self._outflow(penalty)

    def top_up(self, amount: int) -> None:
        if amount <= 0:
            raise ValueError("top-up must be positive")
        self._inflow(amount)

    def initial_margin(self, account: str, conversion_price: int) -> int:
        position = self.positions.get(account)
        if position is None:
            return 0
        return _ceil(_lamports(Fraction(abs(position.quantity_lots) * conversion_price, LOTS_PER_SOL * 5), conversion_price))

    def maintenance_margin(self, account: str, conversion_price: int) -> int:
        position = self.positions.get(account)
        if position is None:
            return 0
        return _ceil(_lamports(Fraction(abs(position.quantity_lots) * conversion_price, LOTS_PER_SOL * 10), conversion_price))

    def withdrawable(self, account: str, conversion_price: int, reservations: int = 0) -> int:
        if reservations < 0 or conversion_price <= 0:
            raise ValueError("invalid risk inputs")
        position = self.positions.get(account)
        loss = 0
        if position is not None:
            unrealized = Fraction(position.quantity_lots, LOTS_PER_SOL) * (conversion_price - position.entry_price)
            if unrealized < 0:
                loss = _ceil(_lamports(-unrealized, conversion_price))
        return max(0, self.collateral.get(account, 0) - loss - self.initial_margin(account, conversion_price) - reservations)

    @staticmethod
    def required_reserve(larger_side_open_interest_lots: int) -> int:
        if larger_side_open_interest_lots < 0:
            raise ValueError("negative open interest")
        return _ceil(Fraction(larger_side_open_interest_lots * LAMPORTS_PER_SOL * 2, LOTS_PER_SOL * 5))

    def withdraw(self, account: str, amount: int, conversion_price: int | None = None,
                 reservations: int = 0) -> int:
        if account in self.positions and (conversion_price is None or conversion_price <= 0):
            raise ValueError("valid conversion price required for non-flat withdrawal")
        available = (self.withdrawable(account, conversion_price, reservations)
                     if conversion_price is not None else self.collateral.get(account, 0) - reservations)
        if self.withdrawals_paused or reservations < 0 or amount < 0 or amount > available:
            raise ValueError("withdrawal blocked")
        self.collateral[account] -= amount
        return amount

    def vault_liability_lamports(self) -> int:
        """Expected vault lamports above rent after every modeled cashflow."""
        return sum(self.collateral.values()) + self.fund_lamports - self.uncovered_bad_debt
