# SOL devnet demo: implementation and rollout plan

Execution handoff for [Plan a reliable SOL devnet perpetuals demo](https://github.com/mangekyou-labs/mgk-protocol/issues/3), agreed in [Agree the implementation and rollout handoff](https://github.com/mangekyou-labs/mgk-protocol/issues/12) on 2026-10-23. This is a plan for review. Nothing here has been implemented, deployed or sent. Implementation issues are created only after the user has reviewed this plan.

The contracts this plan implements live in the map's closed tickets and in ADRs 0001–0004, synthesized in [Spec: Reliable SOL devnet perpetuals demo](https://github.com/mangekyou-labs/mgk-protocol/issues/13). This document gives order, dependencies and checkpoints. It does not restate those contracts.

## Ground rules

- **Baseline.** Current master, `1cd9557` (settlement transition refactor). This replaces `25951f3` from "Establish the recovery baseline". Each ticket branches from master and lands as its own PR to master. There is no long-lived release branch.
- **Experimental worktree.** `.worktrees/feature-sol-devnet-recovery` (uncommitted, on `25951f3`) is reference only. Nothing is merged or cherry-picked as a whole. Useful ideas are rewritten, with new tests, inside the ticket that owns them:
  - `confirmTransaction.ts` → S1
  - decoder fixes in `onchainAccounts.ts` → S1
  - keeper offset fixes → W2

  Its `settle_batch.rs` / `linear_perp.rs` changes are replaced by `1cd9557` plus the accounting contract. Once this plan is accepted, the user deletes the worktree.
- **Sizing.** Measured in agent sessions: S = 1, M = 2–3. Anything larger is split when its issue is created.
- **CI on every PR.** `cargo clippy --all-targets --all-features -- -D warnings`, then `cargo test --all-features`, plus the frontend CI.

## Phases and checkpoints

```
Phase 0 ─┬─ G1 reference model ─────────────────────────────┐
         └─ R1 provisioning (HITL) ─────────────────────────┤
Phase 1   P1 → {P2, P6} → P3 → P4 → P5 → [A: layout freeze] │
Phase 2   S1, W1, W2, W3, I1, F1, G2, G3, G4, G5, O1 ───────┤
          [B: release candidate] ◄──────────────────────────┘
Phase 3   R2 deploy → R3 workers + D′ + rehearsals → R4 gate → R5 sign-off
```

### Phase 0: start now (no dependencies)

| Id | Ticket | Size | Notes |
|---|---|---|---|
| G1 | Independent reference model | M | Python, stdlib only, integer / `Fraction` arithmetic, in `tools/gate/`. Written only from the accounting, margin and reserve contracts, so it shares no code with the programs or SDK. Input: observed fills and conversion prices. Output: expected lamports per account. Must reproduce the four stress vectors exactly. |
| R1 ✋ | Provisioning | S (HITL) | User: one dedicated devnet RPC provider (a separate API key per service), three paid Render workers (~$21/mo), generating the five keys (admin kept offline), sourcing devnet SOL per the budget below. Secrets go only in Render/Vercel env, never in tickets. |

### Phase 1: programs, ending at Checkpoint A

| Id | Ticket | Size | Depends on |
|---|---|---|---|
| P1 | Fresh program IDs for perps-core, matcher and oracle; a discriminator + layout-version byte on every account, checked on load; deployment-manifest schema | M | — |
| P2 | SOL-collateral accounting in the `1cd9557` transition module: position-only settlement, weighted entry, realize on reduce/flip, USD→lamports at a validated oracle price (fail closed), protocol-favoring rounding, 5 bps taker / 0 maker, funding off | M | P1 |
| P6 | Oracle program/config: real-dispersion confidence, 60 s staleness, `t_max_slots = 25` | S | P1 |
| P3 | Margin and order safety: 5× / 20% IM / 10% MM at the oracle price, order reservations, reduce-only clipped at settlement, limit GTC only (other paths removed), authenticated and batch-bound clear/settle, matcher `user` authorization, withdrawals blocked while a batch is Cleared | M | P2 |
| P4 | Reserve: the insurance fund as cash-backed counterparty, 10 SOL per-portfolio / 50 SOL per-side caps, risk-off below 0.4 × OI, uncovered debt + auto-pause, admin-only unpause (withdrawals first), vault balance check after every lamport move | M | P3 |
| P5 | Takeover liquidation in 25% steps, liquidator IM check, 1% + 1% penalties, insurance then pause (no ADL) | M | P4 |

**Checkpoint A: layout freeze.** All account layouts, version bytes and instruction formats are frozen in one shared layout module, with fixtures generated from the programs. After A, a layout change means re-opening A and re-doing every Phase 2 consumer, so it needs explicit user approval.

### Phase 2: in parallel after Checkpoint A

| Id | Ticket | Size | Notes |
|---|---|---|---|
| S1 | SDK: decoders from the layout module, ported `confirmTransaction` (no false success), manifest loader | M | Not a wholesale SDK migration |
| W1 | Oracle worker: Pyth Hermes / Coinbase / Kraken, 2-of-3 within 50 bps, publishes every 10 s, publishes nothing without quorum | S | Uses the oracle authority key only |
| W2 | Keeper: stateless and idempotent, current batch derived from the registry counter, retry with backoff, halts on a missing batch, polls every 2 s | M | Stays on the JS stack; decoders from S1 |
| W3 | Protocol maker: two-sided maker GTC ladder (±0.3%, 3 levels) within its limits, stops when the price is invalid, liquidator of last resort | M | |
| I1 | Indexer: manifest-driven, backfill from the start slot, `BATCH_ADDRESS` and `BACKFILL_SLOTS=1000` removed, `/api/status` computed from chain | M | Off the trading-critical path |
| F1 | Trade screen per "Choose the minimal trader interface": readiness checklist, cluster/manifest guard, lifecycle states, unknown ≠ 0, extras removed, "earlier devnet balances not carried over" | M | Balances and orders from RPC; only history from the indexer |
| G2 | Invariant checker (the six invariants of the acceptance gate) | S | Per transaction locally, per scenario + end-of-run on devnet |
| G3 | Local-runtime harness: local validator loading the candidate `.so` files by hash, the real workers, a controllable oracle | M | Runs all L rows |
| G4 | Playwright suite against a deployed Vercel build with an injected test wallet; a trace and screenshot per lifecycle state | M | Extends `tools/playwright-cli-inject.js` where it fits |
| G5 | Report template (`docs/acceptance/<date>-<commit>.md`), latency recorder (p95 accepted, p50/max settled), 2 h soak driver | S | |
| O1 | Ops: `render.yaml` (keeper/oracle/maker workers, `autoDeploy: false`, pinned commits), one checked-in deployment manifest shared by every service, uptime monitor on `/api/status`, the two runbooks (Cleared > 2 min; insurance exhausted) | M | Alert channel and floor values are set here |

**Checkpoint B: release candidate.** Minimum validation before any devnet deploy:
1. CI is green on the candidate commit.
2. Every L-tier gate row passes in G3 on the candidate `.so` hashes, and the report records those hashes.
3. The manifest, workers and frontend build from the same commit.

### Phase 3: rollout (exactly one devnet program deploy)

| Id | Step | Who |
|---|---|---|
| — | **At any time:** put a truthful maintenance banner on production Vercel (demo being rebuilt; earlier balances not carried over) | Agent ships it; user approves the production change |
| R2 ✋ | Deploy the three programs at the B hashes; init the registry, instrument and oracle config; seed the insurance fund with 20 SOL; record the program IDs, addresses and start slot in the manifest | User signs with the admin key |
| R3 | Start the oracle worker (wait for green), then the keeper, the maker and the indexer. Create D′ under the same program IDs (✋ admin funds it). Rehearse both runbooks on D′ (✋ admin pause/unpause). Run the D′ rows. | Agent, plus the user's admin signatures |
| R4 | Deploy the new frontend to a **Vercel preview**. Run the D and D (browser) rows against it, the latency run (≥ 30 taker orders over ≥ 30 min, including a cold start) and the 2 h soak. User runs the M checklist with a real wallet extension. | Agent; user for M |
| R5 ✋ | User reviews the report and signs off. **Promote that same preview build** to production (no rebuild). | User |

The existing deployment (`C7w2…` / `7WiZ…` / `CsSq…`) is abandoned. It is neither closed nor drained.

### Gate failures

- **Off-chain fix** (worker, indexer, frontend): redeploy the fix as a pinned commit, re-run the affected rows and restart the 2 h soak. A frontend-only redeploy voids only the browser rows.
- **Any program redeploy:** voids all evidence. Return to Checkpoint B and restart the whole gate.
- **Layout change:** also needs a new demo market (ADR 0004). Pause, fix forward, redeploy.

## Rollback

- **Frontend:** Vercel instant rollback to the previous production deployment, i.e. the maintenance banner.
- **Workers:** redeploy the previous pinned commit.
- **Programs:** keep the previous verified `.so` and its hash. Redeploy only if layout-compatible; otherwise pause and fix forward.

## Devnet SOL budget (~55 SOL)

| Item | SOL |
|---|---|
| Program deploys, including temporary buffers (refunded) | ~8 |
| Insurance fund seed | 20 |
| Protocol maker collateral | 10 |
| D′ fund + D′ maker | 3 + 3 |
| Golden-path and QA wallets | 5 × 1 |
| Keeper and oracle fee payers | 2 × 2 |
| Margin | ~2 |

Sourcing this from the faucet takes several days, so R1 starts now.

## User actions and approvals

1. R1: create the RPC provider and Render accounts; approve ~$21/mo; generate and keep the admin key offline; source the devnet SOL.
2. Approve the production maintenance banner.
3. R2: sign the three program deploys, the protocol init and the 20 SOL insurance seed.
4. R3: fund D′; sign the pause/unpause rehearsals.
5. R4: run the manual real-wallet checklist.
6. R5: sign off on the gate report and promote the preview build.
7. Approve any layout change after Checkpoint A.

Agents never hold the admin key.
