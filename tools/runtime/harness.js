'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { Connection, PublicKey, Transaction, ComputeBudgetProgram } = require('@solana/web3.js');

const exactInteger = value => {
  assert.ok(typeof value === 'bigint' || (typeof value === 'string' && /^-?[0-9]+$/.test(value)) ||
    (typeof value === 'number' && Number.isSafeInteger(value)), 'exact decimal string, bigint, or safe integer required');
  return BigInt(value);
};

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Keep the checked bytes in memory. Loading never reopens a path after verification.
function verifyArtifacts(candidates) {
  assert.ok(Array.isArray(candidates) && candidates.length, 'candidate artifacts required');
  const ids = new Set();
  return candidates.map(candidate => {
    const { name, programId, sha256 } = candidate;
    new PublicKey(programId);
    assert.ok(!ids.has(programId), `duplicate program ID: ${programId}`);
    ids.add(programId);
    assert.match(sha256, /^[a-f0-9]{64}$/, `${name}: SHA-256 required`);
    const path = resolve(candidate.path);
    const bytes = readFileSync(path);
    assert.equal(hash(bytes), sha256, `${name}: SHA-256 mismatch`);
    assert.equal(bytes.subarray(0, 4).toString('hex'), '7f454c46', `${name}: expected ELF artifact`);
    return { name, programId, sha256, path, bytes };
  });
}

