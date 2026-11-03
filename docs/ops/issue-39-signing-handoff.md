# Issue 39: signing handoff for the same-ID upgrade and D′

Status: **preflight refreshed, unsigned sequence built and simulated.
No transaction signed or sent. This document is not transaction approval.**
Candidate: integration `4cc4cda` (CI green). Program bytes are identical to
the `caeb0c3` candidate (`cargo build-sbf` at `4cc4cda` reproduces the pinned
hashes), so the [upgrade review](issue-39-upgrade-review.md) costs stand.

## Refreshed preflight (read-only, 2026-11-03)

RPC `https://api.devnet.solana.com`, balances at slot 518119413, default-market
snapshot at slot 518120029.

| Item | Value |
| --- | --- |
| Upgrade authority / fee payer | `GBz4U7gb3nqALmtBBYajKgngFjbEsjPzM86X7ZADPwt4` — 1.709878212 SOL |
| Core program (data len / deployed SHA-256) | `9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT` — 230920 B / `877f54a2…` |
| Matcher program (data len / deployed SHA-256) | `68MQqdugxZQA2F8GahhWZEusPnHbrfAXjqq2V9VCz8tK` — 76944 B / `42d6da55…` |
| Candidate SHA-256 (core / matcher) | `efa55357…` (261824 B) / `def1ae6a…` (82376 B) |
| Keeper / oracle / maker fee payers | 0.5 / 0.5 / 1.0 SOL (health floor 0.01 SOL) |
| Default registry / instrument / oracle / vault | 94 / 352 / 128 / 80 B, owners as manifest; vault 20.001 SOL lamports total |

Default market is untouched and must stay that way: the upgrade changes only
executable bytes, then the default accounts are audited.

## Unsigned upgrade sequence (devnet)

Builder: `node tools/build-upgrade-txs.js --out <dir> [--buffer-core <pubkey>]
[--buffer-matcher <pubkey>]`. It never signs, sends, or loads a keypair.
Buffer pubkeys in a preflight build are placeholders; the operator generates
real buffer keypairs and rebuilds before signing. Recent blockhashes expire,
so the signing-day build is the authoritative artifact — amounts, accounts
and instruction order do not change.

| # | Action | Recipient / accounts | Lamports from authority | Signers | Simulation now |
| --- | --- | --- | ---: | --- | --- |
| 1 | ExtendProgram core (+30904 B → 261824) | ProgramData `p412a3ub…` | 156,992,320 | authority | `err: null` |
| 2 | CreateBuffer core (261861 B) | new buffer (operator keypair) | 1,330,904,120 (refunded at #4) | authority + buffer | `err: null` |
| 3 | Write core, 262 txs × 1000 B | buffer | 0 (+ fees) | authority | after #2 is sent |
| 4 | Upgrade core | ProgramData + program; spill = authority | 0 | authority | after #3 completes |
| 5 | ExtendProgram matcher (+10240 B → 87184) | ProgramData `E7KhRLZj…` | 52,019,200 | authority | `err: null` |
| 6 | CreateBuffer matcher (82413 B) | new buffer (operator keypair) | 419,308,280 (refunded at #8) | authority + buffer | `err: null` |
| 7 | Write matcher, 83 txs × 1000 B | buffer | 0 (+ fees) | authority | after #6 is sent |
| 8 | Upgrade matcher | ProgramData + program; spill = authority | 0 | authority | after #7 completes |

Estimated base fees: 1,765,000 lamports total (5000/signature, no priority
fee). Peak authority spend is the core phase: 1,487,896,440 lamports plus
write fees, leaving ≈0.220 SOL — feasible at the observed balance. After both
upgrades and refunds the authority retains ≈1.499 SOL before D′ funding.

Equivalent operator path: Solana CLI 3.1 in the operator's own terminal
(`solana program extend`, then `solana program deploy --program-id`) with
`-k` pointing at the operator's signer (hardware wallet URL or a keypair file
only the operator touches). The CLI builds the same loader instructions; the
reviewed unsigned set above remains the amount/account reference.

## Funding gap after the upgrade

D′ needs 3 SOL insurance + 3 SOL maker collateral (rollout budget), ≈0.054 SOL
of account rent (registry 94 B, vault 80 B, instrument 352 B, portfolio 2848 B,
batch 176 B, book 3128 B, oracle 128 B) and small fees: ≈6.06 SOL against
≈1.499 SOL available. **Shortfall ≈4.56 SOL** must be sourced (faucet/airdrop
to the authority or a separately reviewed funder) before D′ provisioning.
Worker fee-payer top-ups to the original rollout targets (keeper/oracle 2 SOL
each) are separate and not required by the health floor.

## What happens after approval

1. Operator signs/sends steps 1–8 sequentially; each upgrade is confirmed and
   the deployed hash re-dumped and compared to the candidate table.
2. Default-market accounts are re-snapshotted and audited unchanged.
3. D′ provisioning is built as a separate reviewed unsigned set (scoped
   Initialize with governance + market-identity signatures, bound distinct
   oracle, schema-2 manifest), simulated, and approved separately.
4. Hosted workers start oracle → keeper → maker → indexer against the schema-2
   manifest; only then are D′ gate rows (P0-31, P0-32, P1-4 and the rerun of
   every gate invalidated by the upgrade) executed and evidenced.

The PR stays draft and issue #39 stays open until those gates pass with live
evidence. Design approval recorded earlier is not approval of these
transactions.
