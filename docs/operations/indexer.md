# Read-only indexer and status

Build the SDK and indexer with `pnpm --dir mgk-frontend -F @mgk/sdk build` and
`pnpm --dir mgk-frontend -F indexer build`. Start with
`pnpm --dir mgk-frontend -F indexer start`. No signing keys or trading workers run
in this service.

`DEPLOYMENT_MANIFEST` selects a shared deployment manifest (default:
`deployments/devnet.json`). Every account and `start_slot` must be deployed/set;
pending manifests stop startup. The start slot is inclusive and must precede the
first deployment transaction. `RPC_URL` selects the confirmed RPC endpoint,
`DB_PATH` the persistent SQLite path, and `PORT` defaults to 4000. A database is
bound to its manifest; use a new database for a different deployment.

An empty database replays every produced block from the start slot. Restart uses
the durable processed watermark; deleting the disk reconstructs history. Failed
transactions never contribute fills. Missing blocks, account history, timestamps,
or settlement receipts hold the cursor for retry instead of skipping history.
RPC history must retain all blocks, transactions, logs, settled batch accounts,
and results since the deployment start; use an archival provider when necessary.

The deployed core artifact must emit `mgk-settlement-v1` receipts from deployment
start. These authenticated full vectors record quantities after reduce-only
clipping; frozen results retain the original allocations. Missing, truncated, or
invalid receipts fail closed. This requires the new core artifact for a fresh
deployment, but changes no frozen account or instruction bytes. Legacy SQLite
fill schemas are reset and replayed because their collapsed fill identities
cannot safely be migrated into exact history.

`MONITORING_CONFIG` defaults to `deployments/monitoring.json`. Set each keeper,
oracle and maker fee-payer public key before deployment. Null roles report a
critical pending configuration. Floors are decimal lamports: the checked-in fee
floor is 10,000,000 (0.01 SOL) per role; insurance is 1,000,000,000 (1 SOL).

Poll `GET /api/status` externally and alert on its JSON `severity` (`ok`, `warn`,
`critical`), not just HTTP 200. Alert separately when the endpoint cannot be
reached. The response includes `chainTip`, `lastIndexedSlot`, and named `checks`
for `rpc`, `oracle`, `batch`, `makerDepth`, `fees`, `insurance`, `pause`, `indexer`.
Each includes severity and chain-derived details; unavailable checks fail closed.
`GET /health` remains a separate process/storage diagnostic.

Oracle age over 30 seconds warns and over 60 is critical; invalid, future or
high-confidence-error prices are critical. Collecting beyond deadline plus 30
seconds warns. Cleared longer than 120 seconds is critical, measured from the
successful clear transaction. Missing either maker side, fee balances below the
floor, and active pause flags are critical. Insurance below its floor and replay
lag over 150 slots warn. The status route performs only RPC reads and does not
pause, trade, fund, settle, or resolve incidents. Point the operator's external
monitor at this endpoint; this repository does not provision an alert channel.
