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
