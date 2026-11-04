# Issue 39: same-ID market isolation upgrade review

Status: **local candidate only; no public transaction signed or sent**.
This records the user's selected design, not approval of a particular transaction.
[ADR 0005](../adr/0005-isolate-markets-under-shared-program-ids.md) defines the
namespace. [Readiness](issue-39-readiness.md) records the pending rollout gates.

## Candidate bytes and destination

Cluster: Solana **devnet**, RPC `https://api.devnet.solana.com`.
Upgrade authority and proposed fee payer:
`GBz4U7gb3nqALmtBBYajKgngFjbEsjPzM86X7ZADPwt4`.
The legacy manifest remains unchanged; both existing program IDs are retained.

| Program | Program ID | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| Core | `9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT` | 261824 | `efa553577be98d385174a4bad64768f6e56a99cb53748c97ef2b9b6403dc588d` |
| Matcher | `68MQqdugxZQA2F8GahhWZEusPnHbrfAXjqq2V9VCz8tK` | 82376 | `def1ae6af76540bd638aecfc99ef5f6f9f3b01476a25c351aa2d625754e8c579` |

Oracle `GLAu9n48oqnVRKHNoqfpek3kZyGUJTJRPQKo7mF3qWmm` is unchanged
and requires no upgrade. Local candidate manifests pin these hashes and the
integration commit; regenerate the manifest after the final source commit.

## Capacity and rent preflight

Read-only loader-account observations at slot 518072295 verified the upgradeable
loader, ProgramData links, and authority above. Capacities exclude the 45-byte
ProgramData header.

| Program | ProgramData | Current capacity | Planned extension | Resulting capacity |
| --- | --- | ---: | ---: | ---: |
| Core | `p412a3ubFJHn8ySAgdfDFWXezJ9k2BoMZXw1So4pSGU` | 230920 | 30904 | 261824 |
| Matcher | `E7KhRLZj8p8CVhH1eqXvGwHJ7RJobTFanWqJnBt5DmuH` | 76944 | 10240 | 87184 |

Matcher uses a 10 KiB extension to accommodate the minimum extension under
SIMD-0431. Revalidate feature activation and the actual loader instruction before
building the transaction. Current Solana documentation describes capacity
extension and authority requirements in
[program deployment](https://solana.com/docs/core/programs/program-deployment)
and [deploying programs](https://solana.com/docs/programs/deploying).

RPC rent quotes and authority balance captured on 2026-11-03, balance context slot
518074660:

| Item | Lamports | SOL |
| --- | ---: | ---: |
| Authority balance | 1709878212 | 1.709878212 |
| Core permanent rent increase | 156992320 | 0.156992320 |
| Matcher permanent rent increase | 52019200 | 0.052019200 |
| Total permanent rent increase | 209011520 | 0.209011520 |
| Temporary core buffer rent | 1330904120 | 1.330904120 |
| Temporary matcher buffer rent | 419308280 | 0.419308280 |

These quotes exclude transaction fees and are not a final spending authorization.
Core buffer plus its extension needs 1.487896440 SOL before fees. Stage and
upgrade core first, refund its buffer to the fee payer, then stage matcher;
creating both buffers before either refund exceeds the observed balance.
Recipients are the two ProgramData accounts above and temporary loader-owned
buffer accounts whose public addresses must appear in the unsigned transaction
review. Buffer refunds return to the named fee payer. No application insurance
or collateral is transferred by the program upgrades.

## Proposed D′ identity and funding

Use the existing admin public key as the market seed. Scoped Initialize requires
both governance and market-identity signatures; the same admin can satisfy both.
These addresses are derived locally and **have not been provisioned**:

| Account | Proposed address |
| --- | --- |
| Market seed | `GBz4U7gb3nqALmtBBYajKgngFjbEsjPzM86X7ZADPwt4` |
| Registry | `CbwTpmDgb6KKfBpv156754dXBpCoKPyjGt1kmJAb8mtR` |
| Vault | `D1qhB6uNqWJWWfwv8SWWTFytdcAjbSH4w1YYoME1ub1k` |
| Instrument 0 | `8AofYA4NehNa9dLxQh2Gspo8Vi5a4H1m4qzGQHeQj5cZ` |
| Maker portfolio | `6e1YB5TKEGnBTj2ke8UPfTRE5jQtGBDJNrKHTk1QyGV1` |
| Batch 0 | `9cmuzYfCbiiWmysVskoc9EzTboeYidgYuSTyH72ad5pU` |
| Order book 0 | `7bbMK7jCC1V69hDbFvezdVfWvVW1LRR916AQdjLY6s9y` |

A distinct oracle account must bind this instrument. Confirm its public address,
account-creation flow, all rent, maker owner, and schema-2 manifest before signing.
The rollout plan allocates **3 SOL insurance plus 3 SOL maker collateral** to D′,
in addition to rent and fees. The observed admin balance cannot fund that budget;
additional devnet funding or a separately reviewed funder is required.

## Execution and evidence still required

1. Refresh balances, loader authority/capacity, deployed byte hashes, and default
   market snapshots. Freeze candidate bytes and public service commits.
2. Use an operator-controlled wallet or hardware signer. Build unsigned
   extension/buffer/write/upgrade transactions, show every recipient, amount,
   fee payer, cluster and fee estimate, simulate, and obtain explicit approval
   before signing/sending. Never load existing operator keypair files.
3. Upgrade sequentially, confirm next-slot activation, and verify deployed hashes
   against the table. Preserve default accounts and audit them after each upgrade.
4. Provision/fund D′ with a separate reviewed transaction set and schema-2 manifest.
   Legacy one-shot deployment/provisioning tools are not the upgrade flow.
5. Start oracle and verify fresh quorum-backed prices before keeper, maker, and
   indexer. Confirm hosted service IDs, configured manifest, storage binding,
   funded portfolios, batch progress, quotes, status, and delivered alerts.
6. Rerun **all gate evidence**, including both real D′ recovery runbooks, genuine
   insurance exhaustion and debt repayment, withdrawals-before-trading unpause,
   P0-31/P0-32/P1-4, browser artifacts, and paired invariant snapshots.

No unsigned public transaction set has been built or simulated yet. Wallet
integration, actual hosted-service records, D′ funding, and transaction-specific
approval remain prerequisites. Neither issue #39 nor its parent is complete.
