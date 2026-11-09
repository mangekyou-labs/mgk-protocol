# Protocol maker

The protocol maker supplies real GTC maker orders and takes over liquidatable
positions. It uses the manifest's dedicated maker signer and portfolio. It never
constructs a taker order. Funding, portfolio creation and deposits remain operator
steps; the worker has no admin role.

Run from the repository root after installing `tools` dependencies:

```sh
NO_DNA=1 npm install --prefix tools --ignore-scripts --no-audit --no-fund
NO_DNA=1 RPC_URL=https://YOUR_DEDICATED_DEVNET_RPC \
  MAKER_KEYPAIR=/path/to/operator-managed-maker.json \
  DEPLOYMENT_MANIFEST=/path/to/ready-deployment.json \
  node tools/maker-worker-cli.js --loop
```

`--once` runs one reconciliation and exits. `npm run maker --prefix tools` and
`npm run maker:once --prefix tools` are equivalent entrypoints. The operator
supplies the signer file; never check it in. The signer must match manifest
`accounts.maker` and the monitoring maker payer when configured. A ready manifest,
explicit RPC and key are required. Localnet permits loopback endpoints; devnet
requires HTTPS and the devnet genesis hash. Legacy batch/book/portfolio overrides,
admin/oracle/keeper keys and role overrides are rejected. The current batch,
book and maker portfolio are always derived from chain and canonical PDA seeds.

Every five seconds the worker reads confirmed state through the frozen shared
layout decoders. It maintains 100 lots (0.1 SOL) at each of three levels on each
side: 10, 20 and 30 basis points from the validated conversion price. Bids round
down and asks round up in micro-USD. All six quotes post atomically, always with
`isMaker=true`. It reuses a complete surviving ladder across batches and restarts.
A ladder whose every level is within 5 bps of its target is kept. A larger price
move or a partially filled ladder triggers one atomic cancel-and-replace,
so old GTCs never stack with replacements. A failed/uncertain send is reconciled
from the portfolio next tick; success is emitted only after error-free confirmed
transaction status. The worker uses the existing legacy transaction adapter,
sends with confirmed preflight (which simulates the signed transaction) and caps
compute at 1,400,000 units.

RPC budget: a steady cycle is one batched read of the instrument, registry,
portfolio, fee payer, oracle, vault and the expected current batch. A blockhash
is reused for up to 20 seconds, and confirmation polls once a second.

The oracle must have the configured owner, version, instrument binding and active
flag, positive price, nonnegative confidence no greater than 1%, and age from zero
through 60 seconds. Invalid or unreadable oracle data stops quoting and cancels
existing quotes when settlement is unlocked and fee SOL is available. Trading or
post pauses also cancel quotes. During a cleared, unsettled batch it waits without
mutating orders. A missing batch or malformed account produces an actionable
retry alert and never falls back to an older batch.

Before quoting, conservative checks require enough equity after unrealized losses
for current initial margin and all six order reservations (including worst-case
5 bps fees). Both sides must fit the 10 SOL portfolio and 50 SOL market limits,
and the fund must cover 0.4 times the larger open-interest side plus the entire
new side. The default ladder requires about 0.121 SOL of idle collateral; existing
positions and liquidation need additional capital. If capacity is insufficient,
existing quotes are cancelled and `blocked` is reported. On-chain simulation and
admission remain authoritative for concurrent changes. Operator monitoring uses
`deployments/monitoring.json` (or `MONITORING_CONFIG`), including the 0.01 SOL
fee floor. Below that floor it alerts and waits for a top-up.

Before normal quoting, at most once a minute (and again right after a
liquidation), the worker scans core-owned portfolio accounts, validates
their layout and canonical address, and reprices maintenance health at the same
oracle. If liquidation is allowed and a portfolio is unhealthy, it atomically
cancels its own quotes to release reservations and invokes the real permissionless
`LiquidateUser` takeover. The program cancels victim orders and enforces 25% steps,
initial margin, exposure, penalties and vault accounting. A simulation-rejected
victim cannot starve others: the worker simulates each takeover and tries
subsequent eligible portfolios. If none can be serviced, it cancels its quotes,
alerts `liquidation_capacity`, and stays withdrawn until a later scan finds no
unserviceable victim. It never advances a batch; the keeper
continues to own clear and settle.

Structured JSON contains statuses such as `quoted`, `resting`, `liquidated`,
`invalid_price`, `blocked`, `low_fee_sol`, `awaiting_settlement` and `retry`, with
confirmed signatures where applicable. RPC credentials, raw errors and signer
material are never logged. One-shot retry, invalid-price, risk-block and low-fee
results exit nonzero. SIGINT/SIGTERM stop the loop; GTC orders persist on chain,
so stopping a process alone does not cancel them. Keep the dedicated signer
exclusive to this worker, pin the deployed commit and disable automatic deploys.
Run a single active maker process per signer; restart safety relies on confirmed
state, while multiple independent maker processes can race each other's quotes.

Fast boundary tests:

```sh
NO_DNA=1 node --test tools/maker-worker.test.js
```

The candidate local-runtime scenario in `tools/runtime/maker.test.js` runs the
actual worker CLI, taker fills, keeper settlement and liquidation takeover against
identical hashed SBF artifacts. See `tools/runtime/README.md` for the command and
report. Local evidence does not replace the remaining release acceptance gates
or devnet rollout approval.
