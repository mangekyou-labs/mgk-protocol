#!/usr/bin/env node
'use strict';
/**
 * Build the UNSIGNED D prime (scoped throwaway market) provisioning sequence
 * for issue #39, against the already-upgraded same-ID programs on devnet.
 *
 * Never signs, sends, or loads a keypair. Required public inputs:
 *   --oracle-account <pubkey>  fresh PriceOracle account the operator
 *                              generated (its keypair signs creation only)
 *   --out <dir>                where unsigned transactions + summary go
 *
 * Market seed = admin public key, so governance and the initialization-only
 * market-identity signature are the same admin signer (ADR 0005). The maker
 * portfolio belongs to the maker worker signer. Insurance TopUp (3 SOL from
 * admin) and maker Deposit (3 SOL from maker) only simulate once the funding
 * top-ups in docs/ops/issue-39-signing-handoff.md have landed.
 */
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } = require('@solana/web3.js');
const { encodeInstruction } = require('../mgk-frontend/packages/layout/instructions');

const RPC = process.env.RPC_URL || 'https://api.devnet.solana.com';
const CORE = new PublicKey('9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT');
const MATCHER = new PublicKey('68MQqdugxZQA2F8GahhWZEusPnHbrfAXjqq2V9VCz8tK');
const ORACLE = new PublicKey('GLAu9n48oqnVRKHNoqfpek3kZyGUJTJRPQKo7mF3qWmm');
const ADMIN = new PublicKey('GBz4U7gb3nqALmtBBYajKgngFjbEsjPzM86X7ZADPwt4');
const ORACLE_AUTHORITY = new PublicKey('72dFyhGoA5uNep2XFTv4saMJVPecSNcthXZkaquUXHue');
const MAKER = new PublicKey('DPs1NM3TeR9f9WQBgqrT27dmf8F4DoJJVyBpqT5NGr4o');
const SEED = ADMIN.toBuffer();
const meta = (pubkey, isWritable = true, isSigner = false) => ({ pubkey, isWritable, isSigner });
const argVal = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; };

const [registry, registryBump] = PublicKey.findProgramAddressSync([Buffer.from('registry'), SEED], CORE);
const derive = (tag, suffix = [], owner = CORE) => PublicKey.findProgramAddressSync([Buffer.from(tag), registry.toBuffer(), ...suffix], owner);
const [instrument, instrumentBump] = derive('instrument', [Buffer.alloc(2)]);
const [vault, vaultBump] = derive('vault');
const [book] = derive('book', [Buffer.alloc(2)], MATCHER);
const [batch0, batch0Bump] = derive('batch', [Buffer.alloc(8)]);
const [portfolio] = derive('portfolio', [MAKER.toBuffer()]);

const scoped = (name, params) => new TransactionInstruction({ programId: CORE,
  keys: scoped.keys, data: Buffer.concat([Buffer.from([29]), SEED, Buffer.from(encodeInstruction('core', name, params))]) });

