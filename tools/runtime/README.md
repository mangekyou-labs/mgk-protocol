# Candidate local-runtime harness

This harness runs candidate SBF programs in an isolated offline Surfpool 1.6.0
process. It sends signed transactions with the existing tools SDK, verifies
confirmation, and checks RPC state against exact expected values. It requires
Node 24, Python 3, Surfpool 1.6.0, and freshly built program artifacts.

From the repository root:

```sh
npm install --prefix tools --ignore-scripts --no-audit --no-fund
cargo build-sbf --tools-version v1.52
node tools/runtime/candidate.js target/deploy /tmp/candidate.json
node --test tools/runtime/harness.test.js tools/runtime/invariants.test.js tools/runtime/audit.test.js
MGK_CANDIDATE_MANIFEST=/tmp/candidate.json \
MGK_RUNTIME_REPORT=/tmp/runtime-report.json \
node --test tools/runtime/smoke.test.js
```

Record the candidate manifest separately from running it. It records the Git
commit, three program IDs, artifact paths and SHA-256 hashes. Preserve the
manifest with the build whose bytes it identifies. Startup rejects changed
bytes before starting Surfpool, loads the captured verified bytes directly,
and hashes the executable ProgramData bytes returned by RPC again. It never
reopens an artifact after verification. The report includes candidate commit,
loaded hashes, local endpoint, oracle controls, slot advances, model output and
confirmed transaction signatures. No private keys are saved. An absent manifest
or failed runtime is a failing test, never a skipped successful test.

`LocalRuntime.start({candidates, port, wsPort, reportPath, surfpool})` creates
and owns a fresh temporary runtime. Ports default to 18899/18900; the smoke
uses 18999/19000 (`MGK_RUNTIME_PORT` overrides its RPC port). An already-running
RPC endpoint is rejected. Always call `close()` in test cleanup; it terminates
all owned worker processes and the validator and removes temporary storage.

`setAccount(address, {owner, lamports, data})` supplies genesis fixtures.
`setOracle(address, {owner, authority, instrument, price, publishTime,
confidence, active, bump})` controls the version-1 oracle fields (discriminator 9, layout version 1). Program IDs come
from `deployments/devnet.json`.
`advanceSlots(count)` requests and observes an absolute clock advance.
`send(label, instructions, signers)` signs, simulates with signature verification,
sends and waits for successful confirmation. `launchWorker(command, args,
options)` starts a real child process with `RPC_URL` pointing at this runtime;
the caller can inspect its exit status or run the repository's worker entrypoint.

`assertState` accepts caller-supplied model outputs. It contains no protocol
arithmetic:

```js
await runtime.assertState([{
  address: portfolio,
  owner: coreProgramId,
  lamports: '10000000',
  fields: [{name: 'equity', path: 'equity',
    value: model.collateral[wallet]}],
}]);
```

Integers may be decimal strings, BigInts or safe JavaScript integers. Unsafe
numeric expected values and unsafe JSON RPC lamport values fail explicitly;
account fields retain their full signed or unsigned width. A one-lamport or
one-field discrepancy fails the assertion.

The smoke seeds zeroed account storage, then executes the candidate oracle and
signed initialize, portfolio creation, deposit, order posting, batch closing,
clearing and settlement instructions. Each batch decodes the actual matcher
fills in cleared-results order and passes them to the independent issue-14
Python `Fraction` ledger. Nine batches cover a same-price roundtrip, opening
without exchanging notional cash, fractional weighted entry, partial reduction,
flipping, closing, and two opposite auctions within one batch. Conversion prices
vary independently of fill prices.

After every settlement it compares both portfolios' collateral, quantized
entry and quantity, cumulative realized USD, cumulative realized lamports, fees,
and zero funding with the model. It also compares insurance-fund accounting,
vault balance and physical lamports. Exact fractional realized USD is converted
to lamports before rounding: credits round down and debits round up. The i128
micro-USD display counter separately sums the floor of each realized event,
including negative events; quantizing that counter must not affect conversion.

The insurance fund is seeded by a signed TopUp (26) of 20 SOL from a funder
wallet, the same permissionless path production uses; there is no genesis
fund patching. The vault is created with exactly the rent-exempt minimum for
its 80 bytes (queried through `getMinimumBalanceForRentExemption`), and every
assertion checks the exact invariant `vault lamports - rent = total collateral +
fund - uncovered_bad_debt` with zero tolerance. Vault layout v2 stores total
collateral at byte 8, the fund at 16, uncovered bad debt at 32, long and short
open interest at 48 and 56. The pause-flags byte of the registry (89) is
compared as well. All orders, clearing and settlement execute as real signed
candidate transactions.

