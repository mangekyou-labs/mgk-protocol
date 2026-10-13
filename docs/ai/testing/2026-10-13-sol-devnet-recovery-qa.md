# SOL devnet recovery: auction semantics and lifecycle acceptance

Date: 2026-10-13. Source baseline: `25951f3` (`master` at investigation start). Research only: no live transactions, deployments, or claim that these tests passed. Review recovered branches against these findings before implementation. Destination: a SOL-only devnet demo with truthful balances, orders, fills, PnL, close and withdrawal.

## Findings that change the recovery plan

**Restoring the keeper is necessary but insufficient. Current checked-in accounting cannot be presented as accurate perpetuals accounting.** These are source findings, not a reproduction against deployed bytecode:

1. `PostOrder` accepts a portfolio and posts to the book without checking or reserving initial margin. The current DFBA `process_clear_batch` ignores its instrument and portfolio account arrays; an older `compute_user_cap` helper and tests do not establish enforcement in this path. Sources: [post_order.rs](../../../programs/perps-core/src/instructions/post_order.rs), [clear_batch.rs](../../../programs/perps-core/src/instructions/clear_batch.rs).
2. OrderForm encodes both USD price and SOL quantity at 1e6. Deposits and withdrawals operate in lamports (1e9/SOL). `apply_one_dfba_fill` computes the unscaled product `fill_qty * fill_price`, subtracts it from buyer equity, adds it to seller equity, and applies fees on the same product. It does not convert USD into SOL or recompute IM/MM. For 0.1 SOL at $100: raw quantity 100,000 × raw price 100,000,000 = 10,000,000,000,000, interpreted as **10,000 SOL** of equity change. This is also full-notional cash movement, not futures realized-PnL accounting. Sources: [OrderForm.tsx](../../../mgk-frontend/apps/web/components/trade/OrderForm.tsx), [deposit.rs](../../../programs/perps-core/src/instructions/deposit.rs), [settle_batch.rs](../../../programs/perps-core/src/instructions/settle_batch.rs), [withdraw.rs](../../../programs/perps-core/src/instructions/withdraw.rs).
3. `Portfolio.recalc_margin` only derives free collateral = equity − IM and health = equity − MM. Consequently an inflated seller equity can inflate withdrawal eligibility; `withdraw` also checks vault balance but does not independently revalue positions. This must be proved safe with funded-counterparty tests before calling withdrawals working. Sources: [portfolio.rs](../../../programs/perps-core/src/state/portfolio.rs), [withdraw.rs](../../../programs/perps-core/src/instructions/withdraw.rs).
4. Reduce-only is checked against position direction and quantity at posting. Concurrent reductions are explicitly not reserved; the DFBA scratch order representation lacks the flag and current settlement does not enforce it. Two individually valid closes can reverse the position. Direction reversal also retains the previous entry VWAP; fully closed positions remain in the position array. Sources: [post_order.rs](../../../programs/perps-core/src/instructions/post_order.rs), [dfba.rs](../../../programs/perps-matcher/src/state/dfba.rs), [settle_batch.rs](../../../programs/perps-core/src/instructions/settle_batch.rs).
5. Settlement loops over receipts and applies a fill only if a matching portfolio is supplied. Missing users do not cause an explicit failure in this loop. Test omitted counterparties, duplicate portfolios and replay before trusting conservation. Source: [settle_batch.rs](../../../programs/perps-core/src/instructions/settle_batch.rs).
6. Funding updates `portfolio.pnl`, but `recalc_margin` does not incorporate that field into equity; do not infer balance settlement from a funding checkpoint. The displayed position PnL repeats the raw product assumption and liquidation-price approximation. Sources: [settle_batch.rs](../../../programs/perps-core/src/instructions/settle_batch.rs), [Positions.tsx](../../../mgk-frontend/apps/web/components/portfolio/Positions.tsx).

These findings justify a narrow accounting/margin recovery gate; they do not justify replacing the DFBA matcher or migrating the SDK.

## What DFBA means for the product

