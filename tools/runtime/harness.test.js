'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { verifyArtifacts } = require('./harness');

test('candidate artifact bytes must match the externally supplied SHA-256', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgk-hashes-'));
  try {
    const path = join(dir, 'candidate.so');
    writeFileSync(path, Buffer.from('\x7fELFcandidate'));
    const sha256 = createHash('sha256').update(require('node:fs').readFileSync(path)).digest('hex');
    const candidate = [{ name: 'oracle', path, programId: 'CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ', sha256 }];
    assert.equal(verifyArtifacts(candidate)[0].sha256, sha256);
    writeFileSync(path, 'replaced');
    assert.throws(() => verifyArtifacts(candidate), /SHA-256 mismatch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('exact assertions reject rounded JavaScript numeric model outputs', async () => {
  const { LocalRuntime } = require('./harness');
  const runtime = new LocalRuntime(18997);
  runtime.account = async () => ({ lamports: 9007199254740992n, data: Buffer.from(require('../../mgk-frontend/packages/layout').layouts.Portfolio.fixture) });
  await assert.rejects(runtime.assertState([{ address: 'fixture', lamports: 9007199254740992 }]), /safe integer/);
  await assert.rejects(runtime.assertState([{ address: 'fixture', fields: [
    { name: 'equity', path: 'equity', value: 9007199254740992 },
  ] }]), /safe integer/);
});

test('missing validator executable rejects and cleans up without hanging', { timeout: 3000 }, async () => {
  const { LocalRuntime } = require('./harness');
  const dir = mkdtempSync(join(tmpdir(), 'mgk-start-'));
  try {
    const path = join(dir, 'candidate.so');
    const bytes = Buffer.from('\x7fELFcandidate');
    writeFileSync(path, bytes);
    await assert.rejects(LocalRuntime.start({ port: 18997, surfpool: join(dir, 'missing'), candidates: [
      { name: 'oracle', path, programId: 'CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ',
        sha256: createHash('sha256').update(bytes).digest('hex') },
    ] }), /ENOENT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('twelve distinct filled portfolios settle within one legacy transaction packet', t => {
  const { Keypair, Transaction, TransactionInstruction, ComputeBudgetProgram, SystemProgram } = require('@solana/web3.js');
  const payer = Keypair.generate();
  const key = () => Keypair.generate().publicKey;
  const meta = (pubkey, isWritable = true, isSigner = false) => ({ pubkey, isWritable, isSigner });
  // Distinct batch, registry, vault, results, instrument, book, oracle, matcher,
  // twelve portfolio PDAs, and the newly allocated next batch. No key deduplication
  // beyond the fee payer/System program shared by the next-batch creation path.
  const instruction = new TransactionInstruction({ programId: key(),
    data: Buffer.from([8, 0, 0, 12, 0, 255]),
    keys: [meta(key()), meta(key()), meta(key()), meta(key()), meta(key()),
      meta(key(), false), meta(key(), false), meta(key(), false),
      ...Array.from({ length: 12 }, () => meta(key())), meta(key()),
      meta(payer.publicKey, true, true), meta(SystemProgram.programId, false)] });
  const transaction = new Transaction({ feePayer: payer.publicKey, recentBlockhash: key().toBase58() })
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction);
  transaction.sign(payer);
  const wire = transaction.serialize();
  t.diagnostic(`worst-case settlement transaction: ${wire.length}/1232 bytes`);
  assert.ok(wire.length <= 1232, `${wire.length} bytes exceeds Solana's 1232-byte packet`);
});

test('runtime state assertions decode versioned protocol accounts by field path', async () => {
  const { LocalRuntime } = require('./harness');
  const { layouts } = require('../../mgk-frontend/packages/layout');
  const runtime = new LocalRuntime(18997);
  runtime.account = async () => ({data: Buffer.from(layouts.Portfolio.fixture)});
  await runtime.assertState([{address:'fixture', fields:[
    {name:'economic equity', path:'equity', value:-((1n<<100n)+20n)},
  ]}]);
  await assert.rejects(runtime.assertState([{address:'fixture', fields:[
    {name:'wrong equity', path:'equity', value:0n},
  ]}]), /wrong equity/);
  const stale = Buffer.from(layouts.Portfolio.fixture); stale[1] = 99;
  runtime.account = async () => ({data:stale});
  await assert.rejects(runtime.assertState([{address:'fixture', fields:[
    {name:'stale', path:'equity', value:0n},
  ]}]), /unsupported layout version/);
});

// A transaction that leaves the vault one lamport under-backed must stop the harness
// and name both the broken invariant and the transaction that broke it.
async function sendAgainst(breakState) {
  const { LocalRuntime } = require('./harness');
  const { Keypair, SystemProgram } = require('@solana/web3.js');
  const { market } = require('./invariant-fixtures');
  const m = market();
  const runtime = new LocalRuntime(18997);
  runtime.connection.getLatestBlockhash = async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 9 });
  runtime.rpc = async (method, params) => {
    if (method === 'simulateTransaction') return { value: { err: null } };
    if (method === 'sendTransaction') { breakState(m); return 'StubSignature1'; }
    if (method === 'getSignatureStatuses') return { value: [{ slot: 9, err: null, confirmationStatus: 'confirmed' }] };
    return m.chain.rpc(method, params);
  };
  const payer = Keypair.generate();
  return { runtime, sent: runtime.send('stub deposit', [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 })], [payer]) };
}

test('every harness transaction is followed by the invariant checker', async () => {
  const { runtime, sent } = await sendAgainst(() => {});
  assert.equal(await sent, 'StubSignature1');
  assert.equal(runtime.report.transactions[0].invariants, 'pass');
});

test('an invariant violation names the invariant and the transaction', async () => {
  const { runtime, sent } = await sendAgainst(m => m.store({ vaultLamports: -1 }));
  await assert.rejects(sent, /invariant "vault balance" violated after transaction "stub deposit" \(StubSignature1\)/);
  assert.equal(runtime.report.transactions[0].invariants[0].invariant, 'vault balance');
});
