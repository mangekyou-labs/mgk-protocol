#!/usr/bin/env node
const {encodeInstruction} = require('../mgk-frontend/packages/layout/instructions.js');
const {decodeAccount,layouts} = require('../mgk-frontend/packages/layout/index.js');
const { confirmSignature } = require('../mgk-frontend/packages/layout/confirmation.js');
/**
 * Hardened standalone MGK Keeper Worker.
 *
 * Runs batch lifecycle cranking as a background worker (for Render / ops).
 * This replaces the embedded keeper that was inside the indexer process.
 *
 * Usage:
 *   node ops-keeper.js --loop --interval 5000   # continuous (default)
 *   node ops-keeper.js                          # one-shot
 *
 * Env vars:
 *   RPC_URL                -- Solana RPC endpoint
 *   KEEPER_KEYPAIR         -- path to keeper keypair JSON (default: ~/.config/solana/id.json)
 *   OR KEEPER_KEYPAIR_FILE -- same; file path to read at startup
 *   ORACLE_AUTHORITY_KEYPAIR      -- path to oracle authority keypair (for oracle posting)
 *   OR ORACLE_AUTHORITY_KEYPAIR_FILE
 *   BOOK_ADDRESS           -- matcher-owned book account
 *   PORTFOLIO_ADDRESSES    -- comma-separated portfolio PDAs (optional override)
 *   MAX_CONSECUTIVE_ERRORS -- fail-closed threshold (default: 5)
 *   INTERVAL               -- polling interval in ms (default: 5000)
 *   LOOP                   -- "1" for continuous, "0" or unset for one-shot
 */

'use strict';

const {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, ComputeBudgetProgram,
} = require('@solana/web3.js');
const { readFileSync, existsSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');

// ---------------------------------------------------------------------------
// Canonical program IDs
// ---------------------------------------------------------------------------
const CORE_ID = new PublicKey('9gr1GDrBF8MQMGSsbHYnUMTkvpzNLANiP5ZHhDKKAaDT');
const MATCHER_ID = new PublicKey('68MQqdugxZQA2F8GahhWZEusPnHbrfAXjqq2V9VCz8tK');
const ORACLE_PID = new PublicKey('GLAu9n48oqnVRKHNoqfpek3kZyGUJTJRPQKo7mF3qWmm');

// Batch statuses
const BATCH_COLLECTING = 0;
const BATCH_CLEARING = 2;
const BATCH_SETTLED = 3;

// Account sizes
const RESULTS_SIZE = 51 + 12 * 58;  // header(2) + max_fills(64) * 49
const INSTRUMENT_SIZE = layouts.Instrument.size;
const PORTFOLIO_SIZE = layouts.Portfolio.size;
const BATCH_SIZE_BYTES = 160;
const BOOK_ACCOUNT_SIZE = layouts.OrderBook.size + 256 * layouts.RestingOrder.size + 8;
const CLEAR_CU_LIMIT = 1_400_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function loadKP(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

function pda(seeds, prog) {
  return PublicKey.findProgramAddressSync(seeds, prog);
}

function le16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
}

function le64(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v), 0);
  return b;
}

function decodeBatch(data) {
 const b=decodeAccount('Batch',data);return {...b,batchId:Number(b.batchId),commitDeadlineSlot:Number(b.commitDeadlineSlot),clearingPrice:Number(b.clearingPrice),bidClear:Number(b.bidClearingPrice),askClear:Number(b.askClearingPrice),matchedBid:Number(b.matchedBidQty),matchedAsk:Number(b.matchedAskQty)};
}