After the settlement scenarios a third trader joins and the smoke walks the
issue #23 acceptance flow against the Python reference ledger: a winner
withdraws realized profit (paid in cash from the fund) while its loser is still
open; governance withdraws exactly the fund surplus above 0.4 x larger-side
open interest (rejecting surplus + 1 with 611 and a non-governance signer with
7); the 10 SOL portfolio exposure limit (608), the 50 SOL per-side market exposure limit (609, the vault
open-interest counter is patched to 49_999 and then restored) and risk-off
(610) reject exposure-adding posts while reduce-only posts and withdrawals
still simulate successfully; an exhaustion settlement (fill above the post-time
oracle, then an oracle drop) credits the winner in full, records the unpaid amount
as uncovered bad debt and auto-pauses trading and withdrawals (602 for new
exposure and withdrawals); top-ups repay debt before the fund; Unpause (28)
is refused with debt outstanding (612), resumes withdrawals first, and only
then trading; finally a one-lamport donation straight to the vault breaks the
invariant so that a top-up and a withdrawal both revert with 607. The cached
risk fields (IM, MM, withdrawable collateral, health) are compared only for portfolios
that settled or withdrew at the current price, because other portfolios keep
the value cached at their last refresh.

The smoke checks invalid oracle boundaries, submits a stale-oracle transaction,
compares all protected account bytes and lamports after rollback, and successfully
retries with a fresh oracle. It also checks deliberate mismatch rejection and
runs a child process against RPC.

The smoke adapter uses Portfolio version 3 (2848 bytes): collateral at byte 48,
realized USD/lamports at 80/96, fees/funding at 112/128, position count at 208,
and 40-byte positions at 216. Entry is an integer floor plus an unsigned
remainder/denominator; a zero denominator denotes an integer entry. Otherwise
the denominator is exactly 10^12 units per micro-USD (10^-18 USD quantum).
Grows quantize the weighted average of the stored entry and fill price: ceil
for longs, floor for shorts. Each grow adds less than one quantum of rounding
error toward the protocol; reductions retain the entry. The Python Fraction
ledger implements that policy independently before cashflow conversion.

Portfolio version 3 appends total reserved collateral at byte 2048, oracle-priced
unrealized PnL at 2064, and twelve 64-byte order reservation records at 2080.
Each record stores order ID, original/remaining quantity, limit price, original
reservation, instrument, side and reduce-only flag. This provenance survives
matching and is consumed by settlement; old version-2 portfolios must be
recreated for the restricted demo.

PostOrder (20) appends readonly Instrument, Oracle and Vault accounts after
Matcher (indices 6, 7 and 8). ModifyRestingOrder (12) uses Portfolio, User, Book,
Matcher, Registry, Instrument, Oracle and Vault in that order. The vault gate
(608, 609, 610) applies only to non-reduce-only posts and modifications. Withdraw (3) appends Instrument
and Oracle after Registry when a position or reservation is present; flat
portfolios without orders can withdraw without oracle accounts. Cancellation
releases the recorded reservation without requiring a fresh oracle.

IM is 20% and MM is 10% at the conversion price. Non-reduce-only orders reserve
IM on quantity times the greater of limit and conversion price, plus the worst
5-bps fee; reduce-only orders reserve only that fee. Remaining reservations
round upward after proportional release. Withdrawable collateral deducts
unrealized losses, position IM and reservations; unrealized gains contribute
only to maintenance health. Settlement clips reduce-only quantities in fill
order and trims the opposing auction side to conserve base quantity. Excess
reduce-only quantity and its resting remainder are cancelled.

Synthetic cleared-results fixtures without reservation provenance are rejected
by the runtime. Long grow/reduce arithmetic stress remains covered through the
native transition seam; signed runtime coverage uses authenticated posted
orders and matcher output.

Other account layouts and instruction encodings remain version 1. Future protocol
layout changes must update this adapter. This coverage does not complete the
parent release gate. The issue #24 takeover additionally runs in the real-SBF
BanksClient lifecycle suite against `tools/gate/takeover_scenario.py`; it covers
partial and full liquidation, opposite liquidator positions, fund exhaustion,
10,000-lot compute bounds, oracle/account rejection and atomic cancellation
rollback. Run it after rebuilding artifacts:

```sh
BPF_OUT_DIR="$PWD/target/deploy" cargo test -p mgk-perps-core --test lifecycle --all-features test_e2e_takeover -- --test-threads=1
```

All transactions use ephemeral local simulation; no external cluster is used. CI builds fresh SBF artifacts,
records their hashes, runs these tests and uploads the candidate manifest and
runtime report even when the smoke fails.

Issue #21 integrity coverage executes rejected transactions and compares all
protected protocol account bytes and lamports afterward. It covers every direct
matcher discriminator, a forged matcher-owned book, the wrong matcher program,
a forged results PDA, a thirteenth live order, re-clearing, missing or duplicate
portfolios, malformed portfolio counts, wrong-batch or spent results, and replay
of a settled batch. A withdrawal rejects while the batch is Cleared and succeeds
in simulation after settlement. Rejection transactions use a unique compute-unit
price so they cannot reuse a prior successful transaction's signature.

Batch status 4 is Cleared; status 2 means ready to clear. Matcher results retain
the version-1 account header and add a 9-byte envelope before the DFBA payload:
batch ID at byte 8, spent at byte 16, fill count at byte 49, and 58-byte fills
starting at byte 51. Clear writes its own batch's results once. Settlement marks
those results spent through authenticated matcher CPI. Settlement also authenticates each fill against its recorded order reservation.

