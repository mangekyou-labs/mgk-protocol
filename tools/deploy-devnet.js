#!/usr/bin/env node
'use strict';
/**
 * One-shot deploy + protocol init for the SOL devnet demo market (issue #38).
 *
 * Idempotent: every step reads chain state first and skips work already done,
 * so a re-run after a dropped transaction resumes instead of duplicating.
 *
 *   0. Refuse unless target/deploy/*.so match the Checkpoint B hashes.
 *   1. Deploy oracle, matcher, perps-core under the fresh program IDs with the
 *      admin as upgrade authority; verify the on-chain bytecode hash.
 *   2. Oracle price account (create + Initialize + Activate in one tx, so the
 *      zeroed account can't be initialized by anyone else in between).
 *   3. Core Initialize (registry + instrument + vault), InitializeBook,
 *      CreateBatch 0.
 *   4. Seed the insurance fund with TopUp (permissionless) from FUNDER.
 *   5. Read every account back and write deployments/devnet.json.
 *
 * Init parameters are the Checkpoint B harness values the L-tier gate passed
 * on (tools/runtime/checkpoint-b.test.js startMarket).
 *
 * Env: RPC_URL, ADMIN_KEYPAIR, ORACLE_AUTHORITY_KEYPAIR, FUNDER_KEYPAIR,
 *      PROGRAM_KEYPAIR_DIR, ORACLE_ACCOUNT_KEYPAIR, MAKER_PUBKEY,
 *      INSURANCE_SEED_LAMPORTS (default 20 SOL), MANIFEST (default devnet.json)
 */
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
} = require('@solana/web3.js');
const { encodeInstruction } = require('../mgk-frontend/packages/layout/instructions.js');
const { decodeAccount, layouts } = require('../mgk-frontend/packages/layout/index.js');
const { confirmSignature } = require('../mgk-frontend/packages/layout/confirmation.js');

const ROOT = resolve(__dirname, '..');
const MANIFEST = process.env.MANIFEST || join(ROOT, 'deployments/devnet.json');
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const CORE = new PublicKey(manifest.programs.perps_core);
const MATCHER = new PublicKey(manifest.programs.perps_matcher);
const ORACLE = new PublicKey(manifest.programs.oracle);
const BPF_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const PROGRAMDATA_HEADER = 45;

// Checkpoint B release candidate. Matcher rebuilt for #69; oracle and core unchanged.
const PROGRAMS = [
  { name: 'mgk_oracle', id: ORACLE, key: 'oracle-keypair.json',
    sha256: '022f61b9e4c456eaac5f90efd93e5bc54d817f75e11f37cb8fde7f2e2b93486a' },
  { name: 'mgk_perps_matcher', id: MATCHER, key: 'perps-matcher-keypair.json',
    sha256: '42d6da55d9d44759d4a622753e82def2a79a85342fbe6cc606f22e7c972360d9' },
  { name: 'mgk_perps_core', id: CORE, key: 'perps-core-keypair.json',
    sha256: '877f54a219fe9266e433d9002fa07b1fe5888c020256ae5877ec2a6987eebed2' },
];

const INIT = {
  instrumentCount: 1, volatilityMultiplier: 10000, batchIdCounter: 0n, baseDeposit: 1000000n,
  nMin: 1, tMinSlots: 10n, tMaxSlots: 25n, tRevealSlots: 25n, instrumentId: 0, tickSize: 1n,
  lotSize: 1n, imrBps: 2000, mmrBps: 1000, takerFeeBps: 5, makerFeeBps: 0,
};

const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const loadKP = p => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
const pda = (seeds, owner = CORE) => PublicKey.findProgramAddressSync(seeds, owner);
const meta = (pubkey, isWritable = true, isSigner = false) => ({ pubkey, isWritable, isSigner });
const u64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const ix = (program, name, params, keys, programId) => new TransactionInstruction({
  programId, keys, data: Buffer.from(encodeInstruction(program, name, params)),
});

async function send(conn, label, ixs, signers) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await confirmSignature(conn, sig);
  console.log(`  [${label}] ${sig}`);
  return sig;
}

async function programHash(conn, programId, length) {
  const program = await conn.getAccountInfo(programId);
  if (!program) return null;
  if (!program.owner.equals(BPF_UPGRADEABLE)) throw new Error(`${programId} not upgradeable-loader owned`);
  const programData = new PublicKey(program.data.subarray(4, 36));
  const pd = await conn.getAccountInfo(programData);
  const authority = pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)) : null;
  return { sha256: sha256(pd.data.subarray(PROGRAMDATA_HEADER, PROGRAMDATA_HEADER + length)), authority };
}

