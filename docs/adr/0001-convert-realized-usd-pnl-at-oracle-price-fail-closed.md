# Convert realized USD PnL to SOL at the oracle price during settlement, failing closed

Perps pay a linear USD payoff but hold only SOL collateral, so every realized USD amount (PnL, fees, funding) must become lamports at some price. We convert at settlement using the bound fallback oracle's SOL/USD price — not the batch clearing price, which a trader in that auction can move by self-trading — and require it to be valid (active, positive, not future-dated, at most 60 s old, confidence within 1% of price). If it is not valid, settlement reverts and the batch stays cleared-but-unsettled until the keeper retries with a valid price.

## Considered Options

- **Settle positions now, hold realized PnL as a USD IOU and convert later.** Rejected: introduces a second liability type the demo must track, display and reserve against, and breaks the guarantee that a settled position's collateral is already final.
- **Convert at the clearing price.** Rejected: self-referential and manipulable within the auction being settled.

## Consequences

Settlement liveness now depends on the oracle worker; a missing or stale oracle halts settlement rather than mispaying. Conversion rounds in the protocol's favour (credits down, debits up).
