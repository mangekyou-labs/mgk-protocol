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
node --test tools/runtime/harness.test.js
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
  fields: [{name: 'equity', offset: 48, bytes: 16, signed: true,
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

A cash-backed 20 SOL insurance fixture supplies both real vault lamports and its
accounting counter after the signed deposits. This isolates position settlement
from issue #23's top-up instruction and insurance-exhaustion behavior. All orders,
clearing and settlement still execute as real signed candidate transactions.
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

PostOrder (20) appends readonly Instrument and Oracle accounts after Matcher
(indices 6 and 7). ModifyRestingOrder (12) uses Portfolio, User, Book, Matcher,
Registry, Instrument and Oracle in that order. Withdraw (3) appends Instrument
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

Other
account layouts and instruction encodings remain version 1. Future protocol
layout changes must update this adapter. This coverage does not complete the
parent release gate or test insurance exhaustion. All transactions are ephemeral
local simulation; no external cluster is used. CI builds fresh SBF artifacts,
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
