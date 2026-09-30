#!/usr/bin/env node
/**
 * Standalone MGK Oracle Worker.
 *
 * Posts prices to the PriceOracle on-chain account from multiple venue
 * sources with quorum, freshness, and deviation checks.
 *
 * Usage:
 *   node ops-oracle.js --loop                # continuous (default)
 *   node ops-oracle.js                       # one-shot
 *
 * Env vars:
 *   RPC_URL                     -- Solana RPC endpoint
 *   ORACLE_AUTHORITY_KEYPAIR    -- path to oracle authority keypair JSON
 *   OR ORACLE_AUTHORITY_KEYPAIR_FILE
 *   PRICE_ORACLE_ADDRESS        -- PriceOracle PDA (required)
 *   INSTRUMENT_ADDRESS          -- Instrument PDA (required)
 *   ORACLE_PROGRAM_ID           -- Oracle program ID (default: canonical)
 *   ORACLE_LOOP_INTERVAL        -- interval ms (default: 10000)
 *   QUORUM_VENUES               -- comma-separated venue names (default: binance,okx,bybit)
 *   MAX_FRESHNESS_SEC           -- max staleness in seconds (default: 30)
 *   MAX_DEVIATION_BPS           -- max price deviation in bps between venues (default: 50)
 *   LOOP                        -- "1" for continuous
 */

'use strict';