async function main() {
  const rpc = process.env.RPC_URL || 'https://api.devnet.solana.com';
  const conn = new Connection(rpc, 'confirmed');
  const solanaDir = join(homedir(), '.config/solana');
  const adminPath = process.env.ADMIN_KEYPAIR || join(solanaDir, 'mgk-admin.json');
  const admin = loadKP(adminPath);
  const oracleAuthority = loadKP(process.env.ORACLE_AUTHORITY_KEYPAIR || join(solanaDir, 'mgk-demo-oracle.json'));
  const funder = loadKP(process.env.FUNDER_KEYPAIR || join(solanaDir, 'id.json'));
  const keyDir = process.env.PROGRAM_KEYPAIR_DIR || join(homedir(), '.config/mgk-protocol/fresh-ids');
  const oracleAccountPath = process.env.ORACLE_ACCOUNT_KEYPAIR || join(keyDir, 'oracle-price-account.json');
  const maker = new PublicKey(process.env.MAKER_PUBKEY || 'DPs1NM3TeR9f9WQBgqrT27dmf8F4DoJJVyBpqT5NGr4o');
  const seed = BigInt(process.env.INSURANCE_SEED_LAMPORTS || 20_000_000_000n);

  let rpcHost = 'invalid-rpc';
  try { rpcHost = new URL(rpc).host; } catch { /* keep placeholder */ }
  console.log(`=== MGK deploy (${manifest.cluster}) via ${rpcHost} ===`);
  console.log('Admin:', admin.publicKey.toBase58(), (await conn.getBalance(admin.publicKey)) / 1e9, 'SOL');
  console.log('Funder:', funder.publicKey.toBase58(), (await conn.getBalance(funder.publicKey)) / 1e9, 'SOL');

  // 0. Local artifacts must be the release candidate.
  for (const p of PROGRAMS) {
    p.so = readFileSync(join(ROOT, 'target/deploy', `${p.name}.so`));
    if (sha256(p.so) !== p.sha256) throw new Error(`${p.name}.so hash ${sha256(p.so)} != Checkpoint B ${p.sha256}`);
    const kp = loadKP(join(keyDir, p.key));
    if (!kp.publicKey.equals(p.id)) throw new Error(`${p.key} is ${kp.publicKey}, manifest wants ${p.id}`);
  }
  console.log('\n[0] .so hashes match Checkpoint B');

  // 1. Programs.
  const startSlot = manifest.start_slot.status === 'set' ? manifest.start_slot.slot : await conn.getSlot('confirmed');
  console.log(`\n[1] Programs (start slot ${startSlot})`);
  for (const p of PROGRAMS) {
    if (!(await programHash(conn, p.id, p.so.length))) {
      console.log(`  deploying ${p.name} → ${p.id}`);
      execFileSync('solana', ['program', 'deploy', '--url', rpc, '--keypair', adminPath,
        '--program-id', join(keyDir, p.key), '--upgrade-authority', adminPath,
        '--max-sign-attempts', '100',
        '--with-compute-unit-price', process.env.DEPLOY_CU_PRICE || '50000', '--commitment', 'confirmed',
        join(ROOT, 'target/deploy', `${p.name}.so`)], { stdio: 'inherit' });
    }
    const onChain = await programHash(conn, p.id, p.so.length);
    if (!onChain || onChain.sha256 !== p.sha256) throw new Error(`${p.name} on-chain hash ${onChain?.sha256} != ${p.sha256}`);
    if (!onChain.authority?.equals(admin.publicKey)) throw new Error(`${p.name} upgrade authority ${onChain.authority} != admin`);
    console.log(`  OK ${p.name} ${p.id} sha256=${onChain.sha256.slice(0, 12)}… authority=admin`);
  }

  // PDAs.
  const [registry, registryBump] = pda([Buffer.from('registry')]);
  const [instrument, instrumentBump] = pda([Buffer.from('instrument'), Buffer.alloc(2)]);
  const [vault, vaultBump] = pda([Buffer.from('vault')]);
  const [book] = pda([Buffer.from('book'), Buffer.alloc(2)], MATCHER);
  const [batch0, batch0Bump] = pda([Buffer.from('batch'), u64(0)]);

  // 2. Oracle price account.
  if (!existsSync(oracleAccountPath)) {
    writeFileSync(oracleAccountPath, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  }
  const oracleAccount = loadKP(oracleAccountPath);
  console.log('\n[2] Oracle price account', oracleAccount.publicKey.toBase58());
  if (!(await conn.getAccountInfo(oracleAccount.publicKey))) {
    const size = layouts.PriceOracle.size;
    await send(conn, 'oracle create+init+activate', [
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey, newAccountPubkey: oracleAccount.publicKey, programId: ORACLE,
        space: size, lamports: await conn.getMinimumBalanceForRentExemption(size),
      }),
      ix('oracle', 'Initialize', { initialPrice: 0n, bump: 0 },
        [meta(oracleAccount.publicKey), meta(oracleAuthority.publicKey, false, true), meta(instrument, false)], ORACLE),
      ix('oracle', 'Activate', {}, [meta(oracleAccount.publicKey), meta(oracleAuthority.publicKey, false, true)], ORACLE),
    ], [admin, oracleAccount, oracleAuthority]);
  } else {
    console.log('  present — skip');
  }

  // 3. Core market accounts.
  console.log('\n[3] Registry + instrument + vault, book, batch 0');
  if (!(await conn.getAccountInfo(registry))) {
    await send(conn, 'core Initialize', [ix('core', 'Initialize', {
      ...INIT, governance: admin.publicKey.toBytes(), oracleAddr: oracleAccount.publicKey.toBytes(),
      registryBump, instrumentBump, vaultBump,
    }, [meta(registry), meta(admin.publicKey, true, true), meta(instrument),
      meta(SystemProgram.programId, false), meta(vault)], CORE)], [admin]);
  } else {
    console.log('  registry present — skip Initialize');
  }
  const bookBefore = await conn.getAccountInfo(book);
  if (!bookBefore || bookBefore.data[0] !== layouts.OrderBook.discriminator) {
    // Created and grown in three <= 10 KiB steps (#69).
    const initializeBook = () => ix('core', 'InitializeBook', { instrumentId: 0 },
      [meta(registry, false), meta(book), meta(admin.publicKey, true, true),
        meta(SystemProgram.programId, false), meta(MATCHER, false)], CORE);
    await send(conn, 'InitializeBook', [initializeBook(), initializeBook(), initializeBook()], [admin]);
  } else {
    console.log('  book stamped — skip');
  }
  if (!(await conn.getAccountInfo(batch0))) {
    await send(conn, 'CreateBatch 0', [ix('core', 'CreateBatch', { bump: batch0Bump },
      [meta(batch0), meta(registry), meta(admin.publicKey, true, true), meta(SystemProgram.programId, false)], CORE)],
    [admin]);
  } else {
    console.log('  batch 0 present — skip');
  }

  // 4. Insurance seed.
  const fund = BigInt(decodeAccount('Vault', (await conn.getAccountInfo(vault)).data).insuranceFund);
  console.log(`\n[4] Insurance fund ${fund} lamports (target ${seed})`);
  if (fund < seed) {
    await send(conn, 'TopUp', [ix('core', 'TopUp', { amount: seed - fund },
      [meta(funder.publicKey, true, true), meta(vault), meta(SystemProgram.programId, false)], CORE)], [funder]);
  }

  // 5. Read back, then write the manifest only from verified chain state.
  console.log('\n[5] Read-back');
  const read = async (name, address, owner) => {
    const info = await conn.getAccountInfo(address);
    if (!info || !info.owner.equals(owner)) throw new Error(`${name} ${address} missing or wrong owner`);
    return info;
  };
  const reg = decodeAccount('Registry', (await read('registry', registry, CORE)).data);
  const inst = decodeAccount('Instrument', (await read('instrument', instrument, CORE)).data);
  const vaultInfo = await read('vault', vault, CORE);
  const v = decodeAccount('Vault', vaultInfo.data);
  const orc = decodeAccount('PriceOracle', (await read('oracle', oracleAccount.publicKey, ORACLE)).data);
  const bookInfo = await read('book', book, MATCHER);
  await read('batch 0', batch0, CORE);
  const pk = bytes => new PublicKey(Uint8Array.from(bytes)).toBase58();
  const checks = [
    ['registry.governance = admin', pk(reg.governance) === admin.publicKey.toBase58()],
    ['instrument.oracleAddr = oracle account', pk(inst.oracleAddr) === oracleAccount.publicKey.toBase58()],
    ['instrument imr/mmr 2000/1000, fees 5/0', inst.imrBps === 2000 && inst.mmrBps === 1000
      && inst.takerFeeBps === 5 && inst.makerFeeBps === 0],
    ['oracle authority = oracle worker', pk(orc.authority) === oracleAuthority.publicKey.toBase58()],
    ['oracle instrument = instrument PDA', pk(orc.instrument) === instrument.toBase58()],
    ['oracle active', Boolean(orc.isActive)],
    ['book full size (27712) and stamped', bookInfo.data.length === 27712
      && bookInfo.data[0] === layouts.OrderBook.discriminator],
    [`insurance fund = ${seed}`, BigInt(v.insuranceFund) === seed],
    ['vault lamports − rent = collateral + fund − debt', BigInt(vaultInfo.lamports)
      - BigInt(await conn.getMinimumBalanceForRentExemption(vaultInfo.data.length))
      === BigInt(v.balance) + BigInt(v.insuranceFund) - BigInt(v.uncoveredBadDebt)],
  ];
  for (const [label, ok] of checks) console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
  if (checks.some(([, ok]) => !ok)) throw new Error('read-back failed; manifest not written');

  const deployed = address => ({ status: 'deployed', address: address.toBase58() });
  manifest.accounts = {
    registry: deployed(registry), instrument: deployed(instrument), oracle: deployed(oracleAccount.publicKey),
    insurance: deployed(vault), maker: deployed(maker),
  };
  manifest.start_slot = { status: 'set', slot: startSlot };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nManifest written: ${MANIFEST}`);
}

main().catch(e => { console.error('Fatal:', e.message || e); process.exit(1); });