The repo names Jump Crypto's paper as its matching specification. Jump separates maker buys versus taker sells (bid auction) from maker sells versus taker buys (ask auction). Each has a uniform price; price priority precedes marginal pro-rata allocation. Maker/taker is designated independently of arrival time. Unfilled orders retain their role. Two crossing taker orders cannot trade together, nor can two maker orders. The worked example clears bid at 9.97 for 500 and ask at 10.03 for 400; marginal maker ask allocations include 100/250/50. Its suggested 100ms–1s auction periods are design guidance, not measured Solana or MGK latency. [Jump Crypto, Dual Flow Batch Auction](https://jumpcrypto.com/resources/dual-flow-batch-auction).

The earlier frequent-batch-auction literature motivates discrete rather than continuous matching and uniform-price auctions; it does not prescribe MGK's collateral, funding, liquidation or hosting choices. [Budish, Cramton and Shim, 2015](https://doi.org/10.1093/qje/qjv027).

MGK already implements four order regions, price-based clearing, allocation and self-trade filtering. Core computes a valid mark only when both auction legs have positive matched quantity, using their midpoint; a one-leg fill can execute while the new mark is invalid and liquidation is paused. Settlement carries a previous mark when no valid new mark exists. Therefore a stale carried mark must not be rendered as a fresh tradable price. Sources: [dfba.rs](../../../programs/perps-matcher/src/state/dfba.rs), [clear_batch.rs](../../../programs/perps-core/src/instructions/clear_batch.rs), [settle_batch.rs](../../../programs/perps-core/src/instructions/settle_batch.rs).

For initial QA use **three independently owned demo wallets**: a maker posting both sides, a long taker, and a short taker. This proves both legs while leaving visible taker positions; one taker buying and selling equal quantities merely finishes flat. Two wallets can prove matching with four posts, but a single wallet cannot prove independent-counterparty execution. The live demo needs continuing funded maker liquidity, not only one scripted fill. This is an operational implication of the matching rules.

## Screenshot diagnosis boundary

The exact error originates in `resolveOpenBatch`, before order submission. It can mean a hardcoded batch has already settled, no nearby PDA is collecting, or the keeper has not opened the next batch. RPC/cluster/program mismatch is another hypothesis. It is **not evidence that the indexer alone caused the failure**. An explicit batch override is used immediately and does not fall back to dynamic discovery. Without the override, indexer lookup precedes RPC candidate scanning. Source: [onchainAccounts.ts](../../../mgk-frontend/apps/web/lib/onchainAccounts.ts).

The keeper closes collection, clears and settles, creating the next batch during settlement. Its default polling interval is 2 seconds; end-to-end fill latency also includes collection thresholds and multiple confirmations. Inspect latest chain status, keeper logs, service configuration and last successful settlement before changing the RPC. Source: [keeper-crank.js](../../../tools/keeper-crank.js). Render's accepted cold-start delay should show a loading/reconnecting state; it must not manufacture zero balances or successful fills.

## Accounting contract to settle before economic QA

Record the chosen payoff and conversion explicitly. The present UI labels imply a SOL-base, USD-priced contract with SOL collateral, but the raw implementation does not establish a coherent conversion.

A candidate **linear USD payoff, settled in SOL** is: Q = signed base quantity / 1e6; P = price / 1e6; USD PnL = Q × (exit − entry); SOL PnL = USD PnL / validated SOL/USD conversion price C; lamports = SOL PnL × 1e9, with a documented rounding direction. This is a proposed contract, not existing behavior. An inverse contract has a different payoff and must not be substituted silently.

Numerical acceptance vector for that candidate: long 0.1 SOL at $100, exit $110 → +$1 before fees; if C=$110 at realization, +0.009090909 SOL rounded toward zero. The short loses the identical settlement amount. Opening an at-mark position changes account value only by fees, not by its full notional. Adding to a position updates weighted entry; partial reduction preserves remaining entry; reversal realizes the closed portion and assigns execution price to the new side. Margin must cover open-position risk and reserved open-order risk, with fees and funding reflected consistently in equity, health and withdrawable collateral.

Agree where C comes from, freshness bounds, when conversion occurs, and whether unrealized PnL is withdrawable. Reconcile fees, maker rebates, rounding dust, insurance and funding in one settlement currency. Do not merely divide a display value until it looks plausible.

## Acceptance matrix