const {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
} = require('@solana/web3.js');
const { readFileSync, existsSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');

/** Mirror of `programs/oracle/src/state.rs` / SDK `PriceOracle` layout. */
const PRICE_ORACLE_SIZE = 128;
const PRICE_ORACLE_MAGIC = 0x4c43524f4c435250n;
const PRICE_ORACLE_VERSION = 0;

const SECRET_KEYS = [
  'rpcUrl',
  'RPC_URL',
  'NEXT_PUBLIC_RPC_URL',
  'keypairPath',
  'keeperKeypair',
  'secretKey',
  'privateKey',
  'apiKey',
];

// ---------------------------------------------------------------------------
// Canonical program ID
// ---------------------------------------------------------------------------
const ORACLE_PROGRAM_ID = new PublicKey(
  process.env.ORACLE_PROGRAM_ID || 'CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ',
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function loadKP(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Load oracle authority keypair (with file-path env var for Render secrets)
// ---------------------------------------------------------------------------
function loadOracleKeypair() {
  const filePath = process.env.ORACLE_AUTHORITY_KEYPAIR || process.env.ORACLE_AUTHORITY_KEYPAIR_FILE;
  if (filePath && existsSync(filePath)) {
    return loadKP(filePath);
  }
  const fallback = join(homedir(), '.config/solana/mgk-oracle-keypair.json');
  if (existsSync(fallback)) {
    console.log(`[oracle] Using fallback keypair: ${fallback}`);
    return loadKP(fallback);
  }
  throw new Error('No persisted keypair found. Set ORACLE_AUTHORITY_KEYPAIR.');
}

const VENUE_FETCH_TIMEOUT_MS = 3000;
const DEFAULT_MIN_VENUES = 2;

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function selectQuorumPrice(prices, opts) {
  const minVenues = (opts && opts.minVenues != null) ? opts.minVenues : DEFAULT_MIN_VENUES;
  const maxDeviationBps = (opts && opts.maxDeviationBps != null) ? opts.maxDeviationBps : 50;
  const maxFreshnessSec = (opts && opts.maxFreshnessSec != null) ? opts.maxFreshnessSec : 30;
  const now = (opts && opts.now != null) ? opts.now : Date.now();
  const list = Array.isArray(prices) ? prices : [];

  const valid = [];
  for (const p of list) {
    if (!p || typeof p.price !== 'number') continue;
    if (!Number.isFinite(p.price) || p.price <= 0) continue;
    if ((now - p.ts) / 1000 > maxFreshnessSec) continue;
    valid.push(p);
  }

  if (valid.length < minVenues) {
    return null;
  }

  if (valid.length >= 2) {
    const avg = valid.reduce((s, p) => s + p.price, 0) / valid.length;
    for (const p of valid) {
      const devBps = Math.abs((p.price - avg) / avg) * 10000;
      if (devBps > maxDeviationBps) {
        return null;
      }
    }
  }

  const sorted = valid.map(p => p.price).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return {
    price: BigInt(Math.round(median * 1_000_000)),
    confidence: BigInt(Math.round(median * 10_000)),
    venues: valid.map(p => p.venue),
  };
}

// ---------------------------------------------------------------------------
// Price fetching (multi-venue quorum)
// ---------------------------------------------------------------------------
const VENUE_FETCHERS = {
  binance: async () => {
    const res = await fetchWithTimeout('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', VENUE_FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    const json = await res.json();
    return { venue: 'binance', price: parseFloat(json.price), ts: Date.now() };
  },
  okx: async () => {
    const res = await fetchWithTimeout('https://www.okx.com/api/v5/market/ticker?instId=SOL-USDT', VENUE_FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    const json = await res.json();
    const last = json.data?.[0]?.last;
    if (!last) return null;
    return { venue: 'okx', price: parseFloat(last), ts: Date.now() };
  },
  bybit: async () => {
    const res = await fetchWithTimeout('https://api.bybit.com/v5/market/tickers?category=spot&symbol=SOLUSDT', VENUE_FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    const json = await res.json();
    const last = json.result?.list?.[0]?.lastPrice;
    if (!last) return null;
    return { venue: 'bybit', price: parseFloat(last), ts: Date.now() };
  },
};

async function fetchQuorumPrice(venues, maxFreshnessSec, maxDeviationBps, minVenues) {
  const results = await Promise.allSettled(
    venues.map(v => (VENUE_FETCHERS[v] ? VENUE_FETCHERS[v]() : Promise.resolve(null))),
  );

  const prices = results
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);

  const selected = selectQuorumPrice(prices, {
    minVenues: minVenues != null ? minVenues : DEFAULT_MIN_VENUES,
    maxDeviationBps,
    maxFreshnessSec,
  });
  if (!selected) {
    console.error('[oracle] Quorum failed (min venues / positivity / deviation / freshness)');
    return null;
  }
  console.log(`[oracle] Quorum: ${selected.venues.join(', ')} → price=${selected.price}`);
  return selected;
}

// ---------------------------------------------------------------------------
// On-chain posting
// ---------------------------------------------------------------------------
async function postPrice(conn, oracleAuthority, priceOraclePda, price, confidence) {
  // UpdatePrice: disc(1) + price(i64) + confidence(i64) = 17 bytes
  const data = Buffer.alloc(17);
  data.writeUInt8(1, 0); // disc UpdatePrice
  data.writeBigInt64LE(price, 1);
  data.writeBigInt64LE(confidence, 9);

  const tx = new Transaction();
  tx.add(new TransactionInstruction({
    keys: [
      { pubkey: priceOraclePda, isSigner: false, isWritable: true },
      { pubkey: oracleAuthority.publicKey, isSigner: true, isWritable: true },
    ],
    programId: ORACLE_PROGRAM_ID,
    data,
  }));

  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.feePayer = oracleAuthority.publicKey;
  tx.sign(oracleAuthority);

  let lastErr;
  for (let i = 0; i < 6; i++) {
    try {
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await conn.confirmTransaction(sig, 'confirmed');
      console.log(`[oracle] Posted price ${price} (${Number(price) / 1e6} USD): TX ${sig}`);
      return sig;
    } catch (e) {
      lastErr = e;
      const msg = e && e.message ? e.message : String(e);
      if (msg.includes('429') && i < 5) {
        const wait = 1500 * Math.pow(2, i);
        console.log(`[oracle] 429, retry in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const loop = process.argv.includes('--loop') || process.env.LOOP === '1';
  const interval = parseInt(process.env.ORACLE_LOOP_INTERVAL || '10000');
  const maxFreshnessSec = parseInt(process.env.MAX_FRESHNESS_SEC || '30');
  const maxDeviationBps = parseInt(process.env.MAX_DEVIATION_BPS || '50');
  const minVenues = parseInt(process.env.MIN_VENUES || String(DEFAULT_MIN_VENUES));
  const venues = (process.env.QUORUM_VENUES || 'binance,okx,bybit').split(',').map(v => v.trim());

  const rpc = process.env.RPC_URL || 'https://api.devnet.solana.com';
  const conn = new Connection(rpc, 'confirmed');
  const oracleAuthority = loadOracleKeypair();

  const priceOraclePda = new PublicKey(process.env.PRICE_ORACLE_ADDRESS);
  const instrumentPda = new PublicKey(process.env.INSTRUMENT_ADDRESS);

  console.log('=== MGK Oracle Worker (standalone) ===');
  console.log('RPC:', new URL(rpc).host);
  console.log('Authority:', oracleAuthority.publicKey.toBase58());
  console.log('PriceOracle:', priceOraclePda.toBase58());
  console.log('Instrument:', instrumentPda.toBase58());
  console.log('Venues:', venues.join(', '));
  console.log('Max freshness:', maxFreshnessSec, 'sec');
  console.log('Max deviation:', maxDeviationBps, 'bps');
  console.log('Interval:', interval, 'ms');

  let consecutiveFailures = 0;

  async function cycle() {
    try {
      const result = await fetchQuorumPrice(venues, maxFreshnessSec, maxDeviationBps, minVenues);
      if (result) {
        await postPrice(conn, oracleAuthority, priceOraclePda, result.price, result.confidence);
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
      }
    } catch (e) {
      consecutiveFailures += 1;
      console.error('[oracle] Cycle error:', e.message || e);
    }
    const health = evaluateOracleHealth({ consecutiveFailures });
    if (health.stopLoop) {
      throw new Error('oracle fail-closed: ' + consecutiveFailures + ' consecutive failures');
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

function decodePriceOracleAccount(buf) {
  if (!buf || buf.length < PRICE_ORACLE_SIZE) {
    const len = buf ? buf.length : 0;
    throw new Error(
      `decodePriceOracleAccount: buffer too small (${len} < ${PRICE_ORACLE_SIZE})`,
    );
  }

  const magic = buf.readBigUInt64LE(0);
  const version = buf.readUInt8(8);
  const bump = buf.readUInt8(9);
  const isActive = buf.readUInt8(10) !== 0;
  const authority = new PublicKey(buf.subarray(16, 48));
  const instrument = new PublicKey(buf.subarray(48, 80));
  const price = buf.readBigInt64LE(80);
  const timestamp = buf.readBigInt64LE(88);
  const confidence = buf.readBigInt64LE(96);

  if (magic !== PRICE_ORACLE_MAGIC) {
    throw new Error(
      `decodePriceOracleAccount: invalid magic 0x${magic.toString(16)}, expected 0x${PRICE_ORACLE_MAGIC.toString(16)}`,
    );
  }
  if (version !== PRICE_ORACLE_VERSION) {
    throw new Error(
      `decodePriceOracleAccount: unsupported version ${version}, expected ${PRICE_ORACLE_VERSION}`,
    );
  }

  return {
    magic,
    version,
    bump,
    isActive,
    authority,
    instrument,
    price,
    timestamp,
    confidence,
  };
}

function evaluateOracleHealth(snapshot) {
  const s = snapshot || {};
  const consecutiveFailures = s.consecutiveFailures || 0;
  const onChainAgeSecs = s.onChainAgeSecs || 0;
  const alerts = [];

  if (consecutiveFailures >= 10) {
    alerts.push({
      metric: 'oracle_post_failures',
      level: 'critical',
      message: consecutiveFailures + ' consecutive oracle post failures',
    });
  } else if (consecutiveFailures >= 3) {
    alerts.push({
      metric: 'oracle_post_failures',
      level: 'warning',
      message: consecutiveFailures + ' consecutive oracle post failures',
    });
  }

  if (onChainAgeSecs >= 600) {
    alerts.push({
      metric: 'oracle_staleness',
      level: 'critical',
      message: 'on-chain price age ' + onChainAgeSecs + 's',
    });
  } else if (onChainAgeSecs >= 60) {
    alerts.push({
      metric: 'oracle_staleness',
      level: 'warning',
      message: 'on-chain price age ' + onChainAgeSecs + 's',
    });
  }

  let severity = 'ok';
  for (const a of alerts) {
    if (a.level === 'critical') severity = 'critical';
    else if (a.level === 'warning' && severity !== 'critical') severity = 'warning';
  }

  const stopLoop = consecutiveFailures >= 10 || onChainAgeSecs >= 600;
  return {
    ok: severity !== 'critical',
    severity,
    alerts,
    stopLoop,
  };
}

function sanitizeHealthPayload(payload) {
  const out = {};
  if (!payload || typeof payload !== 'object') return out;
  for (const [k, v] of Object.entries(payload)) {
    if (SECRET_KEYS.includes(k)) continue;
    if (/rpcurl|api-key|apikey|keypair|secret/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

module.exports = {
  PRICE_ORACLE_SIZE,
  PRICE_ORACLE_MAGIC,
  PRICE_ORACLE_VERSION,
  decodePriceOracleAccount,
  evaluateOracleHealth,
  sanitizeHealthPayload,
  selectQuorumPrice,
  loadOracleKeypair,
  fetchQuorumPrice,
  DEFAULT_MIN_VENUES,
};

if (require.main === module) {
  main().catch(e => { console.error('Fatal:', e); process.exit(1); });
}
