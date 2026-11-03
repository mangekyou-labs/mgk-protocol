#!/usr/bin/env node
'use strict';
/**
 * Build the UNSIGNED same-ID upgrade transaction sequence for issue #39.
 *
 * This tool never signs and never sends. It loads no keypair and writes no
 * secret: buffer pubkeys come from --buffer-core/--buffer-matcher (the
 * operator generates those keypairs in their own terminal) or are random
 * placeholder pubkeys for preflight simulation only. Serialized transactions
 * carry zero-filled placeholder signatures so they can be simulated with
 * sigVerify:false; a wallet/CLI signer replaces them at signing time.
 *
 * Sequence per program, in order: ExtendProgram, CreateBuffer, Write chunks,
 * Upgrade (which refunds the buffer rent to the authority as spill). Core is
 * staged and upgraded before matcher so the core buffer refund lands first.
 *
 * Usage:
 *   node tools/build-upgrade-txs.js --out /tmp/mgk-upgrade-txs \
 *     [--buffer-core <pubkey>] [--buffer-matcher <pubkey>]
 *
 * Loader discriminants (solana-loader-v3-interface, bincode u32 LE):
 * InitializeBuffer=0, Write=1, Upgrade=3, ExtendProgram=6.
 */
const { createHash, randomBytes } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { Connection, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction } = require('@solana/web3.js');

const RPC = process.env.RPC_URL || 'https://api.devnet.solana.com';
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const AUTHORITY = new PublicKey('GBz4U7gb3nqALmtBBYajKgngFjbEsjPzM86X7ZADPwt4');
const ROOT = join(__dirname, '..');
const CHUNK = 1000; // bytes per Write; keeps every transaction under 1232 bytes
const PROGRAMS = [
  { name: 'core', programId: new PublicKey('9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT'), programData: new PublicKey('p412a3ubFJHn8ySAgdfDFWXezJ9k2BoMZXw1So4pSGU'), so: join(ROOT, 'target/deploy/mgk_perps_core.so'), sha256: 'efa553577be98d385174a4bad64768f6e56a99cb53748c97ef2b9b6403dc588d', extension: 30904, resultingCapacity: 261824, extendRent: 156992320, bufferArg: '--buffer-core' },
  { name: 'matcher', programId: new PublicKey('68MQqdugxZQA2F8GahhWZEusPnHbrfAXjqq2V9VCz8tK'), programData: new PublicKey('E7KhRLZj8p8CVhH1eqXvGwHJ7RJobTFanWqJnBt5DmuH'), so: join(ROOT, 'target/deploy/mgk_perps_matcher.so'), sha256: 'def1ae6af76540bd638aecfc99ef5f6f9f3b01476a25c351aa2d625754e8c579', extension: 10240, resultingCapacity: 87184, extendRent: 52019200, bufferArg: '--buffer-matcher' },
];
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const argVal = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; };

function extendIx(p) {
  return new TransactionInstruction({ programId: LOADER, data: Buffer.concat([u32(6), u32(p.extension)]),
    keys: [
      { pubkey: p.programData, isSigner: false, isWritable: true },
      { pubkey: p.programId, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: AUTHORITY, isSigner: true, isWritable: true },
    ] });
}
function createBufferTx(p, buffer, rent, blockhash) {
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: AUTHORITY });
  tx.add(SystemProgram.createAccount({ fromPubkey: AUTHORITY, newAccountPubkey: buffer, lamports: rent, space: 37 + p.bytes.length, programId: LOADER }));
  tx.add(new TransactionInstruction({ programId: LOADER, data: u32(0),
    keys: [
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: AUTHORITY, isSigner: false, isWritable: false },
    ] }));
  return tx;
}
function writeIx(p, buffer, offset, chunk) {
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(chunk.length));
  return new TransactionInstruction({ programId: LOADER, data: Buffer.concat([u32(1), u32(offset), len, chunk]),
    keys: [
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: AUTHORITY, isSigner: true, isWritable: false },
    ] });
}
function upgradeIx(p, buffer) {
  return new TransactionInstruction({ programId: LOADER, data: u32(3),
    keys: [
      { pubkey: p.programData, isSigner: false, isWritable: true },
      { pubkey: p.programId, isSigner: false, isWritable: true },
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: AUTHORITY, isSigner: false, isWritable: true }, // spill account: buffer rent refund
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: AUTHORITY, isSigner: true, isWritable: false },
    ] });
}