function decodeRegistry(data) {
const r=decodeAccount('Registry',data);return {...r,governance:new PublicKey(r.governance),batchIdCounter:Number(r.batchIdCounter)};
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendRawWithRetry(conn, raw, label, maxRetries = 6) {
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const sig = await conn.sendRawTransaction(raw, { skipPreflight: false });
      await confirmSignature(conn, sig);
      console.log(`  [${label}] TX: ${sig}`);
      return sig;
    } catch (e) {
      lastErr = e;
      const msg = e && e.message ? e.message : String(e);
      if (msg.includes('429') && i < maxRetries - 1) {
        const wait = 1500 * Math.pow(2, i);
        console.log(`  [${label}] 429, retry in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function sendTx(conn, ix, signers, label) {
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  return sendRawWithRetry(conn, tx.serialize(), label);
}

// ---------------------------------------------------------------------------
// Load keypairs (with file-path env var support for Render secrets)
// ---------------------------------------------------------------------------
function loadKeeperKeypair() {
  const filePath = process.env.KEEPER_KEYPAIR || process.env.KEEPER_KEYPAIR_FILE;
  if (filePath && existsSync(filePath)) {
    return loadKP(filePath);
  }
  // Fallback to default solana CLI keypair
  const defaultPath = join(homedir(), '.config/solana/id.json');
  if (existsSync(defaultPath)) return loadKP(defaultPath);
  throw new Error('No keeper keypair found. Set KEEPER_KEYPAIR or KEEPER_KEYPAIR_FILE.');
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------
function resolveBook() {
  const bookEnv = process.env.BOOK_ADDRESS || process.env.NEXT_PUBLIC_BOOK_ADDRESS;
  if (bookEnv) return new PublicKey(bookEnv);
  const bookKeyPath = process.env.BOOK_KEYPAIR || join(homedir(), '.config/solana/mgk-book-keypair.json');
  try {
    const kp = loadKP(bookKeyPath);
    console.log('  Book keypair:', kp.publicKey.toBase58());
    return kp.publicKey;
  } catch {
    const fallback = pda([Buffer.from('book'), le16(0)], MATCHER_ID)[0];
    console.log('  Book PDA fallback:', fallback.toBase58());
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Liquidation candidate discovery (filtered core-program account scan)
// ---------------------------------------------------------------------------
async function discoverLiquidationCandidates(conn) {
  const accounts = await conn.getProgramAccounts(CORE_ID, {
    filters: [{ dataSize: PORTFOLIO_SIZE }],
    encoding: 'base64',
  });

  const candidates = [];
  for (const { pubkey, account } of accounts) {
    if (!account.owner.equals(CORE_ID)) continue;
    if (account.data.length < PORTFOLIO_SIZE) continue;
    // Portfolio layout: user(32) @0, collateral(8) @32, ...
    // A portfolio is a liquidation candidate if total_value < maintenance_margin
    // For simplicity, report all portfolios; the on-chain instruction does the actual check.
    candidates.push(pubkey);
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Unique settlement PDAs from cleared DFBA results
// ---------------------------------------------------------------------------
async function discoverSettlementPortfolios(conn, corePid, currentBatchId) {
  // Scan for all portfolio PDAs that might have positions from cleared results.
  // This replaces the old hardcoded two-persona approach.
  const accounts = await conn.getProgramAccounts(corePid, {
    filters: [{ dataSize: PORTFOLIO_SIZE }],
    encoding: 'base64',
  });

  const portfolios = [];
  for (const { pubkey, account } of accounts) {
    if (!account.owner.equals(corePid)) continue;
    if (account.data.length < PORTFOLIO_SIZE) continue;
    portfolios.push(pubkey);
  }
  return portfolios;
}

// ---------------------------------------------------------------------------
// Core batch cranking
// ---------------------------------------------------------------------------
async function crankOnce(conn, keeper, bookPDA, regPDA, vaultPDA) {
  // Resolve registry
  const regInfo = await conn.getAccountInfo(regPDA);
  if (!regInfo) {
    console.log('  Registry not found — skipping cycle');
    return;
  }
  const registry = decodeRegistry(Buffer.from(regInfo.data));

  if (registry.batchIdCounter === 0n) {
    console.log('  No batches yet (batch_id_counter=0) — skipping');
    return;
  }

  const currentBatchId = registry.batchIdCounter - 1n;
  const [batchPda] = pda([Buffer.from('batch'), le64(currentBatchId)], CORE_ID);
  const batchInfo = await conn.getAccountInfo(batchPda);
  if (!batchInfo) {
    console.log(`  Batch #${currentBatchId} not found — creating replacement`);
    // Create replacement batch
    await createBatch(conn, keeper, registry, regPDA);
    return;
  }
  const batch = decodeBatch(Buffer.from(batchInfo.data));

  if (batch.status === BATCH_SETTLED) {
    console.log(`  Batch #${currentBatchId} already settled — skipping`);
    return;
  }

  // Resolve instrument and oracle
  const [instPDA] = pda([Buffer.from('instrument'), le16(0)], CORE_ID);
  const instInfo = await conn.getAccountInfo(instPDA);
  if (!instInfo || instInfo.data.length < 92) {
    console.log('  Instrument not found — skipping');
    return;
  }
  const oraclePda = new PublicKey(decodeAccount('Instrument',instInfo.data).oracleAddr);

  console.log(`  Batch #${currentBatchId}: status=${batch.status} markValid=${batch.markValid} deadline=${batch.commitDeadlineSlot}`);

  // --- Phase 1: Collecting → Clearing ---
  if (batch.status === BATCH_COLLECTING) {
    const currentSlot = await conn.getSlot();
    if (currentSlot >= batch.commitDeadlineSlot || batch.totalCommitments >= registry.nMin) {
      console.log(`  [1/3] CloseCollecting: slot ${currentSlot} >= deadline ${batch.commitDeadlineSlot}`);
      await sendTx(conn, buildCloseCollectingIx(batchPda, regPDA), [keeper], 'Close');
    } else {
      console.log(`  [1/3] Waiting: slot ${currentSlot} < deadline ${batch.commitDeadlineSlot}`);
      return;
    }
  }

  // --- Phase 2: ClearBatch ---
  if (batch.status === BATCH_CLEARING) {
    const [resultsPda] = pda([Buffer.from('results'), le64(batch.batchId)], MATCHER_ID);
    console.log(`  [2/3] ClearBatch (DFBA) → results ${resultsPda.toBase58()}`);
    const clearTx = new Transaction();
    clearTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: CLEAR_CU_LIMIT }));
    clearTx.add(buildClearBatchIx(batchPda, bookPDA, resultsPda, MATCHER_ID, regPDA, instPDA, keeper.publicKey));
    clearTx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    clearTx.feePayer = keeper.publicKey;
    clearTx.sign(keeper);
    await sendRawWithRetry(conn, clearTx.serialize(), 'ClearBatch');

    // --- Phase 3: SettleBatch with dynamic settlement portfolios ---
    const nextBatchId = batch.batchId + 1;
    const [nextBatchPda, nextBatchBump] = pda([Buffer.from('batch'), le64(nextBatchId)], CORE_ID);

    // Discover settlement portfolios dynamically from cleared DFBA results
    // instead of using hardcoded persona addresses.
    let portfolios = [];
    const envPortfolios = (process.env.PORTFOLIO_ADDRESSES || '')
      .split(',').map(s => s.trim()).filter(Boolean).map(s => new PublicKey(s));

    if (envPortfolios.length > 0) {
      portfolios = envPortfolios;
      console.log(`  Using ${portfolios.length} env-specified portfolio(s)`);
    } else {
      // Discover from on-chain state
      portfolios = await discoverSettlementPortfolios(conn, CORE_ID, batch.batchId);
      console.log(`  Discovered ${portfolios.length} settlement portfolio(s) from on-chain state`);
    }

    console.log(`  [3/3] SettleBatch → next batch #${nextBatchId} @ ${nextBatchPda.toBase58()}`);
    await sendTx(conn,
      buildSettleBatchIx(
        batchPda, regPDA, vaultPDA, resultsPda, instPDA, bookPDA,
        oraclePda, MATCHER_ID, nextBatchPda, keeper.publicKey, nextBatchBump,
        portfolios,
      ),
      [keeper], 'Settle',
    );
    console.log('  Crank cycle complete.');
  }
}