async function stopProcess(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  let timer;
  try { await Promise.race([once(child, 'exit'), new Promise(resolve => { timer = setTimeout(resolve, 3000); })]); }
  finally { clearTimeout(timer); }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

class LocalRuntime {
  static async start({ candidates, port = 18899, wsPort = port + 1, surfpool = 'surfpool', reportPath }) {
    const artifacts = verifyArtifacts(candidates);
    assert.ok(Number.isInteger(port) && port > 1024 && port < 65535);
    const runtime = new LocalRuntime(port, reportPath);
    runtime.directory = mkdtempSync(join(tmpdir(), 'mgk-runtime-'));
    try {
      // Do not connect to an existing validator, or accidentally reuse another run's ledger.
      try { await runtime.rpc('getHealth'); throw new Error(`RPC port ${port} already in use`); }
      catch (error) { if (!error.cause && !/fetch failed/.test(error.message)) throw error; }
      runtime.validator = spawn(surfpool, ['start', '--offline', '--no-deploy', '--ci', '--host', '127.0.0.1',
        '--port', String(port), '--ws-port', String(wsPort), '--airdrop-amount', '0'], {
        cwd: runtime.directory, env: { ...process.env, NO_DNA: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      runtime.validator.on('error', error => { runtime.startError = error; });
      let logs = '';
      runtime.validator.stdout.on('data', data => { logs = (logs + data).slice(-16000); });
      runtime.validator.stderr.on('data', data => { logs = (logs + data).slice(-16000); });
      const deadline = Date.now() + 30000;
      while (true) {
        if (runtime.startError) throw runtime.startError;
        if (runtime.validator.exitCode !== null) throw new Error(`Surfpool exited: ${logs}`);
        try { await runtime.rpc('getHealth'); break; }
        catch (error) { if (Date.now() > deadline) throw new Error(`Surfpool readiness timeout: ${logs}`, { cause: error }); }
        await sleep(100);
      }
      for (const artifact of artifacts) {
        await runtime.rpc('surfnet_writeProgram', [artifact.programId, artifact.bytes.toString('hex'), 0]);
        const program = await runtime.account(artifact.programId);
        assert.ok(program.executable, `${artifact.name}: program is not executable`);
        // writeProgram deploys via the upgradeable loader. Verify the bytes the runtime holds.
        assert.equal(program.owner, 'BPFLoaderUpgradeab1e11111111111111111111111');
        assert.equal(program.data.readUInt32LE(0), 2, 'upgradeable program account');
        const programDataAddress = new PublicKey(program.data.subarray(4, 36)).toBase58();
        const programData = await runtime.account(programDataAddress);
        assert.equal(programData.data.readUInt32LE(0), 3, 'upgradeable program-data account');
        assert.equal(hash(programData.data.subarray(45)), artifact.sha256, `${artifact.name}: loaded SHA-256 mismatch`);
        runtime.report.programs.push({ name: artifact.name, programId: artifact.programId,
          path: artifact.path, sha256: artifact.sha256, programDataAddress });
      }
      runtime.flushReport();
      return runtime;
    } catch (error) { await runtime.close(); throw error; }
  }

  constructor(port, reportPath) {
    this.url = `http://127.0.0.1:${port}`;
    this.connection = new Connection(this.url, 'confirmed');
    this.reportPath = reportPath;
    this.report = { cluster: 'localnet', rpcUrl: this.url, programs: [], transactions: [], controls: [] };
    this.workers = new Set();
  }

  flushReport() {
    if (this.reportPath) writeFileSync(this.reportPath, JSON.stringify(this.report, null, 2) + '\n');
  }

  async rpc(method, params = []) {
    const response = await fetch(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok, `RPC HTTP ${response.status}`);
    const result = await response.json();
    if (result.error) throw new Error(`${method}: ${JSON.stringify(result.error)}`);
    return result.result;
  }

  async account(address) {
    const result = await this.rpc('getAccountInfo', [String(address), { encoding: 'base64', commitment: 'confirmed' }]);
    assert.ok(result.value, `missing account: ${address}`);
    assert.ok(Number.isSafeInteger(result.value.lamports), `${address}: lamports exceed safe JSON integer range`);
    return { ...result.value, lamports: BigInt(result.value.lamports), data: Buffer.from(result.value.data[0], 'base64') };
  }

  async setAccount(address, { owner, lamports = 10_000_000, data = Buffer.alloc(0), executable = false }) {
    assert.ok(Number.isSafeInteger(lamports) && lamports >= 0, 'safe nonnegative lamports required');
    await this.rpc('surfnet_setAccount', [String(address), { owner: String(owner), lamports, data: data.toString('hex'), executable }]);
  }

  // The baseline PriceOracle layout is intentionally contained here; future layout changes update this adapter.
  async setOracle(address, { owner, authority, instrument, price, publishTime, confidence, active = true, bump = 0 }) {
    const data = Buffer.alloc(128);
    data.write('PRCLORCL'); data[8] = 0; data[9] = bump; data[10] = Number(active);
    new PublicKey(authority).toBuffer().copy(data, 16);
    new PublicKey(instrument).toBuffer().copy(data, 48);
    data.writeBigInt64LE(exactInteger(price), 80);
    data.writeBigInt64LE(exactInteger(publishTime), 88);
    data.writeBigInt64LE(exactInteger(confidence), 96);
    await this.setAccount(address, { owner, data });
    this.report.controls.push({ type: 'oracle', address: String(address), price: String(price),
      publishTime: String(publishTime), confidence: String(confidence), active });
    this.flushReport();
  }

  async advanceSlots(count) {
    assert.ok(Number.isSafeInteger(count) && count > 0, 'positive slot count required');
    const current = await this.rpc('getSlot', [{ commitment: 'confirmed' }]);
    await this.rpc('surfnet_timeTravel', [{ absoluteSlot: current + count }]);
    let slot;
    const deadline = Date.now() + 5000;
    do {
      slot = await this.rpc('getSlot', [{ commitment: 'confirmed' }]);
      if (slot >= current + count) break;
      await sleep(50);
    } while (Date.now() < deadline);
    assert.ok(slot >= current + count, 'clock did not advance');
    this.report.controls.push({ type: 'slots', from: current, to: slot }); this.flushReport();
    return slot;
  }

  async send(label, instructions, signers) {
    assert.ok(signers.length > 0, 'fee payer and signatures required');
    const latest = await this.connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: signers[0].publicKey, ...latest });
    // The baseline matcher's book scan exceeds 200k CU; deliberately cap the smoke at the runtime maximum.
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...instructions);
    tx.sign(...signers);
    const wire = tx.serialize().toString('base64');
    const simulation = await this.rpc('simulateTransaction', [wire, { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }]);
    assert.equal(simulation.value.err, null, `${label} simulation: ${JSON.stringify(simulation.value)}`);
    const signature = await this.rpc('sendTransaction', [wire, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' }]);
    const deadline = Date.now() + 15000;
    let status;
    while (true) {
      status = (await this.rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])).value[0];
      if (status?.err) throw new Error(`${label}: ${JSON.stringify(status.err)}`);
      if (status && ['confirmed', 'finalized'].includes(status.confirmationStatus)) break;
      if (Date.now() > deadline) throw new Error(`${label}: confirmation timeout (${signature})`);
      await sleep(50);
    }
    this.report.transactions.push({ label, signature, slot: status.slot, err: null }); this.flushReport();
    return signature;
  }

  async assertState(expectedAccounts) {
    // Values are caller-supplied model output. No protocol arithmetic is reproduced here.
    for (const expected of expectedAccounts) {
      const actual = await this.account(expected.address);
      if (expected.owner !== undefined) assert.equal(actual.owner, String(expected.owner), `${expected.address}: owner`);
      if (expected.lamports !== undefined) assert.equal(actual.lamports, exactInteger(expected.lamports), `${expected.address}: lamports`);
      for (const field of expected.fields ?? []) {
        const { offset, bytes, signed = false, name, value } = field;
        assert.ok(Number.isInteger(offset) && offset >= 0 && Number.isInteger(bytes) && bytes > 0 && offset + bytes <= actual.data.length,
          `${name}: field outside account`);
        let decoded = 0n;
        for (let i = bytes - 1; i >= 0; i--) decoded = (decoded << 8n) + BigInt(actual.data[offset + i]);
        if (signed && (actual.data[offset + bytes - 1] & 0x80)) decoded -= 1n << BigInt(8 * bytes);
        assert.equal(decoded, exactInteger(value), `${expected.address}: ${name}`);
      }
    }
  }

  async launchWorker(command, args = [], options = {}) {
    const child = spawn(command, args, { ...options, env: { ...process.env, ...options.env, NO_DNA: '1', RPC_URL: this.url },
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'] });
    this.workers.add(child);
    await once(child, 'spawn');
    return child;
  }

  async close() {
    await Promise.all([...this.workers].map(stopProcess));
    if (this.validator) await stopProcess(this.validator);
    if (this.directory) rmSync(this.directory, { recursive: true, force: true });
  }
}

module.exports = { LocalRuntime, verifyArtifacts };
