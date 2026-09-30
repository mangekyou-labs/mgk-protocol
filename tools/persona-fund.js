#!/usr/bin/env node
/**
 * Fund and initialize maker/taker personas for the playwright-cli live harness.
 *
 * Reuses tools/trade-e2e.js helpers (loadOrCreateTrader, ensureFunded,
 * ensurePortfolio, Deposit). Does not post orders.
 *
 * Usage: node tools/persona-fund.js
 * Env: RPC_URL / NEXT_PUBLIC_RPC_URL, DEPLOYER_KEYPAIR, MGK_*_KEYPAIR
 */
'use strict';

const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { join } = require('node:path');
const { homedir } = require('node:os');

const { loadWebEnv } = require('./lib/loadWebEnv.cjs');
const { redactRpcUrl, resolveRpcUrl } = require('./lib/liveSigning.cjs');
const {
  loadOrCreateTrader,
  ensureFunded,
  ensurePortfolio,
  deposit,
  loadKP,
  pda,
  CORE_ID,
  readPortfolioPrincipalLow64,
} = require('./trade-e2e.js');

const MIN_SOL = 0.5;
const DEPOSIT_LAMPORTS = 100_000_000n; // 0.1 SOL

async function main() {
  loadWebEnv();
  const rpc = resolveRpcUrl();
  const conn = new Connection(rpc, 'confirmed');
  const keeper = loadKP(
    process.env.DEPLOYER_KEYPAIR || join(homedir(), '.config/solana/id.json'),
  );
  const [vaultPda] = pda([Buffer.from('vault')], CORE_ID);

  console.log('=== mgk persona fund/init ===');
  console.log('RPC:', redactRpcUrl(rpc));
  console.log('Keeper:', keeper.publicKey.toBase58());

  const maker = loadOrCreateTrader('maker');
  const taker = loadOrCreateTrader('taker');
  if (maker.publicKey.equals(taker.publicKey)) {
    throw new Error('Maker and taker keypairs must be distinct');
  }

  console.log('Maker:', maker.publicKey.toBase58());
  console.log('Taker:', taker.publicKey.toBase58());

  await ensureFunded(conn, keeper, maker, MIN_SOL * LAMPORTS_PER_SOL);
  await ensureFunded(conn, keeper, taker, MIN_SOL * LAMPORTS_PER_SOL);

  const makerPort = await ensurePortfolio(conn, keeper, maker);
  const takerPort = await ensurePortfolio(conn, keeper, taker);

  for (const [label, user, port] of [
    ['maker', maker, makerPort],
    ['taker', taker, takerPort],
  ]) {
    const info = await conn.getAccountInfo(port);
    if (!info) throw new Error(`${label} portfolio missing after init`);
    const prin = readPortfolioPrincipalLow64(info.data);
    if (prin > 0n) {
      console.log('  ' + label + ' deposited (principal low64=' + prin + ')');
    } else {
      await deposit(conn, user, port, vaultPda, DEPOSIT_LAMPORTS);
    }
  }

  const makerBal = await conn.getBalance(maker.publicKey);
  const takerBal = await conn.getBalance(taker.publicKey);
  console.log('Maker SOL:', makerBal / LAMPORTS_PER_SOL, 'portfolio', makerPort.toBase58());
  console.log('Taker SOL:', takerBal / LAMPORTS_PER_SOL, 'portfolio', takerPort.toBase58());
  console.log('PASS: personas funded and portfolios ready');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Fatal:', e.message || e);
    process.exit(1);
  });
}

module.exports = { main };
