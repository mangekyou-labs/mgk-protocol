#!/usr/bin/env node
'use strict';
/**
 * OPERATOR-RUN sender for the unsigned D prime provisioning set built by
 * tools/build-dprime-txs.js. This is the signing step: it loads the
 * operator's own keypair files from the environment variables below, signs
 * the serialized transactions, sends them to devnet, and confirms each one.
 * Run it only in your own terminal after reviewing unsigned-summary output.
 *
 *   ADMIN_KEYPAIR, ORACLE_AUTHORITY_KEYPAIR, ORACLE_ACCOUNT_KEYPAIR,
 *   MAKER_KEYPAIR  (file paths; contents never leave this process)
 *   DPRIME_TX_DIR  (output of build-dprime-txs.js)
 *
 * Idempotent: creation steps are skipped when their account already exists,
 * and every confirmed signature is recorded in <DPRIME_TX_DIR>/sent.json so
 * a re-run resumes instead of repeating the 3 SOL transfers.
 */
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { Connection, Keypair, PublicKey, Transaction } = require('@solana/web3.js');

const RPC = process.env.RPC_URL || 'https://api.devnet.solana.com';
const DIR = process.env.DPRIME_TX_DIR;
const load = (env) => {
  const p = process.env[env];
  if (!p || !existsSync(p)) throw new Error(`required env: ${env} (path to your keypair file)`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
};
const EXPECTED = {
  ADMIN_KEYPAIR: 'GBz4U7gb3nqALmtBBYajKgngFjbEsjPzM86X7ZADPwt4',
  ORACLE_AUTHORITY_KEYPAIR: '72dFyhGoA5uNep2XFTv4saMJVPecSNcthXZkaquUXHue',
  ORACLE_ACCOUNT_KEYPAIR: null, // fresh account; any pubkey, recorded below
  MAKER_KEYPAIR: 'DPs1NM3TeR9f9WQBgqrT27dmf8F4DoJJVyBpqT5NGr4o',
};
const CORE_ID = '9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT';
const MATCHER_ID = '68MQqdugxZQA2F8GahhWZEusPnHbrfAXjqq2V9VCz8tK';
const ORACLE_ID = 'GLAu9n48oqnVRKHNoqfpek3kZyGUJTJRPQKo7mF3qWmm';
// Guard per step: resolves to an address only when that step's provisioned
// state is actually on chain, else null. Creation steps require the right
// owner (a merely funded system account is NOT provisioned). Steps 5/7 guard
// on decoded balances so a lost sent.json cannot double-fund.
const owned = (getAddress, owner, len) => async (s, conn) => {
  const address = getAddress(s);
  const info = await conn.getAccountInfo(new PublicKey(address));
  return info && info.owner.toBase58() === owner && (!len || info.data.length === len) ? address : null;
};
const GUARDS = [
  owned((s) => s.accounts.oracle, ORACLE_ID, 128),
  owned((s) => s.accounts.registry, CORE_ID),
  owned((s) => s.accounts.book, MATCHER_ID),
  owned((s) => s.accounts.batch0, CORE_ID),
  async (s, conn) => { const v = await conn.getAccountInfo(new PublicKey(s.accounts.vault));
    return v && v.data.readBigUInt64LE(16) >= 3000000000n ? s.accounts.vault : null; },
  owned((s) => s.accounts.makerPortfolio, CORE_ID),
  async (s, conn) => { const p = await conn.getAccountInfo(new PublicKey(s.accounts.makerPortfolio));
    return p && p.data.readBigInt64LE(176) >= 3000000000n ? s.accounts.makerPortfolio : null; },
];

async function main() {
  if (!DIR) throw new Error('required env: DPRIME_TX_DIR');
  const summary = JSON.parse(readFileSync(join(DIR, 'dprime-summary.json'), 'utf8'));
  const sentPath = join(DIR, 'sent.json');
  const sent = existsSync(sentPath) ? JSON.parse(readFileSync(sentPath, 'utf8')) : {};
  const signers = {};
  for (const env of Object.keys(EXPECTED)) {
    signers[env] = load(env);
    const pub = signers[env].publicKey.toBase58();
    if (EXPECTED[env] && pub !== EXPECTED[env]) throw new Error(`${env} pubkey ${pub} != expected ${EXPECTED[env]}`);
    console.log(`${env}: ${pub}`);
  }
  const byPubkey = new Map(Object.values(signers).map((k) => [k.publicKey.toBase58(), k]));
  if (byPubkey.get(summary.accounts.oracle)?.publicKey.toBase58() !== summary.accounts.oracle) {
    // oracle account keypair must match the pubkey baked into the unsigned set
    if (![...byPubkey.keys()].includes(summary.accounts.oracle)) throw new Error('ORACLE_ACCOUNT_KEYPAIR does not match --oracle-account used at build time');
  }
  const conn = new Connection(RPC, 'confirmed');
  for (const step of summary.steps) {
    if (sent[step.step]) { console.log(`step ${step.step} ${step.action}: already sent ${sent[step.step].signature}`); continue; }
    const guard = await GUARDS[step.step - 1]?.(summary, conn);
    if (guard) { console.log(`step ${step.step} ${step.action}: already provisioned (${guard}), skipping`); continue; }
    if (step.step === 1) {
      const existing = await conn.getAccountInfo(new PublicKey(summary.accounts.oracle));
      if (existing) throw new Error(`oracle account ${summary.accounts.oracle} already exists on chain (owner ${existing.owner.toBase58()}, ${existing.lamports} lamports) but is not a provisioned PriceOracle. Generate a FRESH oracle account keypair and rebuild the unsigned set with its pubkey.`);
    }
    const tx = Transaction.from(Buffer.from(readFileSync(join(DIR, step.file), 'utf8'), 'base64'));
    const needed = step.signers.map((p) => byPubkey.get(p)).filter(Boolean);
    if (needed.length !== step.signers.length) throw new Error(`step ${step.step}: missing signer(s) ${step.signers}`);
    tx.signatures = tx.signatures.map((s) => ({ publicKey: s.publicKey, signature: null }));
    tx.partialSign(...needed);
    const sim = await conn.simulateTransaction(tx);
    if (sim.value.err) throw new Error(`step ${step.step} ${step.action}: simulation failed ${JSON.stringify(sim.value.err)}\n${(sim.value.logs || []).slice(-6).join('\n')}`);
    const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    const latest = await conn.getLatestBlockhash('confirmed');
    await conn.confirmTransaction({ signature, ...latest }, 'confirmed');
    const slot = (await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))?.slot;
    sent[step.step] = { signature, slot, action: step.action };
    writeFileSync(sentPath, JSON.stringify(sent, null, 2));
    console.log(`step ${step.step} ${step.action}: confirmed ${signature} (slot ${slot})`);
  }
  // Finalize the schema-2 manifest with deployed addresses and the Initialize slot.
  // The oracle address is read back from the instrument's bound oracleAddr,
  // never from the build summary: a resumed build can name a different
  // (unprovisioned) oracle account while steps 1-5 are already sent.
  const { decodeAccount } = require('../mgk-frontend/packages/layout');
  const instrumentInfo = await conn.getAccountInfo(new PublicKey(summary.accounts.instrument));
  if (!instrumentInfo) throw new Error('instrument account missing at manifest finalize');
  const boundOracle = new PublicKey(Uint8Array.from(decodeAccount('Instrument', instrumentInfo.data).oracleAddr)).toBase58();
  const manifestPath = join(__dirname, '..', 'deployments', 'devnet-dprime.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const deployed = (address) => ({ status: 'deployed', address });
  manifest.accounts = {
    registry: deployed(summary.accounts.registry),
    instrument: deployed(summary.accounts.instrument),
    oracle: deployed(boundOracle),
    insurance: deployed(summary.accounts.vault),
    maker: deployed('DPs1NM3TeR9f9WQBgqrT27dmf8F4DoJJVyBpqT5NGr4o'),
  };
  manifest.start_slot = { status: 'set', slot: sent[2]?.slot };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`manifest updated: ${manifestPath} (start_slot ${sent[2]?.slot})`);
}

module.exports = { GUARDS };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
