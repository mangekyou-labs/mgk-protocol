# Rollback per component

Every rollback returns to a previously verified artifact. Record the commit,
program `.so` hashes, program IDs, and cluster in the deployment log before
and after any rollback. A program redeploy voids all acceptance evidence;
a frontend-only redeploy voids only the browser rows.

## Frontend (Vercel)

Use Vercel instant rollback to the previous production deployment (the
maintenance banner build is always a valid target). Promote only the exact
preview build that passed the gate; never rebuild during rollback. The web
app reads the checked-in `deployments/devnet.json` manifest at build time, so
a rollback also restores the market the build was bundled against.

## Workers (Render: keeper, oracle, maker)

All three background workers run with `autoDeploy: false` on pinned commits.
To roll back, manually deploy the previous pinned commit for that service in
the Render dashboard; a push alone never changes production. Workers are
stateless and derive the current batch, book, and portfolios from chain, so a
rollback needs no state migration. Restart order after a multi-worker
rollback: oracle first (wait for a fresh price in `/api/status`), then
keeper, then maker. The indexer is a read-only web service; roll it back the
same way, keeping `DEPLOYMENT_MANIFEST` pointed at
`deployments/devnet.json`.

## Programs (perps-core, matcher, oracle)

Keep the previous verified `.so` and its hash with the release report.
Redeploy it only when the fix is layout-compatible (same discriminators and
layout-version bytes). Any layout change instead pauses the market and starts
a new demo market under fresh program IDs; never migrate accounts in place.
After a compatible redeploy, re-run the full acceptance gate from Checkpoint
B before workers resume against the new artifact.

## Manifest and monitoring config

`deployments/devnet.json` is the single checked-in manifest shared by the
frontend, indexer, and all three workers. Roll it back with the commit that
carries it; never edit Render dashboard env vars to point services at
different deployments. `deployments/monitoring.json` floors roll back the
same way. `BATCH_ADDRESS`-style overrides do not exist and must not be
reintroduced during an incident.
