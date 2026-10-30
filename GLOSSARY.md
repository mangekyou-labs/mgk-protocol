# mgk Perpetual Futures

mgk uses dual flow batch auctions (DFBA) to trade perpetual futures against a persistent resting order book.

## Language

**Settlement**:
The transition that accounts for a cleared batch's fills, portfolio changes, protocol fees, mark and funding, then opens the next batch for collection.
_Avoid_: Matching, clearing (these determine auction results before settlement).

### Order lifecycle

**Signed transaction**:
A transaction the trader's wallet has signed that is not yet confirmed on-chain.
_Avoid_: Submitted order, placed order

**Accepted order**:
An order whose commit, reveal or post is confirmed on-chain and which now exists in a batch or on the resting book.
_Avoid_: Placed order, pending fill

**Fill**:
An accepted order's appearance, with quantity and price, in a cleared batch's results.
_Avoid_: Trade, execution (before settlement)

**Settled position**:
A position after settlement has applied its fills to the portfolio; the only state from which PnL may be shown.
_Avoid_: Open order, filled position

### Accounting

**Collateral**:
SOL held for a portfolio, in lamports; the only asset deposited, withdrawn or paid out.
_Avoid_: Margin balance, cash

**Entry price**:
The quantity-weighted average fill price of a position's current side, in USD per SOL.
_Avoid_: Entry VWAP, cost basis

**Realized PnL**:
USD profit or loss locked in by reducing, closing or flipping a position, converted to collateral at the conversion price.
_Avoid_: Settled PnL, cash PnL

**Unrealized PnL**:
USD profit or loss of a settled position measured against the current mark; never paid out.
_Avoid_: Floating PnL, open PnL

**Conversion price**:
The validated oracle SOL/USD price used to turn USD amounts into collateral at settlement.
_Avoid_: Clearing price, mark price (for this purpose)

### Risk

**Restricted demo**:
A release that trades with deliberately limited leverage, size and order types, and that publicly lists the protections it omits.
_Avoid_: Beta, unrestricted perps

**Initial margin**:
Collateral a portfolio must hold to open or increase exposure; a fixed share of position notional at the conversion price.
_Avoid_: Required margin, IM (in user-facing text)

**Maintenance margin**:
The minimum equity a portfolio must keep for its positions; falling below it makes the portfolio liquidatable.
_Avoid_: Liquidation threshold, MM (in user-facing text)

**Withdrawable collateral**:
Collateral that can leave a portfolio: equity, excluding unrealized gains, minus initial margin and order reservations.
_Avoid_: Free collateral, available balance

**Reduce-only**:
An order flag that limits a fill to the position remaining at the moment of the fill; any excess is cancelled, never opened or flipped.
_Avoid_: Close order

**Liquidation**:
Forced reduction of a portfolio whose equity has fallen below maintenance margin.
_Avoid_: Auto-close, margin call

**Exposure limit**:
A ceiling on position size: the portfolio exposure limit caps one portfolio's position, and the market exposure limit caps the open interest on each side of the market.
_Avoid_: Risk limit, position cap, open-interest cap

**Liquidator**:
A portfolio that takes over part of a liquidated position at the conversion price in exchange for a penalty paid by the liquidated portfolio.
_Avoid_: Keeper (keepers advance batches; liquidators take risk)

**Insurance fund**:
Protocol-owned SOL, actually held in the vault, that is the counterparty to every realized PnL cashflow: it pays winners, collects from losers, receives fees and liquidation penalties, and absorbs bad debt and conversion drift; when it is exhausted the market pauses.
_Avoid_: Treasury, backstop, conversion reserve

**Conversion drift**:
The SOL gained or lost by the insurance fund because offsetting USD PnL was converted to collateral at different conversion prices.
_Avoid_: Rounding, slippage

**Bad debt**:
Negative equity left in a portfolio after its positions are fully closed.
_Avoid_: Deficit

**Uncovered bad debt**:
The part of a winner's payout that the insurance fund could not pay; the winner is credited in full, the unpaid amount is recorded on the vault, and trading and withdrawals pause until top-ups repay it. Distinct from bad debt, which is a loser's negative equity: a loser's unpaid loss is never recorded as uncovered bad debt.
_Avoid_: Shortfall, deficit

### Operations

**Maker order**:
An order designated to supply liquidity; it trades only against taker orders on the opposite side, regardless of when either arrived.
_Avoid_: Resting order, passive order (role is not arrival time)

**Taker order**:
An order designated to consume liquidity; it trades only against maker orders on the opposite side, never against another taker order.
_Avoid_: Market order, aggressive order

**Protocol maker**:
The protocol-run portfolio that quotes maker orders on both sides around the conversion price and acts as the liquidator of last resort.
_Avoid_: Market maker bot, house, backstop (the insurance fund is not a liquidator)

**Keeper**:
A permissionless operator that advances batches by clearing and settling them; it takes no positions.
_Avoid_: Cranker, liquidator

**Demo market**:
One deployment of the programs with its own accounts; replacing a layout means starting a new demo market, never migrating the old one.
_Avoid_: Environment, instance

### Release

**Acceptance gate**:
The fixed list of scenarios, each with a required evidence tier, that must pass before the demo may be called working.
_Avoid_: Test suite, QA checklist

**Evidence tier**:
Where a gate scenario was proved: unit, local runtime (identical bytecode on a local validator) or devnet; a pass at one tier never stands in for another.
_Avoid_: Test level, environment

### Layout freeze

The approved protocol checkpoint whose account and instruction formats stay fixed until the user explicitly approves a change.

### Risk-off admission

An admission rule that requires an order to be reduce-only, including when the order would otherwise close a position.

### Exposure admission limit

A limit checked against current open interest when an order is posted or modified. It does not reserve projected open interest for all resting orders.
