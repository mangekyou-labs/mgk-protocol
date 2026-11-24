# mgk-frontend

Frontend subsystem of the **mgk** protocol — a fully on-chain perpetual futures DEX on Solana (commit-reveal CLOB, deterministic Fisher-Yates shuffle). See [`docs/ai/design/2026-06-16-feature-mgk-frontend.md`](../docs/ai/design/2026-06-16-feature-mgk-frontend.md) for the full design.

## Layout

```
mgk-frontend/
├── pnpm-workspace.yaml
├── package.json              # root scripts: dev / build / lint / test
├── apps/
│   ├── web/                  # Next.js 16 SPA, App Router, port 3000
│   │   ├── app/              # trade, portfolio, marketing pages
│   │   ├── components/       # chart, trade, orderform, portfolio, common
│   │   ├── lib/              # hooks, stores, config, feeds
│   │   └── e2e/              # Playwright smoke tests
│   └── indexer/              # Fastify 5 + SQLite, port 4000
│       └── src/              # subscriber, decoder, aggregator, store, rest, ws
└── packages/
    └── sdk/                  # @mgk/sdk: Pinocchio instruction encoders, PDA derivation, state decoders
```

## Prereqs

- Node 22+
- pnpm 9 (`corepack enable && corepack prepare pnpm@9.15.0 --activate`)

## Environment

| Variable | Default | Notes |
|---|---|---|
| `NEXT_PUBLIC_RPC_URL` | (unused) | Ignored by the browser: every read and send goes to the same-origin proxy `/api/rpc/devnet`, so no RPC URL or key is inlined into the bundle |
| `RPC_UPSTREAMS` | (none, required) | Server-only, never `NEXT_PUBLIC_`. The proxy uses only the first comma-separated entry (the dedicated devnet provider, key included); no rotation, failover or public fallback. Unset or empty: the proxy answers a 503 JSON-RPC error and the UI shows RPC unavailable |
| `NEXT_PUBLIC_CORE_PROGRAM_ID` | `9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT` | mgk-perps-core on devnet |
| `NEXT_PUBLIC_MATCHER_PROGRAM_ID` | `68MQqdugxZQA2F8GahhWZEusPnHbrfAXjqq2V9VCz8tK` | mgk-perps-matcher on devnet |
| `NEXT_PUBLIC_ORACLE_PROGRAM_ID` | `GLAu9n48oqnVRKHNoqfpek3kZyGUJTJRPQKo7mF3qWmm` | mgk-oracle on devnet |
| `NEXT_PUBLIC_INDEXER_URL` | `http://localhost:4000` | Indexer REST + WS base URL |
| `NEXT_PUBLIC_HERMES_URL` | `https://hermes.pyth.network` | Pyth Hermes API |

## Common commands

```sh
# from mgk-frontend/
pnpm install                   # install all workspaces
pnpm dev                       # run web (:3000) + indexer (:4000) in parallel
pnpm -F web dev                # web only
pnpm -F indexer dev            # indexer only

# tests
pnpm test                      # all packages (web + sdk + indexer)
pnpm -F @mgk/sdk test          # SDK unit tests (151)
pnpm -F web test               # web unit tests (419)
pnpm -F indexer test           # indexer tests (28)

# typecheck
pnpm typecheck                 # all packages (tsc --noEmit)

# build
pnpm build                     # all packages
pnpm -F web build              # Next.js production build

# e2e
pnpm -F web e2e                # Playwright smoke tests (requires dev server)
```

## Architecture

```
Browser (Next.js 16 SPA)
  │
  ├── @mgk/sdk ──── Pinocchio instruction encoders (raw byte), PDA derivation, BPF state decoders
  │
  ├── Chain RPC ─── /api/rpc/devnet (same-origin proxy → first RPC_UPSTREAMS entry):
  │                 getMultipleAccountsInfo (portfolio, batch, book) every 2-5s, sends
  │
  ├── Wallet ────── @solana/wallet-adapter (Phantom, Solflare)
  │
  └── Indexer ───── REST (/api/*) + WebSocket (/ws) for candles, fills, batch state
         │
         └── Solana logs subscriber + signature replay (getSignaturesForAddress →
             getTransaction from the stored cursor) → SQLite → candles → fan-out WS
```

**Design decisions:**
- **No Anchor / IDL** — Pinocchio programs use single-byte discriminators. SDK hand-rolls byte layouts.
- **Chain reads over RPC** (through the same-origin proxy, which holds the provider key) for freshness-critical state. Indexer for history and WS fan-out; it replays missed history by program signatures from its cursor and reports a gap instead of skipping it when the RPC no longer retains that range.
- **TradingView widget** for chart (`BINANCE:SOLUSDT` for devnet; Pyth data feed deferred to post-v1).
- **Zustand** stores for shared chain polling and ephemeral UI state. Indexer REST uses fetch-based hooks; one page-level status hook supplies the trade screen banners and status bar.
- **Client-side commit-reveal**: salt + hash computed in browser, persisted to localStorage across refresh.

## Devnet deployment

| Program | ID |
|---|---|
| mgk-perps-core | `9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT` |
| mgk-perps-matcher | `68MQqdugxZQA2F8GahhWZEusPnHbrfAXjqq2V9VCz8tK` |
| mgk-oracle | `GLAu9n48oqnVRKHNoqfpek3kZyGUJTJRPQKo7mF3qWmm` |

## Relationship to the on-chain protocol

The frontend is a **consumer** of the on-chain mgk programs (`../programs/`). It does not import Rust source — the SDK hand-rolls the BPF layout table from the design doc. See [`../docs/ai/design/2026-06-16-feature-mgk-frontend.md`](../docs/ai/design/2026-06-16-feature-mgk-frontend.md) for the on-chain account layouts and Pinocchio instruction byte format.

## CI

[![mgk-frontend CI](../.github/workflows/mgk-frontend-ci.yml)](../.github/workflows/mgk-frontend-ci.yml) — SDK build + web typecheck/lint/test/build + Playwright E2E on push/PR to main.