P0 gates block the working-demo claim. P1 scenarios complete operational confidence. All results start **not run**. Record each run's source commit, deployed program identities, cluster, batch IDs, signatures, account snapshots and expected arithmetic. UI screenshots alone cannot prove accounting.

| Priority | Scenario | Required observable result | Current support / concern |
|---|---|---|---|
| P0 | Fresh wallet → create portfolio → deposit 0.2 SOL | Wallet delta reconciles deposit plus rent/fees; vault and principal gain exactly 200,000,000 lamports; reload preserves balance | Deposit path exists; verify deployed account layouts |
| P0 | Cancel wallet signing; insufficient fee balance; duplicate click | No false success; no duplicate accepted order or deposit; useful retry | Browser and wallet test required |
| P0 | Maker two-sided quotes + separate long/short takers | Both auctions clear independently; all counterparties receive exact receipts; maker role does not depend on timestamp | DFBA implemented; funded maker and keeper required |
| P0 | Crossed taker/taker or maker/maker orders | No fills despite visually crossed combined book | UI must expose executable maker depth or clearly describe unavailable liquidity |
| P0 | Wrong-side/non-crossing order; one-leg fill; no fills | Order rests correctly; one-leg fill settles; invalid fresh mark is not displayed as valid | Pure dual-mark gate implemented |
| P0 | Partial fill then next-batch fill | Filled + remaining = submitted; role/order ownership preserved; no duplicate fill | Inspect book and result receipts across batches |
| P0 | Cancel unfilled and partially filled order | Only remaining quantity cancels; collateral reservation released; cancel cannot undo settled fills | Cancellation exists; margin reservation missing in inspected posting path |
| P0 | Cancel races clear; cancel another user's order | Exactly one chain-consistent outcome; unauthorized cancel rejected; UI refreshes | Test matcher direct path as well as Core wrapper |
| P0 | Tiny deposit, excessive size, multiple open orders, opposite sides | Aggregate worst-case exposure bounded at post and execution; no free short proceeds | Current DFBA ignores legacy cap inputs |
| P0 | Post then withdraw before fill | Withdrawal cannot leave executable exposure uncollateralized | No current DFBA reserve found |
| P0 | 0.1 SOL @ $100; unchanged mark then $110 mark | No full-notional equity transfer; known-vector PnL, fees and margin reconcile | Current unit/accounting blocker |
| P0 | Add, partial close, full close, reversal | Correct weighted entry, realized/unrealized split and residual entry; flat positions absent | Current reversal/flat-row issue |
| P0 | Two reduce-only closes; stale close after other fill | Total execution never crosses zero; excess reduction cancels/clamps under documented rule | Post-time-only guard insufficient |
| P0 | Withdraw after closing/cancelling all exposure | Exact permitted funds leave vault; second withdrawal cannot reuse balance; over-withdraw rejects | Test vault liabilities across all counterparties |
| P0 | Settlement omits one participant; duplicate/replayed settlement | Whole operation rejects or safely resumes without imbalance; no permanent missing credit | Current missing-portfolio loop concern |
| P0 | Keeper dies after close / clear / before settle | Restart resumes safely, no double clear/settle; next collecting batch appears | Inspect state progression, not process uptime alone |
| P0 | Indexer sleeping/unavailable/stale then reconnecting | On-chain writes and confirmed balances remain truthful; history recovers without duplicates | Render cold start accepted; pending is distinct from zero |
| P0 | Wrong RPC cluster/program; stale hardcoded batch | Block signing with clear actionable message; no retry loop against obsolete PDA | Exact screenshot lookup path has these hypotheses |
| P0 | Mark invalid; stale/inactive/future-dated oracle | No fresh-mark claim; funding and liquidation gates behave as specified | Funding freshness checks exist; accounting integration incomplete |
| P0 | Healthy / boundary / unhealthy account liquidation | Healthy and health=0 reject; valid unhealthy position reduces; no missing-instrument valuation; resulting balances conserve value | Liquidation instruction exists; health input needs accounting repair |
| P1 | Oracle age 599/600 seconds; missing/wrong-owner/wrong-instrument | Strict freshness boundary and binding checks work; resume avoids retroactive invalid accrual | Source uses age <600 seconds for funding |
| P1 | Positive/negative funding, zero interval, skip/resume | Equal-and-opposite payments or explicit balancing rule; checkpoints idempotent; equity affected consistently | Funding field currently differs from equity |
| P1 | Maker rebate exceeds collected fees | Explicit reserve/budget handling; no unbacked credits | Fee reconciliation required |
| P1 | Partial liquidation, insurance exhaustion | Deterministic health recovery; uncovered debt visible; never claim automatic ADL completion | Source says ADL pending only, not real ADL |
| P1 | Order cap/overflow, marginal rounding, identical-price allocation | Bounded processing, deterministic dust; receipt quantities conserved | DFBA has bounded scratch/caps; use paper vectors and adversarial inputs |
| P1 | Many batch cycles, wallet switch, reconnect, reload | No stale wallet data; historical and live fills reconcile | Measure warm p50/p95 post→confirm→fill→settle latency |