async function main() {
  const out = argVal('--out');
  const oracleAccountArg = argVal('--oracle-account');
  if (!out || !oracleAccountArg) throw new Error('required: --out <dir> --oracle-account <pubkey>');
  const oracleAccount = new PublicKey(oracleAccountArg);
  mkdirSync(out, { recursive: true });
  const conn = new Connection(RPC, 'confirmed');
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const save = (name, tx) => {
    tx.recentBlockhash = blockhash;
    for (const s of tx.signatures) s.signature = Buffer.alloc(64);
    writeFileSync(join(out, `${name}.b64`), tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'));
    return { file: `${name}.b64` };
  };
  const steps = [];
  let n = 0;

  // 1. Distinct PriceOracle for D' instrument 0: create + Initialize + Activate.
  {
    const tx = new Transaction({ feePayer: ADMIN });
    tx.add(SystemProgram.createAccount({ fromPubkey: ADMIN, newAccountPubkey: oracleAccount,
      lamports: await conn.getMinimumBalanceForRentExemption(128), space: 128, programId: ORACLE }));
    tx.add(new TransactionInstruction({ programId: ORACLE, data: Buffer.from(encodeInstruction('oracle', 'Initialize', { initialPrice: 0n, bump: 0 })),
      keys: [meta(oracleAccount), meta(ORACLE_AUTHORITY, false, true), meta(instrument, false)] }));
    tx.add(new TransactionInstruction({ programId: ORACLE, data: Buffer.from(encodeInstruction('oracle', 'Activate', {})),
      keys: [meta(oracleAccount), meta(ORACLE_AUTHORITY, false, true)] }));
    steps.push({ step: ++n, action: 'Create + Initialize + Activate D prime PriceOracle', ...save('01_oracle', tx), signers: [ADMIN, oracleAccount, ORACLE_AUTHORITY].map(String), lamportsFromFeePayer: 1781760, simulateNow: true });
  }
  // 2. Scoped Initialize: registry + instrument + vault for the D' namespace.
  scoped.keys = [meta(registry), meta(ADMIN, true, true), meta(instrument), meta(SystemProgram.programId, false), meta(vault), meta(ADMIN, false, true)];
  {
    const tx = new Transaction({ feePayer: ADMIN }).add(scoped('Initialize', {
      governance: ADMIN.toBytes(), instrumentCount: 1, volatilityMultiplier: 10000,
      batchIdCounter: 0n, baseDeposit: 1000000n, nMin: 1, tMinSlots: 10n, tMaxSlots: 25n,
      tRevealSlots: 25n, instrumentId: 0, tickSize: 1n, lotSize: 1n, imrBps: 2000, mmrBps: 1000,
      takerFeeBps: 5, makerFeeBps: 0, oracleAddr: oracleAccount.toBytes(), registryBump, instrumentBump, vaultBump }));
    steps.push({ step: ++n, action: 'Scoped Initialize (registry, instrument, vault)', ...save('02_initialize', tx), signers: [ADMIN.toBase58()], simulateNow: true });
  }
  // 3. Grow the matcher book PDA (three growth steps in one transaction).
  scoped.keys = [meta(registry, false), meta(book), meta(ADMIN, true, true), meta(SystemProgram.programId, false), meta(MATCHER, false)];
  {
    const ix = () => scoped('InitializeBook', { instrumentId: 0 });
    const tx = new Transaction({ feePayer: ADMIN }).add(ix(), ix(), ix());
    steps.push({ step: ++n, action: 'InitializeBook x3 (grow book to full size)', ...save('03_book', tx), signers: [ADMIN.toBase58()], simulateNow: false, simulationNote: 'needs the registry from step 2' });
  }
  // 4. Batch 0.
  scoped.keys = [meta(batch0), meta(registry), meta(ADMIN, true, true), meta(SystemProgram.programId, false)];
  {
    const tx = new Transaction({ feePayer: ADMIN }).add(scoped('CreateBatch', { bump: batch0Bump }));
    steps.push({ step: ++n, action: 'CreateBatch 0', ...save('04_batch', tx), signers: [ADMIN.toBase58()], simulateNow: false, simulationNote: 'needs the registry from step 2' });
  }
  // 5. Insurance seed: 3 SOL from admin into the D' vault.
  scoped.keys = [meta(ADMIN, true, true), meta(vault), meta(SystemProgram.programId, false)];
  {
    const tx = new Transaction({ feePayer: ADMIN }).add(scoped('TopUp', { amount: 3000000000n }));
    steps.push({ step: ++n, action: 'TopUp insurance 3 SOL (admin)', ...save('05_topup', tx), signers: [ADMIN.toBase58()], lamportsFromFeePayer: 3000000000, simulateNow: false, simulationNote: 'needs step 2 and the admin funding top-up' });
  }
  // 6. Maker portfolio: InitPortfolioForUser creates the PDA via invoke_signed
  // (plain InitPortfolio only stamps a pre-created account and fails owner
  // validation on a fresh PDA). Admin pays the rent; maker is the user.
  scoped.keys = [meta(ADMIN, true, true), meta(portfolio), meta(SystemProgram.programId, false)];
  {
    const tx = new Transaction({ feePayer: ADMIN }).add(scoped('InitPortfolioForUser', { user: MAKER.toBytes() }));
    steps.push({ step: ++n, action: 'InitPortfolioForUser (maker portfolio)', ...save('06_portfolio', tx), signers: [ADMIN.toBase58()], simulateNow: false, simulationNote: 'needs the registry from step 2' });
  }
  // 7. Maker collateral: 3 SOL from the maker wallet into its portfolio.
  scoped.keys = [meta(portfolio), meta(MAKER, true, true), meta(SystemProgram.programId, false), meta(vault)];
  {
    const tx = new Transaction({ feePayer: MAKER }).add(scoped('Deposit', { amount: 3000000000n }));
    steps.push({ step: ++n, action: 'Deposit maker collateral 3 SOL (maker)', ...save('07_deposit', tx), signers: [MAKER.toBase58()], lamportsFromFeePayer: 3000000000, simulateNow: false, simulationNote: 'needs steps 2+6 and the maker funding top-up' });
  }

  for (const s of steps.filter((x) => x.simulateNow)) {
    const enc = require('node:fs').readFileSync(join(out, s.file), 'utf8');
    const res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: [enc, { sigVerify: false, commitment: 'confirmed', encoding: 'base64' }] }) }).then((r) => r.json());
    if (res.error) throw new Error(`simulate ${s.action}: ${JSON.stringify(res.error)}`);
    s.simulation = { err: res.result.value.err, logs: (res.result.value.logs || []).slice(-4), unitsConsumed: res.result.value.unitsConsumed };
    delete s.simulateNow;
  }
  const summary = { cluster: 'devnet', rpc: RPC, blockhash, lastValidBlockHeight, marketSeed: ADMIN.toBase58(),
    accounts: { registry: registry.toBase58(), instrument: instrument.toBase58(), vault: vault.toBase58(), book: book.toBase58(), batch0: batch0.toBase58(), makerPortfolio: portfolio.toBase58(), oracle: oracleAccount.toBase58() },
    fundingRequired: { adminTopUpLamports: 5100000000, makerTopUpLamports: 3000000000, note: 'admin -> 6.599 SOL total, maker -> 4.0 SOL total; see signing handoff' }, steps };
  writeFileSync(join(out, 'dprime-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