async function createBatch(conn, keeper, registry, regPDA) {
  const batchKP = Keypair.generate();
  const nextId = registry.batchIdCounter;
  const lamports = await conn.getMinimumBalanceForRentExemption(BATCH_SIZE_BYTES);
  const tx = new Transaction();
  tx.add(SystemProgram.createAccount({
    fromPubkey: keeper.publicKey, newAccountPubkey: batchKP.publicKey,
    lamports, space: BATCH_SIZE_BYTES, programId: CORE_ID,
  }));
  const createData = Buffer.from(encodeInstruction('core','CreateBatch',{bump:0}));
  tx.add(new TransactionInstruction({
    keys: [
      { pubkey: batchKP.publicKey, isWritable: true, isSigner: true },
      { pubkey: regPDA, isWritable: true, isSigner: false },
    ],
    programId: CORE_ID,
    data: createData,
  }));
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.feePayer = keeper.publicKey;
  tx.sign(keeper, batchKP);
  const sig = await sendRawWithRetry(conn, tx.serialize(), 'CreateBatch');
  console.log(`  Batch #${nextId} created: ${sig} (${batchKP.publicKey.toBase58()})`);
}

function buildCloseCollectingIx(batchPda, registryPda) {
  return new TransactionInstruction({
    keys: [
      { pubkey: batchPda, isSigner: false, isWritable: true },
      { pubkey: registryPda, isSigner: false, isWritable: false },
    ],
    programId: CORE_ID,
    data: Buffer.from(encodeInstruction('core','CloseCommitting')), // disc CloseCommitting
  });
}