Unit and runtime tests should assert invariants, not wire constants only: per-auction signed base sums to zero; per-user fills never exceed eligible submitted size; fees/rounding reconcile collateral liabilities; no balance can be withdrawn twice; every receipt applies once; valid reduction never increases exposure. Run program lint before tests per AGENTS.md, then runtime integration and browser lifecycle tests against the same release. Passing pure-function tests does not establish account validation or CPI safety.

## Minimal trader surface

Keep SOL market, truthful available collateral, deposit/withdraw, side, limit price, size, one submit action, open orders with cancel, positions with close, and fills. Default retail orders to taker. If retained, maker selection belongs under advanced controls with the consequence that it trades only against takers. Hide unsupported TP/SL, leverage controls without enforced margin, funding or liquidation estimates without correct data, and empty histories with no backing endpoint. A unavailable balance is “Unavailable” or loading, not zero.

Use “Order submitted”, “Waiting for a match”, “Partially filled” and “Filled” distinctly. Only show success for the phase proved by chain state. Separate an external Binance reference chart from MGK execution/mark; never label external candles as protocol fills. Hide the BTC/ETH ticker strip for this release. Show one compact service-status message rather than multiple stale statistics. Shareable PnL is deferred until realized PnL reconciles to settlement and includes fees, with a conspicuous devnet label.

