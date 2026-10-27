# Position settlement (issue #20)

Fills update positions in cleared-results order. Quantities are signed 0.001 SOL lots and prices are micro-USD per SOL. Opening and growing move no collateral except the fee. Reductions realize only the closed quantity; flips realize the old position and open the remainder at the fill price. A zero position is removed. The bound oracle converts realized amounts at settlement, using the shared owner, address, instrument, active, timestamp and confidence checks. Invalid conversion rejects the whole Solana transaction and permits retry.

Entry prices remain exact rational values: `entry_vwap + entry_remainder / entry_denominator`, with denominator zero representing an integer. Grows reduce numerator and denominator by their greatest common divisor; reductions retain the entry. Realized lamports use that exact value before rounding. Credits round down and debits round up. Taker fees are 5 bps of each fill's exact notional, converted and rounded up once per fill; makers pay zero. Initialization, fee updates and settlement reject other schedules. Funding accrual, cursors and checkpoints are disabled regardless of the governance pause flag.

The cumulative `realized_usd` display total adds each event's realized micro-USD rounded toward negative infinity. It may differ from rounding a cumulative exact USD sum. It is never an input to lamport conversion. `realized_lamports` records actual converted cashflows, `fees_paid` actual lamport fees, and `funding_paid` remains zero. Equity changes by realized lamports minus fees. The fund receives fees and realized losses and pays realized gains; vault physical lamports and aggregate balance stay unchanged by these internal transfers.

Exact arithmetic has finite bounds: intermediate products use checked i128 arithmetic and the normalized entry denominator is u64. Repeated grow/reduce cycles can exhaust that denominator in approximately 64 cycles even at ordinary prices. Such fills return Overflow and the transaction rolls back; this implementation does not promise unlimited Fraction lifecycles. It does not quantize entry to extend that limit. The regression suite exercises exhaustion as well as a weighted-entry vector where integer VWAP would overpay by 11 lamports.

Until issue #23 implements cash-backed exhaustion, pause and debt handling, an insufficient fund rejects settlement with InsufficientFunds. This is an interim boundary, not the completed ADR 0003 exhaustion policy. Margin admission, loss caps and bad-debt handling remain separate work; fees can make signed equity negative. Demo runs require adequately funded portfolios and a seeded fund.

## Portfolio layout version 2

Old version 1 portfolios are rejected; recreating demo accounts is required. Other account versions remain unchanged. Compile-time assertions enforce identical host and SBF offsets.

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