function buildClearBatchIx(batchPda, bookPda, resultsPda, matcherId, registryPda, instrumentPda, payer) {
  const data = Buffer.from(encodeInstruction('core','ClearBatch',{numCommitments:0,numInstruments:1,numPortfolios:0})); // num_portfolios
  return new TransactionInstruction({
    keys: [
      { pubkey: batchPda, isSigner: false, isWritable: true },
      { pubkey: bookPda, isSigner: false, isWritable: true },
      { pubkey: resultsPda, isSigner: false, isWritable: true },
      { pubkey: matcherId, isSigner: false, isWritable: false },
      { pubkey: registryPda, isSigner: false, isWritable: true },
      { pubkey: instrumentPda, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: CORE_ID,
    data,
  });
}

function buildSettleBatchIx(batchPda, registryPda, vaultPda, resultsPda, instrumentPda, bookPda, oraclePda, matcherId, nextBatchPda, payer, nextBatchBump, portfolioPdas) {
  const portfolios = portfolioPdas || [];
  const data = Buffer.from(encodeInstruction('core','SettleBatch',{numCommitments:0,numPortfolios:portfolios.length,nextBatchBump}));
  const keys = [
    { pubkey: batchPda, isSigner: false, isWritable: true },
    { pubkey: registryPda, isSigner: false, isWritable: true },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: resultsPda, isSigner: false, isWritable: true },
    { pubkey: instrumentPda, isSigner: false, isWritable: true },
    { pubkey: bookPda, isSigner: false, isWritable: false },
    { pubkey: oraclePda, isSigner: false, isWritable: false },
    { pubkey: matcherId, isSigner: false, isWritable: false },
  ];
  for (const p of portfolios) {
    keys.push({ pubkey: p, isSigner: false, isWritable: true });
  }
  keys.push(
    { pubkey: nextBatchPda, isSigner: false, isWritable: true },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  );
  return new TransactionInstruction({ keys, programId: CORE_ID, data });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const loop = process.argv.includes('--loop') || process.env.LOOP === '1';
  const intervalIdx = process.argv.indexOf('--interval');
  const interval = intervalIdx >= 0
    ? parseInt(process.argv[intervalIdx + 1])
    : parseInt(process.env.INTERVAL || '5000');
  const maxErrors = parseInt(process.env.MAX_CONSECUTIVE_ERRORS || '5');

  const rpc = process.env.RPC_URL || 'https://api.devnet.solana.com';
  const conn = new Connection(rpc, 'confirmed');
  const keeper = loadKeeperKeypair();

  const [regPDA] = pda([Buffer.from('registry')], CORE_ID);
  const [vaultPDA] = pda([Buffer.from('vault')], CORE_ID);
  const bookPDA = resolveBook();

  console.log('=== MGK Keeper Worker (standalone) ===');
  console.log('RPC:', new URL(rpc).host);
  console.log('Keeper:', keeper.publicKey.toBase58());
  console.log('Book:', bookPDA.toBase58());
  console.log('Max consecutive errors:', maxErrors);
  console.log('Balance:', (await conn.getBalance(keeper.publicKey)) / 1e9, 'SOL');

  let consecutiveErrors = 0;

  async function cycle() {
    try {
      await crankOnce(conn, keeper, bookPDA, regPDA, vaultPDA);
      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors++;
      console.error(`  Cycle error (${consecutiveErrors}/${maxErrors}):`, e.message || e);
      if (consecutiveErrors >= maxErrors) {
        console.error(`  FAIL-CLOSED: ${consecutiveErrors} consecutive errors exceeded threshold. Stopping.`);
        process.exit(1);
      }
    }
  }

  if (loop) {
    console.log(`\nPolling every ${interval}ms...\n`);
    while (true) {
      await cycle();
      await sleep(interval);
    }
  } else {
    await cycle();
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
