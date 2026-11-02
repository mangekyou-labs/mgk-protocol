# Acceptance gate report template

Copy this file to docs/acceptance/<date>-<commit>.md for a run, then pin it to the run candidate manifest: replace the commit, cluster, program IDs and .so SHA-256 values below with the manifest values and record each row result at its required tier. Only a pass at the required tier counts: a pass or fail recorded at any other tier (or with no tier) renders as not run with a recorded-tier note. Unrun rows stay not run.

Rows are supplied to the report generator as JSON: an array of `{id, status, tier, batchIds?, signatures?, preSnapshot?, postSnapshot?, expected?, observed?, notes?}` (status `pass`, `fail`, or `not run`). Evidence renders batch ids as `batches: …`, signatures as `signatures: …`, snapshots as `pre: …` / `post: …`, and values as `expected: …` / `observed: …`. Raw JSON snapshots are CI artifacts.

- Commit: `<commit>`
- Cluster: <cluster>

## Programs

| Program | Program ID | .so SHA-256 |
|---|---|---|
| mgk_oracle | `<programId>` | `<sha256>` |
| mgk_perps_core | `<programId>` | `<sha256>` |
| mgk_perps_matcher | `<programId>` | `<sha256>` |

Local (L) rows are proved on identical bytecode locally, not observed on devnet.

## Gate rows

| Row | Scenario | Required tier | Result | Evidence |
|---|---|---|---|---|
| P0-1 | Fresh wallet deposit 0.2 SOL: vault and collateral each rise by exactly 200,000,000 lamports; wallet delta reconciles; balance survives reload | D | not run |  |
| P0-2 | Signing rejected, insufficient fee SOL or double click: no false success and no duplicate; retry path shown | M | not run |  |
| P0-3 | Wrong cluster or manifest mismatch: signing blocked with an actionable message; no retry loop | D (browser) | not run |  |
| P0-4 | Withdraw when flat: exact amount leaves the vault; second withdrawal and over-withdrawal reject | D | not run |  |
| P0-5 | Post an order, then withdraw before it fills: withdrawal capped by the reservation | D | not run |  |
| P0-6 | Three-wallet golden path (deposit, post, fill, partial close, full close, withdraw): exact reference-model lamports for realized PnL, 5 bps taker fee and fund delta; vault balance check holds | D | not run |  |
| P0-7 | Both auctions in one batch: each clears at its own uniform price; maker role set by designation, not arrival time | D | not run |  |
| P0-8 | Crossed taker/taker or maker/maker orders: no fill | L | not run |  |
| P0-9 | Partial fill, then a fill in the next batch: filled + remaining = submitted; no duplicate fill | D | not run |  |
| P0-10 | Cancel an unfilled or partially filled order: only the remainder cancels; reservation released pro rata; settled fills untouched | D | not run |  |
| P0-11 | Cancel racing clear, cancelling another user's order, or a direct matcher call with an arbitrary user: exactly one chain-consistent outcome; unauthorized calls reject | L | not run |  |
| P0-12 | Add, partial close, full close, flip: correct weighted entry, realized/unrealized split and new entry after the flip; flat positions deleted | D | not run |  |
| P0-13 | Two concurrent reduce-only closes, or a stale reduce-only order after the position closed: each fill clipped to the remaining position, excess cancelled, nothing opens or flips | D | not run |  |
| P0-14 | Margin limits (insufficient withdrawable collateral, over 5x, over the 10 SOL position cap, or over the 50 SOL/side open-interest cap): rejected at post with the stated reason; settlement never rejects for margin | L | not run |  |
| P0-15 | Withdrawal while a batch is Cleared but unsettled: blocked globally; works again after settlement | L | not run |  |
| P0-16 | Oracle boundaries (age 60/61 s, confidence 1%/1%+, future-dated, wrong owner or instrument, inactive): settlement reverts with nothing applied and the keeper retries; posts, non-flat withdrawals and liquidation blocked; a flat portfolio can still withdraw | L | not run |  |
| P0-17 | Liquidation of a healthy, health = 0 and unhealthy account: the first two reject; the unhealthy one has its orders cancelled, then is taken over in 25% steps with the liquidator initial margin checked each step; 1% + 1% penalties; value conserved | L | not run |  |
| P0-18 | Bad debt within the fund: absorbed by the fund; balance check holds | L | not run |  |
| P0-19 | Stress 1 and 2 (oracle $110 to $120, and the reverse): conversion drift of exactly -0.000758 / +0.000758 SOL to the fund | L | not run |  |
| P0-20 | Stress 3: winner withdraws before the loser closes: winner paid at once; loser stays locked | L | not run |  |
| P0-21 | Stress 4 exhaustion: winner credited in full; uncovered_bad_debt recorded; both pauses apply; debt paid off first; admin can only unpause after recovery | L | not run |  |
| P0-22 | Risk-off below 0.4 x open interest: orders adding exposure reject; cancels, reduce-only orders, settlement, liquidation and withdrawals still work | L | not run |  |
| P0-23 | Insurance top-up by anyone moves real lamports; fund withdrawal by a non-admin, or below the required reserve, rejects | L | not run |  |
| P0-24 | Settlement with a missing or duplicate portfolio: the whole batch reverts | L | not run |  |
| P0-25 | Clear run twice, settle run twice, or settling with another batch results: all rejected | L | not run |  |
| P0-26 | Batch at the order cap: all involved portfolios settle in one transaction | L | not run |  |
| P0-27 | Removed paths unreachable (market, IOC, post-only, commit/reveal, ComputeClearing, ClearAndMatch); maker_fee_bps < 0 rejects; funding never accrues | L | not run |  |
| P0-28 | Keeper killed after clear and before settle: restarts and settles once; the next batch appears | D | not run |  |
| P0-29 | Two concurrent keepers: no double processing; a missing batch account: keeper halts and alerts, with no fallback to an older batch | L | not run |  |
| P0-30 | Indexer cold start or down: trading and balances stay truthful from RPC; UI shows unavailable, never 0; history backfills from the start slot with no duplicates | D | not run |  |
| P0-31 | Oracle worker stopped, maker stopped, or fee SOL below floor: fails closed after 60 s; each status check fires; UI banner shows; everything recovers when restored | D′ | not run |  |
| P0-32 | Both runbooks rehearsed with the admin key: Cleared > 2 min, and exhaustion: unpause withdrawals first | D′ | not run |  |
| P0-33 | Latency: at least 30 taker orders over at least 30 minutes including a cold start; accepted p95 <= 5 s; settled p50 <= 20 s and max <= 60 s | D | not run |  |
| P0-34 | UI truthfulness: lifecycle states, chart labelled not executable, unknown is never 0, a reason on every blocked action, restricted-demo omissions, earlier devnet balances not carried over | D (browser) | not run |  |
| P0-35 | 2 h soak (about 700 batches) with the maker quoting and a scripted taker: end-of-run audit clean; no stuck Cleared batch; no missing batch | D | not run |  |
| P1-1 | Wallet switch, reconnect and reload with no stale data | M | not run |  |
| P1-2 | DFBA paper vectors: marginal pro-rata and identical-price allocation, with deterministic dust | L | not run |  |
| P1-3 | Adversarial and overflow inputs at the order cap | L | not run |  |
| P1-4 | Pause banner and paused-state UI in the browser | D′ | not run |  |
