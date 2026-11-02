#!/usr/bin/env node
/**
 * Read-only provisioning preflight for the devnet demo (issue #17).
 *
 * Checks, without signing or sending anything (0 SOL spent):
 *   - the deployment manifest parses and names three programs;
 *   - the RPC endpoint answers getHealth / getSlot at `confirmed`;
 *   - each manifest program account exists on-chain and is executable;
 *   - optional CHECK_PUBKEYS wallets report their devnet balances;
 *   - optional indexer /api/healthz answers.
 *
 * The RPC URL is never printed (host only), so output is safe to paste
 * into an issue. Exit code 0 means every check passed; warnings (for
 * example manifest accounts still pending before the #38 deploy) do
 * not fail the run.
 *
 * Env:
 *   RPC_URL        -- Solana RPC endpoint (default: public devnet)
 *   CHECK_PUBKEYS  -- comma-separated pubkeys to balance-check
 * Flags:
 *   --manifest <path>     (default: ../deployments/devnet.json)
 *   --indexer-url <url>   (also INDEXER_URL env)
 */
'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');

const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEFAULT_RPC = 'https://api.devnet.solana.com';

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-rpc';
  }
}

function isPubkey(value) {
  return typeof value === 'string' && PUBKEY_RE.test(value);
}

function parseManifest(text) {
  const m = JSON.parse(text);
  if (!m || typeof m !== 'object') throw new Error('manifest is not an object');
  const programs = m.programs || {};
  for (const name of ['perps_core', 'perps_matcher', 'oracle']) {
    if (!isPubkey(programs[name])) {
      throw new Error(`manifest programs.${name} missing or not a pubkey`);
    }
  }
  if (m.cluster !== 'devnet') {
    throw new Error(`manifest cluster is ${m.cluster}, expected devnet`);
  }
  return m;
}

function lamportsToSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

async function rpcCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'RPC error');
  return json.result;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const manifestPath = flag('--manifest') || join(__dirname, '..', 'deployments', 'devnet.json');
  const rpcUrl = process.env.RPC_URL || DEFAULT_RPC;
  const indexerUrl = flag('--indexer-url') || process.env.INDEXER_URL || '';
  const pubkeys = (process.env.CHECK_PUBKEYS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  let failures = 0;
  const ok = (msg) => console.log(`OK   ${msg}`);
  const warn = (msg) => console.log(`WARN ${msg}`);
  const fail = (msg) => { failures += 1; console.log(`FAIL ${msg}`); };

  console.log(`RPC host: ${hostOf(rpcUrl)}${process.env.RPC_URL ? '' : ' (public fallback)'}`);

  // Manifest (local file only).
  let manifest = null;
  try {
    manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
    ok(`manifest ${manifest.name}: 3 program IDs, cluster devnet`);
    for (const [name, ref] of Object.entries(manifest.accounts || {})) {
      if (ref && ref.status === 'deployed' && isPubkey(ref.address)) {
        ok(`manifest account ${name}: deployed`);
      } else {
        warn(`manifest account ${name}: pending (filled by the #38 deploy)`);
      }
    }
  } catch (e) {
    fail(`manifest: ${e.message}`);
  }

  // RPC health + slot.
  try {
    const health = await rpcCall(rpcUrl, 'getHealth', []);
    if (health !== 'ok') throw new Error(`getHealth=${health}`);
    const slot = await rpcCall(rpcUrl, 'getSlot', [{ commitment: 'confirmed' }]);
    ok(`RPC healthy at confirmed slot ${slot}`);
  } catch (e) {
    fail(`RPC: ${e.message}`);
  }

  // Programs exist and are executable (read-only getAccountInfo).
  if (manifest) {
    for (const [name, pubkey] of Object.entries(manifest.programs)) {
      try {
        const info = await rpcCall(rpcUrl, 'getAccountInfo', [pubkey, { commitment: 'confirmed' }]);
        const value = info && info.value;
        if (!value) fail(`program ${name} (${pubkey}): not found on devnet yet`);
        else if (!value.executable) fail(`program ${name} (${pubkey}): not executable`);
        else ok(`program ${name} (${pubkey}): deployed, executable`);
      } catch (e) {
        fail(`program ${name}: ${e.message}`);
      }
    }
  }

  // Optional wallet balances (pubkeys are public; no keys involved).
  for (const pubkey of pubkeys) {
    if (!isPubkey(pubkey)) { fail(`CHECK_PUBKEYS entry not a pubkey: ${pubkey}`); continue; }
    try {
      const bal = await rpcCall(rpcUrl, 'getBalance', [pubkey, { commitment: 'confirmed' }]);
      ok(`balance ${pubkey}: ${lamportsToSol(bal.value)} SOL`);
    } catch (e) {
      fail(`balance ${pubkey}: ${e.message}`);
    }
  }

  // Optional indexer health.
  if (indexerUrl) {
    try {
      const res = await fetch(`${indexerUrl.replace(/\/$/, '')}/api/healthz`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ok(`indexer ${hostOf(indexerUrl)}: /api/healthz healthy`);
    } catch (e) {
      fail(`indexer ${hostOf(indexerUrl)}: ${e.message} (sleeping free service?)`);
    }
  }

  console.log(failures === 0 ? 'PREFLIGHT PASSED' : `PREFLIGHT FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => { console.error(`FAIL preflight crashed: ${e.message}`); process.exit(1); });
}

module.exports = { hostOf, isPubkey, parseManifest, lamportsToSol };
