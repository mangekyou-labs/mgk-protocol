# Runbook: Cleared batch unsettled for over 2 minutes

Trigger: `GET /api/status` reports `checks.batch.severity = critical` with
`phase = 4` (Cleared) and `ageSeconds > 120`, or the external uptime monitor
pages on `severity:critical`. Withdrawals are blocked while the current batch
is Cleared but not yet Settled, so traders cannot exit against unapplied fills.

## What is happening

The keeper has cleared the batch but settlement keeps reverting. Settlement
fails closed, most often because the conversion price is invalid: the oracle
is stale (age over 60 s), future-dated, over the 1% confidence bound, inactive,
or bound to the wrong instrument. An unreachable RPC or an empty keeper fee
balance produces the same symptom.

## Diagnose (in order)

1. Open `/api/status`. Note `checks.oracle` (age and severity), `checks.fees`
   (keeper balance vs the floor in `deployments/monitoring.json`),
   `checks.rpc.reachable`, and `checks.pause.flags`.
2. Check the keeper log for `settlement_retry`. The worker retries the same
   phase with 2, 4, 8, 16, then 30 s backoff and never skips a batch.
3. If the oracle check is critical, inspect the oracle worker log for quorum
   loss (fewer than 2 of Pyth Hermes, Coinbase, Kraken within 50 bps). No
   quorum means the worker correctly publishes nothing.
4. If fees are critical, the keeper payer is below the 0.01 SOL floor.

## Fix

- Oracle quorum: restore venue reachability (or the Hermes API key), then wait
  for the next 10 s publish cycle. Do not patch the oracle account by hand.
- Fee SOL: top up the keeper fee payer. The same keeper process resumes the
  same batch automatically once the balance recovers.
- RPC: restore the dedicated devnet endpoint. Keep `confirmed` commitment;
  do not fail over to a different provider mid-incident.
- Never hand-settle, never skip the batch, and never fall back to an older
  batch account. A `missing_batch` halt is critical: verify the exact current
  batch derived from the registry counter on chain, repair through the
  approved operational process, then restart the keeper.

## Verify

`/api/status` returns `checks.batch.severity = ok` with the batch Settled and
the registry counter advanced. Traders can withdraw again. Record the incident
(cause, duration, batch ID) in the deployment log.

## Rehearsal

Rehearse on the throwaway devnet market D′ before launch: stall the oracle,
confirm the critical alert and blocked withdrawals, restore quorum, and watch
the keeper finish settlement without manual intervention.
