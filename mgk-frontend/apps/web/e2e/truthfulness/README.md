# Browser UI truthfulness (#34)

This suite drives the actual trade route through an injected synthetic Phantom-compatible wallet. It proves what the interface says after controlled RPC/indexer observations. It never signs, sends, executes on chain, or verifies accounting. Settlement is an explicit fixture observation supplied by the test, not a wallet transaction or a keeper simulation.

The dedicated suite leaves `playwright.config.ts` and its maintenance checks intact. Historical e2e files and their obsolete `mockPhantom` account offsets are not included. Current Rust-exported `packages/layout/program-layouts.json` supplies account sizes, discriminators, layout versions and field offsets; `instruction-fixtures.json` supplies instruction discriminators. The deployed candidate's manifest supplies program/account addresses, and the real SDK/UI decoders consume the fixtures.

## Local controlled proof

From `mgk-frontend/apps/web` after the locked workspace install and Chromium installation:

```sh
NO_DNA=1 pnpm e2e:truthfulness:local
```

The runner builds the SDK, copies frontend source and deployment metadata to a temporary directory, supplies a visibly labelled synthetic manifest, mounts the real trade route with the existing providers/header, builds with `next build --webpack`, starts a loopback production server and runs Playwright. It excludes `.env*`, pins public service endpoints, copies artifacts back even after failures, stops the server and removes the copy. The repository's immutable maintenance layout and pending deployment manifest are never edited. This result is **controlled local UI evidence**, not a deployed candidate or release-gate pass.

For preparing the same explicitly labelled test-only source tree for a preview, run `NO_DNA=1 node scripts/truthfulness-local.cjs --prepare-only`. It prints `CONTROLLED_STAGING_ROOT`; the caller owns deployment and cleanup. Use the printed repository root, with the application in `mgk-frontend/apps/web`. Set `NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com`, `NEXT_PUBLIC_INDEXER_URL=http://localhost:4000`, and `NEXT_PUBLIC_HERMES_URL=https://hermes.pyth.network` when building that synthetic preview. An ordinary browser sees the preview warning and cannot pass deployment validation against synthetic accounts. Never promote this tree to the trading deployment.

## Deployed preview proof

```sh
NO_DNA=1 E2E_BASE_URL=https://YOUR-REVIEWED-PREVIEW.vercel.app pnpm e2e:truthfulness
```

An explicit origin is required, with no credentials, path, query or fragment. Remote mode has no `webServer` and no local fallback. Before fixtures are installed, the suite reads the candidate's `/api/deployment-manifest`; missing, malformed or pending manifests fail. A maintenance-only build fails the lifecycle assertions rather than being skipped. A ready manifest and mounted trading page are prerequisites, not something routes can repair. The deployment-manifest mismatch scenario intentionally serves a different endpoint identity to test stale-build blocking.

For a protected Vercel preview, optionally supply `VERCEL_AUTOMATION_BYPASS_SECRET` through the process environment. It adds Vercel's protection-bypass and bypass-cookie request headers. Never commit this value; traces can contain request headers, so revoke an ephemeral bypass before sharing artifacts.

Both local and remote tests intercept JSON RPC POSTs and service API responses. External chart/telemetry requests are blocked; the chart's non-executable reference label is asserted, not chart availability. The wallet owns no private key, returns only synthetic request receipts, and rejects every signing API. Unexpected RPC methods (including transaction submission) fail the test. No real chain interactions are authorized by this command. A remote pass proves the deployed bundle's UI behavior under controlled data; it does not prove deployed services, on-chain lifecycle, balances, solvency or any other acceptance tier. Record the exact preview URL, commit and artifacts when claiming browser evidence.

## Evidence and coverage

`test-results/truthfulness/results.json` and per-test attachments contain screenshots and trace ZIPs for every checkpoint, including successful states: connected/not ready, deposit, reload, disabled input/exposure/margin reasons, wallet approval, confirmation, accepted/resting, cancel, cleared/awaiting settlement, settled position, reduce-only close, close awaiting settlement, flat position and withdrawal. Further checkpoints cover unknown mark/PnL, pause, stale/down oracle, syncing/down indexer, RPC outage, wrong cluster and manifest mismatch. The local runner adds `SCOPE.txt`. Traces include the preceding interactions and snapshots; `final-or-failure.zip` retains the final chunk. Use `pnpm exec playwright show-trace <path-to-zip>` to inspect a trace.

The browser asserts fixture amounts as displayed observations only. It never derives ledger expectations, recalculates PnL, or claims that a synthetic wallet request moved lamports. A clear alone must show awaiting settlement, no settled position, no confirmed fill and blocked withdrawal; only a later settlement observation can expose the position and settled lifecycle label. Unknown values must stay unavailable rather than appearing as zero. Wallet connection alone never establishes readiness.

On 2026-11-02, the four tests passed against the separately deployed [controlled browser preview](https://mgk-browser-truthfulness-9v7e1uejk-gadillacers-projects.vercel.app) in 41.0 seconds, with the full lifecycle taking 21.9 seconds. This preview uses the isolated harness's synthetic manifest and route mount over application source from `e46c145`; it is visibly labelled as synthetic and is not the trading release candidate. The same four tests passed against the local isolated production build in 36.2 seconds. Screenshots and traces are retained outside source control in `test-results/truthfulness` and CI artifacts.

These results establish controlled browser UI evidence only. The real deployment remains in maintenance with pending manifest entries, and D(browser) for an identified reviewed trading release candidate remains pending. Record that candidate's exact URL, source commit and retained artifacts when it becomes available.
