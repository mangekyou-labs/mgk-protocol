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
  runtime.account = async () => ({ lamports: 9007199254740992n, data: Buffer.alloc(16) });
  await assert.rejects(runtime.assertState([{ address: 'fixture', lamports: 9007199254740992 }]), /safe integer/);
  await assert.rejects(runtime.assertState([{ address: 'fixture', fields: [
    { name: 'equity', offset: 0, bytes: 16, value: 9007199254740992 },
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
