# Manifest-bound keeper

Run the standalone JavaScript worker from the repository root. It uses the
frozen layout/instruction package and deployment manifest; it does not publish
oracle prices or provision replacement protocol accounts.

```sh
NO_DNA=1 RPC_URL=https://api.devnet.solana.com \
KEEPER_KEYPAIR=/secure/keeper.json \
DEPLOYMENT_MANIFEST=deployments/devnet.json \
MONITORING_CONFIG=deployments/monitoring.json \
node tools/ops-keeper.js --loop
```

`KEEPER_KEYPAIR_FILE` is an alternative to `KEEPER_KEYPAIR`. Both name a JSON
secret-key file, never an inline key. There is no default wallet. The manifest
must have deployed account addresses and a set start slot. Devnet requires HTTPS
and its genesis hash; localnet requires a loopback RPC. Other clusters are refused.
`MONITORING_CONFIG` defaults to `deployments/monitoring.json`; its decimal-string
`feeFloorLamports` controls the fee alert threshold (currently 10,000,000 lamports).
A non-null `feePayers.keeper` must match the configured wallet.

`tools/keeper-crank.js` and `tools/keeper-worker-cli.js` use the identical worker.
`--once` performs one cycle and returns failure on retry, backoff, low SOL or halt;
continuous polling is the default. Only `--loop` and `--once` are accepted.

Remove the retired `BATCH_ADDRESS`, `CURRENT_BATCH_PDA`, `BOOK_ADDRESS`,
`BOOK_KEYPAIR`, `NEXT_PUBLIC_BOOK_ADDRESS`, `PORTFOLIO_ADDRESSES`, `INTERVAL`,
`MAX_CONSECUTIVE_ERRORS` and `DEPLOYER_KEYPAIR` environment overrides. Nonempty
values cause startup failure. There is no keypair batch, historical batch scan,
portfolio HTTP provisioning, oracle fallback, batch counter repair or skip path.
The embedded indexer keeper refuses startup; the indexer remains read-only.
Render's keeper service retains manual deployment and uses this entrypoint with
the manifest and monitoring configuration. Remove old dashboard overrides before
cutover as well as updating the blueprint.

Every two seconds, a serial cycle reads the confirmed registry and derives
`batch(batchIdCounter - 1)` using an exact u64. Collecting waits until its
`commitDeadlineSlot`, then closes; Clearing clears on the next cycle; Cleared
settles on the next cycle. Clear forwards the canonical book/results, instrument,
allocation payer and System program. Settle derives distinct portfolios from the
current matcher-owned results and forwards writable results/book, vault,
instrument, configured oracle, next batch PDA, payer and System program.
Each transaction is signed, simulated with signature verification, sent with
preflight, then confirmed using observed RPC status and blockhash expiry.

Preparation, simulation, sending and confirmation failures retry the same phase
with delays of 2, 4, 8, 16 and then 30 seconds. Each poll still rereads registry
and batch; genuine on-chain phase or batch progress resets the delay. Concurrent
progress reconciles only a higher counter or the same batch moving monotonically
through Collecting, Clearing, Cleared and Settled. A restart reconstructs progress
from chain state and resumes a Cleared batch. No consecutive-failure limit skips
settlement. Unknown status bytes never authorize progress.

Structured JSON status records go to stdout. Alerts go to stderr with severity,
code and a fixed action; RPC exceptions, endpoint credentials and key material
are never emitted. Route stderr through the service log drain to the operator's
notification sink before devnet cutover. This change provides alerts, not an
external notification delivery integration.

- `low_fee_sol` is critical and includes the public payer, balance and floor.
  Top up that wallet; the same process resumes the same batch automatically.
- `settlement_retry` / `crank_retry` include the batch ID and retry time. Inspect
  oracle freshness, current phase accounts and RPC availability; fix the cause
  while the worker continues retrying.
- `missing_batch` is critical and latches a halt, exiting the CLI with code 1.
  The worker rereads the registry first to rule out concurrent advancement.
  Verify deployment and exact current batch on chain, repair through the approved
  operational process, then restart. It never fabricates a replacement batch.
- `cycle_failed` and `startup_validation_failed` are critical configuration/RPC
  alerts. Check manifest/account bindings, RPC, monitoring and key-file setup.
  These messages deliberately contain no raw external exception.

## Local verification

```sh
NO_DNA=1 npm --prefix tools test
node tools/runtime/candidate.js target/deploy candidate.json
NO_DNA=1 MGK_CANDIDATE_MANIFEST="$PWD/candidate.json" \
MGK_KEEPER_REPORT="$PWD/keeper-runtime-report.json" \
node --test tools/runtime/keeper.test.js
```

The production-adapter suite uses signed serialized transactions at an injected
RPC boundary. It covers deadline/restart, missing current batch, settlement
backoff (including absent results), fee topup, malformed bytes/owners,
simulation rejection, u64 IDs above JavaScript's safe-integer range and a
12-portfolio transaction within the 1232-byte packet limit.

The candidate harness runs fresh offline SBF programs and the actual CLI child
processes on isolated port 19919 (override with `MGK_KEEPER_PORT`). It posts two
collateralized traders' crossed orders, kills the worker after clear, restarts
two keepers, and checks receipt consumption, counter advancement, exact signed
quantities, collateral and fees, plus the invariant checker. It then starves and
tops up the payer and removes the exact current batch to verify a halt. The JSON
report records candidate hashes and the actual confirmed settlement signature.
CI runs this harness and uploads its report with candidate evidence.

These are local candidate-runtime checks. Devnet deployment, funded production
keys, notification delivery and sustained live operation remain rollout work;
no devnet signing or sending is part of these tests.
