# The insurance fund is the cash-backed counterparty to all realized PnL

Converting each trader's realized USD PnL at its own conversion price (ADR 0001) means offsetting USD gains and losses do not net to zero in SOL, and a winner can close before the losing counterparty. So every realized cashflow goes through the insurance fund: winners are paid from it, losers pay into it, and it also takes fees, liquidation penalties and rounding dust and absorbs bad debt and conversion drift. The fund must hold real lamports in the vault, seeded by an actual transfer, and its balance never goes below zero. New exposure is accepted only while the fund covers 0.4 × the larger side's open interest; below that the market is risk-off, while closes and withdrawals continue. A payout the fund cannot cover is still credited, the unpaid amount is recorded as uncovered bad debt, and trading and withdrawals pause until top-ups clear it and an admin unpauses.

## Considered Options

- **A separate conversion reserve beside the insurance fund.** Rejected: two budgets for the same lamports invite double counting, and each would need its own exhaustion rule.
- **Let the fund go negative, judged at the current price (fund − net open PnL / price ≥ 0), backed by losers' locked collateral.** Rejected for the demo: it needs less capital, but it is only sound if liquidation reliably realizes losses, which depends on a backstop liquidator existing.
- **Pay winners only what the fund holds and record an IOU.** Rejected: it creates a second liability type, as ADR 0001 rejected.
- **Reject closes that would pay a profit the fund cannot cover.** Rejected: it traps winners in their positions.

## Consequences

The demo needs real seed capital and small exposure limits: 20 devnet SOL backs a 10 SOL per-portfolio exposure limit and a 50 SOL per-side market exposure limit. Setting `insurance_fund` to a number no longer counts as funding. After every instruction that moves lamports, the program checks `vault lamports − rent = total collateral + fund − uncovered bad debt`.
