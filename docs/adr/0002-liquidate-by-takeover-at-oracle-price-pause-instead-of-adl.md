# Liquidate by takeover at the oracle price; pause instead of ADL when insurance is exhausted

A portfolio whose equity (unrealized losses fully counted, unrealized gains counted only for this test) falls below maintenance margin at the validated oracle price can be liquidated by anyone. The liquidator's portfolio takes over the position at the conversion price in 25% steps until health is non-negative, and must itself meet initial margin afterwards. The liquidated portfolio pays 1% of closed notional to the liquidator and 1% to the insurance fund, and its resting orders are cancelled first. Negative equity left behind is absorbed by the insurance fund. If the fund cannot cover it, the market pauses trading and withdrawals. There is no auto-deleveraging (ADL) or socialized loss in the demo. When the oracle price is invalid, liquidation is blocked, just as settlement is (ADR 0001).

## Considered Options

- **Synthetic close at mark with no counterparty (the code on master).** Rejected: the position disappears from one side only, so the protocol silently holds unbalanced exposure. Worse, the mark is the manipulable DFBA mid and the fallback oracle read is unvalidated.
- **Force a reduce-only order into the next auction.** Rejected: liquidation is then delayed by a batch and depends on resting liquidity at exactly the moment it is thinnest.
- **ADL or socialized loss when insurance is exhausted.** Deferred: real machinery that the demo lifecycle does not need. Pausing is honest and recoverable on devnet, and is listed as a restricted-demo omission.

## Consequences

Liquidation liveness depends on a funded liquidator existing (expected to be the protocol's backstop maker) and on the oracle worker. Longs and shorts stay balanced at all times. An exhausted insurance fund halts the market rather than mispaying winners.
