# Provisioning: devnet demo on free Render + minimal SOL (issue #17, amended)

This is the user-executed provisioning checklist for the restricted SOL
devnet demo (spec #13). It replaces the paid provisioning in issue #17
with the user-approved free-tier variant:

| Spec #17 asked for | Amended (approved) |
|---|---|
| Dedicated RPC provider, new account | Existing Helius account, one API key per service |
| Three paid Render workers (~$21/mo) | The three existing free Render services |
| ~55 devnet SOL | ~6 devnet SOL (table below), correctness proven locally first |
| 20 SOL insurance seed | 1 SOL minimal seed; full-seed gate rows stay `not-run` |

Agents never hold the admin key or any secret. Every step below that
touches a key or signs a transaction is done by the user. Nothing in
issues, PRs or this repo may contain a key, keypair or RPC URL with an
API key.

## 0. Prove correctness locally first (0 SOL)

Correctness evidence comes from the local seams, not from devnet spend:

```sh
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
node --test tools/provision-check.test.js   # preflight unit tests
```

The local-runtime harness (issue #15) plus the independent reference
model (issue #14) prove lamport-exact accounting on the candidate `.so`
hashes. Devnet only proves the same build runs against real RPC,
Render and a browser wallet. Do not source SOL until Checkpoint B
(issue #37) is green.

## 1. RPC: split the existing provider key per service

In the existing Helius dashboard, create four API keys (projects):

| Key name | Used by | Set where |
|---|---|---|
| `mgk-indexer` | mgk-indexer | Render `RPC_URL` |
| `mgk-keeper` | mgk-keeper | Render `RPC_URL` |
| `mgk-oracle` | mgk-oracle | Render `RPC_URL` |
| `mgk-web` | frontend (browser) | Vercel `NEXT_PUBLIC_RPC_URL` |

Rules:

- `confirmed` commitment everywhere (already the code default).
- `NEXT_PUBLIC_*` values are inlined into the browser bundle. Treat the
  `mgk-web` key as public: give it its own key, the lowest rate limit
  that works, and provider-side restrictions if available. Never reuse
  a worker key in the frontend.
- If the provider plan allows only one key, reuse it in all four places
  as an interim and record that deviation here with a date. Splitting
  keys is what keeps one leaked or rate-limited service from taking
  down the others.
- The public endpoint `https://api.devnet.solana.com` is a manual
  fallback only (preflight, one-off reads), never a service config.

Verify each key read-only (prints host and slot only, never the URL):

```sh
RPC_URL='<paste key URL>' node tools/provision-check.js
```

## 2. Render: keep the three free services

[render.yaml](../../render.yaml) already describes the three services
on `plan: free` with `autoDeploy: false`. In the Render dashboard:

1. Confirm each service is on the free plan and pinned to the intended
   commit (no auto-deploy).
2. Set each service's `RPC_URL` to its own key from step 1.
3. Mount keypairs as Render **secret files** only:
   keeper service gets the keeper fee-payer keypair, oracle service
   gets the oracle authority keypair. No other service gets a keypair.
4. Leave `REGISTRY_ADDRESS`, `BOOK_ADDRESS`, `PRICE_ORACLE_ADDRESS` and
   `INSTRUMENT_ADDRESS` unset until the issue #38 deploy fills
   `deployments/devnet.json`; then copy the addresses from the manifest.
   Never set `BATCH_ADDRESS` — the current batch is derived.

Free-tier limits, stated plainly:

- Free web services spin down after ~15 min idle and share 750 free
  instance hours/month. Background workers may need Starter on some
  accounts; if Render refuses a free worker, run the same build/start
  commands on the existing free web services and treat the demo as
  awake-window only.
- A sleeping oracle misses its 10 s cadence and a sleeping keeper its
  poll, so oracle prices go stale and batches stop. That is the honest
  state the UI must show (unavailable, never `0`).
- The 30-minute latency run and 2 h soak (spec gate) are only valid
  while all services stayed awake for the whole run. On free tier, run
  them in a deliberate awake window (keep the indexer health endpoint
  polled by the uptime monitor) or record those rows as `not-run`.
- Free services have no persistent disk. The indexer's SQLite file is
  ephemeral (`/tmp/mgk-indexer.db`); a cold start replays from the
  manifest start slot, which the indexer is already required to support.

## 3. Five keys (user generates, admin stays offline)

Run locally, never in a hosted shell, never pasted into chat or issues:

```sh
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/mgk-admin.json       # offline; upgrade authority
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/mgk-oracle.json      # oracle authority
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/mgk-keeper.json      # keeper fee payer
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/mgk-maker.json       # protocol maker
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/mgk-qa.json          # faucet / QA
solana-keygen pubkey ~/.config/solana/mgk-admin.json   # record pubkeys only
```

- `mgk-admin.json` never leaves the user's machine and is never uploaded
  to Render or Vercel. It signs only deploys, init, pause/unpause.
- Only `mgk-keeper.json` and `mgk-oracle.json` are uploaded, each as a
  secret file to its own service (step 2).
- `mgk-maker.json` stays local until the maker worker is deployed as a
  service; provisioning the key now costs nothing.
- Keypair JSON files are gitignored. If a keypair is ever committed or
  pasted, rotate it and say so in the issue; do not just delete the file.

## 4. Minimal devnet SOL budget (~6 SOL)

Recompute the deploy line at Checkpoint B with the final `.so` sizes
(`solana rent $(wc -c < target/deploy/<program>.so)`). At today's sizes
(212,992 / 77,824 / 16,384 bytes) rent-exempt minima are 1.083 / 0.396 /
0.084 SOL.

| Item | SOL | Notes |
|---|---:|---|
| Program deploys, gross incl. buffers | 2.5 | Buffers are reclaimable; ~1.6 SOL stays as program rent |
| Insurance fund seed (minimal) | 1.0 | Proves payout correctness at small size; **not** the 20 SOL spec seed |
| Protocol maker collateral | 1.0 | Small ladder sizes only |
| Keeper fee payer | 0.5 | Clear/settle fees; alert floor well above 0 |
| Oracle fee payer | 0.5 | ~10 s publishes at base fee burn ~0.04 SOL/day |
| QA / faucet wallet | 0.5 | Golden-path wallet |
| **Total** | **~6.0** | vs ~55 SOL in the original rollout plan |

What minimal funding does **not** prove, and must be reported as
`not-run` rather than passed: payouts at the 10 SOL per-portfolio cap,
the 50 SOL open-interest cap, the 20 SOL-seeded insurance rows, and any
gate row whose amounts assume the full seed. Position and OI caps stay
as configured on-chain; small fills exercise the same code paths and
the same lamport-exact reference model.

Sourcing: devnet faucet and `solana airdrop 2` are rate-limited per
wallet and per day, so spread requests across the five pubkeys over
several days. Never pay for devnet SOL.

## 5. After provisioning: verify, then hand off

```sh
# Read-only: manifest programs exist on devnet, RPC healthy, balances sane.
RPC_URL='<indexer key URL>' CHECK_PUBKEYS='<keeper>,<oracle>,<maker>,<qa>' \
  node tools/provision-check.js --indexer-url https://<indexer>.onrender.com
```

Then comment the five **pubkeys** (never keypairs), the four RPC key
names, and the preflight output on issue #17 and tick its boxes.
Deploys and init remain issue #38, signed by the user with the admin
key. Rollback stays: Vercel instant rollback for the frontend, previous
pinned commit for workers, previous verified `.so` for
layout-compatible program fixes, otherwise pause and fix forward.

## Known deviations to settle at Checkpoint B (#37)

- Oracle venues: the worker implements `binance,okx,bybit`; the spec
  names Pyth Hermes / Coinbase / Kraken, and confidence is a fixed 1%
  in code where the spec wants real dispersion. Provisioning keeps the
  implemented venues; changing them is a code ticket, not an env edit.
- No standalone maker worker file exists yet; the maker key is
  provisioned above and its service is added when the worker lands.