The harness unit suite serializes a signed legacy SettleBatch transaction with
12 distinct portfolio accounts, the next-batch allocation payer/System accounts,
and a compute-budget instruction, and asserts it fits the 1232-byte packet limit.
This is the transaction-size justification for the 12-live-order book cap.

The standalone keeper scripts now derive the batch results PDA and forward its
allocation payer and writable accounts. Their older account decoding and full
worker migration remain separate work tracked by issue #28; this runtime test
executes the candidate instructions directly.

## Invariant checker (issue #26)

`tools/runtime/invariants.js` checks six protocol invariants from decoded RPC
state (SDK layout decoders, canonical PDAs only; forged non-PDA accounts are
ignored):

1. **vault balance**: vault lamports + uncovered bad debt cover rent + recorded
   collateral + insurance fund. A single snapshot tolerates surplus because
   anyone can donate lamports to the vault. Per transaction the check is
   exact: when every instruction belongs to perps core or the matcher (compute
   budget aside), vault lamports move by exactly the change in collateral +
   insurance fund - uncovered bad debt. A transaction with any other
   instruction (e.g. a system transfer) may only add lamports beyond that.
   Once the protocol is initialized (registry initialized, or any portfolio
   or batch exists), a missing, foreign-owned or uninitialized vault fails.
2. **per-auction signed base quantity sums to 0**, for every results account.
3. **fills never exceed eligible submitted size**: each fill in a cleared,
   unspent batch matches one live accepted order of the same user and side,
   at most once, with quantity no larger than its remaining size.
4. **each receipt applied exactly once**: cleared batches have unspent results,
   settled batches have spent results with the same batch ID, and neither
   settled status nor the spent flag ever reverts.
5. **a valid reduce never increases exposure**: when results are applied, for
   each user and instrument with a reduce-only fill, the settled position lies
   within `[min(q0, 0) + plain sells, max(q0, 0) + plain buys]`: plain fills
   move the position exactly and reduce-only fills move it toward zero without
   crossing, in any order. This also covers users with mixed fills.
6. **no withdrawable balance is negative**: a transaction that lowers
   principal or raises reservations, or a flat portfolio without orders, never
   leaves negative withdrawable collateral. Withdrawable collateral is a cached
   signed value. It legitimately goes negative after an adverse mark, an
   initial-margin change at settlement, or while a portfolio awaits
   liquidation, so it is not required to be non-negative everywhere.

Supplementary checks report under their own names, not a gate invariant's:
**portfolio equity is never negative**, **vault collateral equals total
portfolio equity**, **open interest equals settled positions** and **settled
positions net to zero per instrument**.

`LocalRuntime.send` snapshots state immediately before each transaction and
checks it after confirmation, so test-only `setAccount` patches between sends
are not attributed to a transaction. It passes the transaction's instruction
program IDs so the vault check can tell protocol instructions from donations.
The checked programs come from the verified candidate artifacts loaded into
the runtime, or from the `programs` constructor argument. A failure throws
`InvariantViolation` with the message `invariant "<name>" violated after
transaction "<label>" (<signature>): ...` and records the violations in the
runtime report entry.

The standalone end-of-run audit is read-only: its RPC client accepts only
`getProgramAccounts`, `getMultipleAccounts`, `getAccountInfo`,
`getMinimumBalanceForRentExemption` and `getSlot`, and it loads no keys.

```sh
node tools/runtime/audit.js                       # devnet, deployments/devnet.json
node tools/runtime/audit.js --rpc URL --deployment path/to/deployment.json
node tools/runtime/audit.js --rpc URL --deployment "$MGK_CANDIDATE_MANIFEST"
```

`--deployment` accepts a deployment file (`programs.perps_core`,
`programs.perps_matcher`) or a candidate manifest (`mgk_perps_core`,
`mgk_perps_matcher` entries). The CLI prints a JSON report (invariant and
supplementary check statuses, account counts, violations) and exits 1 on any
violation, 2 on RPC or usage errors. A check with nothing to evaluate in the
snapshot is reported as `not evaluable` with a reason, never as a vacuous
`pass`. Invariant 5 always needs the state before and after a settling
transaction, so the audit cannot evaluate it. The smoke runs the same CLI
against the local runtime and the candidate manifest at the end of the run.
Tests use local fixtures and never contact devnet.

Scenario drivers (#35, #39, #40) import the audit instead of spawning the CLI:

```js
const { auditScenario } = require('./tools/runtime/audit');
await auditScenario('liquidation cascade', { rpcUrl, deployment: manifestPath });
// or { rpc, programs: { core, matcher } }
```

It resolves to the report, or throws `InvariantViolation` with the message
`invariant "<name>" violated after scenario "<scenario>": ...`.

Results fixtures in `invariant-fixtures.js` start from the matcher serializer
bytes (`resultsLayout.fixture`). Field offsets are found by probing the SDK
decoder, so there is no second encoder to drift from the wire contract.
