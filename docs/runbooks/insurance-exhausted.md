# Runbook: Insurance fund exhausted

Trigger: `GET /api/status` reports `checks.insurance.severity = warn` (fund
below the 1 SOL floor in `deployments/monitoring.json`) escalating to a paused
market, or `checks.pause` is critical after a settlement. When the fund cannot
cover a realized payout, the winner is still credited in full, the shortfall
is recorded as `uncovered_bad_debt`, and trading and withdrawals pause
automatically. Losses are never socialized.

## Diagnose

1. Open `/api/status`. Record `checks.insurance.lamports`, the floor, and
   `checks.pause.flags`. Confirm the vault identity:
   `vault lamports − rent = total collateral + fund − uncovered_bad_debt`.
2. Identify the settlement that exhausted the fund from the indexer history
   (batch ID, conversion price, realized PnL). Confirm no portfolio is below
   maintenance margin at the current oracle price before planning an unpause.
3. Confirm the pause is the exhaustion auto-pause, not an admin pause for a
   separate incident. Do not unpause around a second fault.

## Fix (admin key only, offline)

1. Top up the insurance fund with real lamports using the anyone-callable
   top-up instruction. Inflows repay `uncovered_bad_debt` first; keep topping
   up until the debt reads 0.
2. Confirm the fund is at the required reserve: at least 0.4 × the larger
   side's open interest. Below that, orders that add exposure stay rejected
   even after unpause.
3. Unpause withdrawals first, then trading. Only the admin key unpauses, and
   only once the debt is 0 and the reserve holds. Verify `/api/status` shows
   `checks.pause.severity = ok` before announcing recovery.

Never drain the fund to recover: admin fund withdrawal is limited to the
surplus above the required reserve.

## Verify

Place a small reduce-only close and a flat withdrawal on the recovered market;
both must succeed. Confirm new exposure is accepted only while
`fund ≥ 0.4 × (larger open-interest side + order quantity)`.

## Rehearsal

Rehearse on the throwaway devnet market D′ before launch: force an exhaustion
pause with a test payout, run the top-up, and unpause in the order above
(withdrawals, then trading) with admin signatures.
