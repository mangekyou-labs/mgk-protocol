# SOL/USD oracle worker (issue #27)

`ops-oracle.js` runs continuously by default. Each serial cycle starts on a
10-second cadence (slow cycles never overlap). `--once` runs one cycle for
local diagnostics. There are no source, quorum, confidence, or timing overrides.

```sh
NO_DNA=1 npm install --prefix tools --ignore-scripts --no-audit --no-fund
# Paths below are operator-provisioned; never use an admin, maker, or keeper key.
NO_DNA=1 RPC_URL="$ORACLE_RPC_URL" \
  ORACLE_AUTHORITY_KEYPAIR=/run/secrets/oracle-authority.json \
  DEPLOYMENT_MANIFEST=deployments/devnet.json \
  PYTH_HERMES_URL=https://pyth.dourolabs.app/hermes \
  PYTH_API_KEY="$ORACLE_PYTH_API_KEY" \
  node tools/ops-oracle.js --loop
NO_DNA=1 npm test --prefix tools
```

The only loaded signer is the explicitly configured oracle authority. No home
key lookup, wallet fallback, ephemeral production key, additional payer, or
account-address environment override is allowed. The checked-in manifest still
contains pending deployment entries: startup intentionally refuses it until the
operator deploys and records the actual accounts and start slot. Devnet startup
checks the RPC genesis hash. Localnet is restricted to loopback by the CLI.
Owners, frozen discriminators/versions, active flags, oracle authority, and both
oracle/instrument bindings are checked before each cycle and before sending.

Sources are Pyth Hermes Crypto.SOL/USD, Coinbase Exchange SOL-USD last trade, and
Kraken SOL/USD most recent trade. Kraken's ticker has no trade timestamp, so the
worker uses `Trades?pair=SOLUSD&count=1`. An observation must have a valid source
timestamp no older than 30 seconds and cannot be future-dated. HTTP requests have
3-second timeouts, bypass caches, and reject redirects. A successful HTTP response
does not reset the source timestamp. Individual failures, malformed quotes, stale
quotes and future quotes cannot count toward quorum. The worker logs unavailable
venue names without HTTP bodies, exceptions, URLs or credentials.

At least two sources must agree pairwise within 50 bps of the lower quote
(inclusive). All three are used if their full range agrees; otherwise a single
unambiguous agreeing pair is required. Two competing pairs fail closed. The
published price is the median of the quorum (floor of the middle pair's mean).
All arithmetic uses integer micro-USD; source confidence rounds upward.

Confidence is the maximum deviation of **every fresh valid venue**, including an
outlier outside the selected quorum, from the published median, or the fresh
Pyth confidence, whichever is larger. An outlier can therefore produce confidence
over the program's 1% limit: that honestly stops risk actions even though two
venues agree. Missing/stale Pyth contributes no invented confidence. No quorum
publishes nothing; after 60 seconds the on-chain price becomes stale. Recovery
requires fresh valid quorum and the next cycle, without any restart or account
patch. The worker simulates the exact signed transaction, rechecks source age
immediately before submission, sends once with confirmed preflight and no RPC
rebroadcast retries, and reports publication only after error-free confirmation.

Hermes supports `PYTH_HERMES_URL` (HTTPS base URL without credentials or query)
and optional `PYTH_API_KEY` bearer authentication. The legacy default is
`https://hermes.pyth.network`; it returned HTTP 401 during implementation.
Render uses the documented authenticated `https://pyth.dourolabs.app/hermes`
endpoint; an operator must provision a key. HTTP 401 excludes Pyth rather than
fabricating a quote. Coinbase and Kraken can still form quorum.

Current source contracts:

- [Pyth latest price updates](https://docs.pyth.network/price-feeds/core/fetch-price-updates)
- [Coinbase product ticker](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker)
- [Kraken recent trades](https://docs.kraken.com/api-reference/market-data/get-recent-trades)

Public worker tests exercise quote selection, timestamp boundaries, confidence,
manifest/account rejection and confirmation. The existing candidate runtime
smoke additionally launches the actual CLI as a process with controlled HTTP
responses: no quorum preserves a stale oracle, settlement reverts without
changing protected state, restored quorum publishes to the candidate oracle
program, and settlement recovers. The preload fixture is exclusively a test
artifact, never a production worker option. Keys in that test are generated
locally and removed with the fixture directory.

```sh
NO_DNA=1 cargo build-sbf --tools-version v1.52
NO_DNA=1 node tools/runtime/candidate.js target/deploy /tmp/candidate.json
NO_DNA=1 MGK_CANDIDATE_MANIFEST=/tmp/candidate.json \
  MGK_RUNTIME_REPORT=/tmp/oracle-runtime.json \
  node --test tools/runtime/smoke.test.js
```

These are local candidate-runtime checks. Public devnet provisioning, deployment,
worker hosting and the parent issue #13 acceptance gate remain separate work.
