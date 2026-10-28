# Position settlement (issue #20)

Fills update positions in cleared-results order. Quantities are signed 0.001 SOL lots and prices are micro-USD per SOL. Opening and growing move no collateral except the fee. Reductions realize only the closed quantity; flips realize the old position and open the remainder at the fill price. A zero position is removed. The bound oracle converts realized amounts at settlement, using the shared owner, address, instrument, active, timestamp and confidence checks. Invalid conversion rejects the whole Solana transaction and permits retry.

Entry prices use a fixed grid of `ENTRY_PRICE_SCALE = 1_000_000_000_000` units per micro-USD: a quantum of 10^-18 USD. The stored entry is `entry_vwap + entry_remainder / entry_denominator`, where the denominator is either the scale or zero for an integer. On each same-side grow, compute the weighted average from the previously stored entry and the integer fill price, then round long entry up and short entry down to this grid. Reductions retain the stored entry; opens and flips start at the integer fill price. This deliberately favors the protocol: a higher long basis or lower short basis can only reduce a trader's later payoff.

For a grow's exact weighted average W and stored result Q, long entry satisfies `0 <= Q - W < 1/scale` micro-USD; short entry satisfies `0 <= W - Q < 1/scale`. This follows directly from ceiling/floor of `W * scale`. It bounds each grow's new rounding error against its inputs, not the cumulative error against an unlimited-precision lifecycle. Since a weighted average cannot amplify the previous entry error, after N grows the cumulative error against that lifecycle is less than N/scale micro-USD and remains in the protocol's direction.

Realized lamports use the stored entry's exact fraction before cashflow rounding. Credits round down and debits round up. Taker fees are 5 bps of each fill's exact notional, converted and rounded up once per fill; makers pay zero. Initialization, fee updates and settlement reject other schedules. Funding accrual, cursors and checkpoints are disabled regardless of the governance pause flag.

The cumulative `realized_usd` display total adds each event's realized micro-USD rounded toward negative infinity. It may differ from rounding a cumulative exact USD sum. It is never an input to lamport conversion. `realized_lamports` records actual converted cashflows, `fees_paid` actual lamport fees, and `funding_paid` remains zero. Equity changes by realized lamports minus fees. The fund receives fees and realized losses and pays realized gains; vault physical lamports and aggregate balance stay unchanged by these internal transfers.

Intermediate products use checked i128 arithmetic, so out-of-range prices or quantities still return Overflow and roll back. The fixed scale removes lifecycle-dependent denominator growth: ordinary repeated grow/reduce cycles no longer exhaust u64 precision after approximately 64 grows. Native regressions exercise 1,024 cycles per direction, and signed SBF settlement fixtures exercise 128 per direction. The independent Python Fraction ledger quantizes once per grow using the same public policy; it does not import program arithmetic. A weighted-entry vector still avoids the 11-lamport overpayment of integer VWAP.

Until issue #23 implements cash-backed exhaustion, pause and debt handling, an insufficient fund rejects settlement with InsufficientFunds. This is an interim boundary, not the completed ADR 0003 exhaustion policy. Margin admission, loss caps and bad-debt handling remain separate work; fees can make signed equity negative. Demo runs require adequately funded portfolios and a seeded fund.

## Portfolio layout version 2

Old version 1 portfolios are rejected; recreating demo accounts is required. Previous draft rational v2 accounts with arbitrary denominators must also be recreated; off-grid denominators are rejected. Other account versions remain unchanged. Compile-time assertions enforce identical host and SBF offsets.

| Field | Offset / size |
|---|---:|
| Portfolio | 2048 bytes |
| user | 8 |
| equity / principal | 48 / 64 |
| realized_usd / realized_lamports | 80 / 96 |
| fees_paid / funding_paid | 112 / 128 |
| im / mm / free_collateral / health | 144 / 160 / 176 / 192 |
| positions_len / positions | 208 / 216 |
| Position stride | 40 bytes |
| Position instrument_id / qty / entry_vwap | 0 / 8 / 16 |
| Position remainder / denominator | 24 / 32 |
| funding checkpoints | 1504 |
| last_batch_id / last_slot / bump | 2016 / 2024 / 2032 |

The signed runtime harness decodes this version. General SDK and operations decoder migration belongs to issue #25; older decoders must not be used with these accounts.
