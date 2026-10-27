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
  fields: [{name: 'equity', offset: 32, bytes: 16, signed: true,
    value: model.collateral[wallet]}],
}]);
```

Integers may be decimal strings, BigInts or safe JavaScript integers. Unsafe
numeric expected values and unsafe JSON RPC lamport values fail explicitly;
account fields retain their full signed or unsigned width. A one-lamport or
one-field discrepancy fails the assertion.

The smoke seeds zeroed account storage, then executes the candidate oracle and
signed initialize, portfolio creation, deposit, order posting, batch closing,
clearing and settlement instructions. It decodes observed matcher fills and
passes them to the independent issue-14 Python reference ledger, then compares
RPC collateral, insurance fund and vault lamports with its outputs. Both sides
roundtrip at the same price and a $1 conversion price, where the baseline fee
units coincide with the reference model. It also changes oracle fields, advances
slots, checks deliberate mismatch rejection and runs a child process against RPC.

This verifies the current legacy lifecycle and harness integration. It does not
establish the later restricted-demo accounting rules or complete the parent
release gate. Version-1 wire layouts and instruction encodings live in the
harness adapter and smoke; future protocol layout changes must update them.
All transactions are ephemeral local simulation; no external cluster is used.
CI builds fresh SBF artifacts, records their hashes, runs these tests and uploads
the candidate manifest and runtime report even when the smoke fails.