CROPS-inspired dependency check: document RPC/indexer/keeper/oracle/admin dependencies and prove user exit during indexer failure; hosted-service liveness affects the actual product. The current devnet has accepted hosted infrastructure, but exit and truthful account state must not depend solely on the Vercel or Render view. This is inspiration from [CROPS skill](https://ethskills.com/crops/SKILL.md), not an Ethereum architecture migration.

## Recommended release sequence

1. Establish canonical source/deployed identities and recover only relevant fixes; replace stale batch overrides and restore keeper/oracle/maker liveness.
2. Resolve payoff units and repair settlement, exposure reservation, execution-time reduction and withdrawal invariants; prove known-number tests before live demo funding.
3. Prune the UI to the verified data/actions and validate warm/cold service behavior.
4. Run the three-wallet lifecycle and P0 matrix with fresh signatures and snapshots. Report remaining failures explicitly; do not call the demo working on the basis of one posted order.

## Follow-up: independently realized USD PnL converted to SOL

This analysis follows the recovery decision to preserve a linear USD payoff and convert realized PnL at a fresh SOL/USD oracle. It is arithmetic derived here, not a claim from the DFBA paper. Neither matching nor a fresh oracle by itself makes this payoff self-financing in SOL.

Consider no fees and 0.1 SOL base quantity:

1. A buys from B at $100: A long, B short.
2. A sells to C at $110, SOL/USD oracle $110. A realizes $1 / 110 = 0.009090909… SOL. C is now long with entry $110; B remains short from $100.
3. Later B buys from C at $110 while the independent SOL/USD oracle is $120. B realizes −$1 / 120 = −0.008333333… SOL. C realizes zero. All positions are flat.
4. Aggregate realized USD PnL is zero, but aggregate SOL PnL is **+0.000757575… SOL**. Rounding cannot explain the difference. Reversing conversion-price order can instead create a surplus.

The use of a separate oracle is intentional: DFBA price need not equal the oracle. Differences also arise along ordinary multi-price position-transfer paths; artificially aligning one demo's closes does not establish a general invariant. A fixed conversion rate would conserve this example but would violate conversion at a fresh oracle and change the payoff.

### Smallest honest boundary preserving that payoff

A **funded protocol conversion reserve** must absorb net SOL PnL credits, and risk accounting must prevent remaining counterparties from withdrawing collateral needed for their losses. A conservative, understandable devnet design is to treat the reserve as counterparty to every realized SOL cashflow: positive realized PnL debits reserve and credits the user; negative realized PnL debits the user and credits reserve. This requires enough reserve for gross winners paid before losers close, not merely the eventual small exchange-rate difference. Insufficient collectible user collateral is additional bad debt, not reserve revenue.

Invariant at cash-ledger level, excluding rent: actual vault SOL assets = user cash balances + funded reserve + separately tracked fees/dust, with no negative user balances counted as collectible assets. Unrealized PnL and order/position margin are tracked separately for risk. Every payout/fee/rebate/withdrawal uses checked arithmetic and proves the invariant. Initial reserve funding must be an actual SOL transfer with a segregated claim; setting `insurance_fund` to a number does not fund it. Reserve withdrawal is distinct from user withdrawal. If reusing the insurance field, explicitly combine conversion-risk and liquidation-risk budgets and prevent double counting.

This preserves independent close-time conversion but introduces a capitalized protocol backstop. It is not a cosmetic unit fix. With insufficient reserve, the protocol needs a specified outcome: close while recording an unpaid claim (larger implementation), risk-off/reduce-only plus new reserve funding, or an explicit loss-resolution process. Simply rejecting every close that would pay profit can trap the user and does not meet the unrestricted-close demo claim. A private controlled demo can pre-fund enough for a bounded, predeclared scenario set, but cannot claim arbitrary profitable exits are guaranteed.

A finite reserve is not a general proof against unbounded prices, leverage, manipulation or adverse conversion paths. Set conservative aggregate open-interest/position limits, validate oracle freshness and confidence, and reserve capacity before opening new exposure. Because liquidation can be disabled whenever both DFBA legs do not clear, low activity can remove the normal risk exit: this is another reason a public unrestricted leveraged demo is beyond a keeper-only recovery.

### Coherent alternative requiring a product decision

Synchronized SOL variation margin can be self-financing: at a shared valid mark M and conversion C, cash-settle every existing signed position Q by Q × (M − previous settlement basis) / C; the market-wide signed quantities sum to zero. For each matched new trade at price P, transfer Q × (M − P) / C to the buyer and the opposite amount to the seller, then carry the residual positions at M. All participants use the same epoch prices, balanced rounding and exactly-once application. Insolvent losers still require liquidation/insurance.

This changes economic payoff timing: the sum of interval-by-interval converted variation is generally different from converting the whole entry-to-exit USD gain at close. It also requires coverage of all open accounts, not only this batch's fillers; staged settlement needs a checkpoint/finalization design and blocked withdrawal until a portfolio is current. Therefore do not introduce it silently as an implementation detail of the approved close-time model.

Merely storing USD PnL internally and converting on withdrawal does not remove reserve/hedging requirements when actual custody contains only SOL. A switch to USDC collateral or an inverse contract changes the product and is outside this targeted recovery.

### Added release gates

- Repeat the three-wallet counterexample with conversion $110 then $120 and reversed order; exact SOL liability drift must be charged to a funded reserve or prevented by the chosen alternative model.
- Withdraw A's profit before B closes; remaining liabilities remain fully backed, with B's risk collateral locked.
- Attempt a payout larger than reserve, a losing close larger than collectible collateral, and reserve withdrawal during open exposure; each follows an explicit truthful outcome.
- Do not advertise accurate profitable withdrawals or liquidation completeness until these cases pass against deployed code.

Remote-branch inspection found the raw `saturating_sub(notional as i128)` cashflow and no oracle conversion in `apply_one_dfba_fill` on every fetched ref containing that helper (`origin/master`, `origin/feature-dfba-auction`, `origin/feature-vercel-schema-recovery` and their backup equivalents). Older refs lacking the helper are not evidence of a compatible accounting repair.