async function main() {
  const out = argVal('--out');
  if (!out) throw new Error('required: --out <directory for unsigned transactions>');
  mkdirSync(out, { recursive: true });
  const save = (txs, name, tx) => {
    for (const s of tx.signatures) s.signature = Buffer.alloc(64);
    const file = `${name}.b64`;
    writeFileSync(join(txs, file), tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'));
    return file;
  };
  const conn = new Connection(RPC, 'confirmed');
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const summary = { cluster: 'devnet', rpc: RPC, feePayerAndUpgradeAuthority: AUTHORITY.toBase58(), blockhash, lastValidBlockHeight, priorityFeeLamportsPerTx: 0, sequence: [], notes: [] };
  let phase = 0;
  for (const p of PROGRAMS) {
    p.bytes = readFileSync(p.so);
    const hash = createHash('sha256').update(p.bytes).digest('hex');
    if (hash !== p.sha256) throw new Error(`${p.name} candidate hash mismatch: ${hash} (rebuild SBF from the frozen candidate commit)`);
    const supplied = argVal(p.bufferArg);
    const buffer = supplied ? new PublicKey(supplied) : new PublicKey(randomBytes(32)); // placeholder pubkey only; no secret exists
    if (!supplied) summary.notes.push(`${p.name}: buffer pubkey is a PLACEHOLDER. Generate a buffer keypair in your own terminal (solana-keygen new) and rebuild with ${p.bufferArg} <pubkey> before signing.`);
    const bufferRent = await conn.getMinimumBalanceForRentExemption(37 + p.bytes.length);
    const extendTx = new Transaction({ recentBlockhash: blockhash, feePayer: AUTHORITY }).add(extendIx(p));
    summary.sequence.push({ step: ++phase, action: `ExtendProgram ${p.name}`, programData: p.programData.toBase58(), additionalBytes: p.extension, resultingCapacity: p.resultingCapacity, lamportsFromAuthority: p.extendRent, signers: [AUTHORITY.toBase58()], file: save(out, `0${phase}_extend_${p.name}`, extendTx), simulateNow: true });
    const createTx = createBufferTx(p, buffer, bufferRent, blockhash);
    summary.sequence.push({ step: ++phase, action: `CreateBuffer ${p.name}`, buffer: buffer.toBase58(), space: 37 + p.bytes.length, lamportsFromAuthority: bufferRent, refundedBy: 'Upgrade spill to authority', signers: [AUTHORITY.toBase58(), buffer.toBase58()], file: save(out, `0${phase}_create_buffer_${p.name}`, createTx), simulateNow: true });
    let writes = 0;
    for (let off = 0; off < p.bytes.length; off += CHUNK) {
      writes++;
      save(out, `write_${p.name}_${String(writes).padStart(3, '0')}`, new Transaction({ recentBlockhash: blockhash, feePayer: AUTHORITY }).add(writeIx(p, buffer, off, p.bytes.subarray(off, off + CHUNK))));
    }
    summary.sequence.push({ step: ++phase, action: `Write ${p.name} (${writes} txs x ${CHUNK}B)`, buffer: buffer.toBase58(), bytes: p.bytes.length, sha256: hash, signers: [AUTHORITY.toBase58()], files: `write_${p.name}_*.b64`, simulateNow: false, simulationNote: 'buffer does not exist until step above is sent' });
    const upTx = new Transaction({ recentBlockhash: blockhash, feePayer: AUTHORITY }).add(upgradeIx(p, buffer));
    summary.sequence.push({ step: ++phase, action: `Upgrade ${p.name}`, programId: p.programId.toBase58(), buffer: buffer.toBase58(), lamportsFromAuthority: 0, signers: [AUTHORITY.toBase58()], file: save(out, `0${phase}_upgrade_${p.name}`, upTx), simulateNow: false, simulationNote: 'fails until the buffer is created and fully written' });
    for (const s of summary.sequence.filter((x) => x.simulateNow && x.file && (x.action.endsWith(p.name)))) {
      const enc = readFileSync(join(out, s.file), 'utf8');
      const res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: [enc, { sigVerify: false, commitment: 'confirmed', encoding: 'base64' }] }) }).then((r) => r.json());
      if (res.error) throw new Error(`simulate ${s.action}: ${JSON.stringify(res.error)}`);
      s.simulation = { err: res.result.value.err, logs: (res.result.value.logs || []).slice(-3), unitsConsumed: res.result.value.unitsConsumed };
      delete s.simulateNow;
    }
  }
  const writeCounts = Object.fromEntries(PROGRAMS.map((p) => [p.name, Math.ceil(p.bytes.length / CHUNK)]));
  summary.totalEstimatedFeesLamports = 5000 * (2 + 4 + writeCounts.core + writeCounts.matcher + 2); // extends(1 sig) + creates(2 sig) + writes(1 sig) + upgrades(1 sig)
  summary.writeCounts = writeCounts;
  writeFileSync(join(out, 'unsigned-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
