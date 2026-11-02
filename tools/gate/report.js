#!/usr/bin/env node
'use strict';
// Acceptance-gate report (issue #35). Renders one Markdown run record pinned
// to a source commit, the candidate `.so` SHA-256 hashes, program IDs and
// cluster. Each GATE_ROWS entry has exactly one required evidence tier from
// the issue #11 resolution; a pass at any other tier is rejected here so a
// lower-tier pass can never stand in for the required tier.
//
// CLI (mirrors tools/runtime/candidate.js and tools/runtime/audit.js):
//   node tools/gate/report.js --manifest candidate.json [--cluster devnet]
//                             [--rows rows.json] [--output report.md]
//   node tools/gate/report.js candidate.json [rows.json] [report.md]
// Rows JSON is an array of {id, status, tier, batchIds?, signatures?, notes?}
// (or an object with a `rows` array). Exits 2 on usage or validation errors.
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

// Required tiers, verbatim from the issue #11 resolution:
//   D devnet, D (browser) devnet in the browser, D′ throwaway devnet market,
//   L local runtime on identical bytecode, M manual wallet checklist.
const GATE_ROWS = Object.freeze([
  { id: 'P0-1', priority: 'P0', tier: 'D', title: 'Fresh wallet deposit 0.2 SOL: vault and collateral each rise by exactly 200,000,000 lamports; wallet delta reconciles; balance survives reload' },
  { id: 'P0-2', priority: 'P0', tier: 'M', title: 'Signing rejected, insufficient fee SOL or double click: no false success and no duplicate; retry path shown' },
  { id: 'P0-3', priority: 'P0', tier: 'D (browser)', title: 'Wrong cluster or manifest mismatch: signing blocked with an actionable message; no retry loop' },
  { id: 'P0-4', priority: 'P0', tier: 'D', title: 'Withdraw when flat: exact amount leaves the vault; second withdrawal and over-withdrawal reject' },
  { id: 'P0-5', priority: 'P0', tier: 'D', title: 'Post an order, then withdraw before it fills: withdrawal capped by the reservation' },
  { id: 'P0-6', priority: 'P0', tier: 'D', title: 'Three-wallet golden path (deposit, post, fill, partial close, full close, withdraw): exact reference-model lamports for realized PnL, 5 bps taker fee and fund delta; vault balance check holds' },
  { id: 'P0-7', priority: 'P0', tier: 'D', title: 'Both auctions in one batch: each clears at its own uniform price; maker role set by designation, not arrival time' },
  { id: 'P0-8', priority: 'P0', tier: 'L', title: 'Crossed taker/taker or maker/maker orders: no fill' },
  { id: 'P0-9', priority: 'P0', tier: 'D', title: 'Partial fill, then a fill in the next batch: filled + remaining = submitted; no duplicate fill' },
  { id: 'P0-10', priority: 'P0', tier: 'D', title: 'Cancel an unfilled or partially filled order: only the remainder cancels; reservation released pro rata; settled fills untouched' },
  { id: 'P0-11', priority: 'P0', tier: 'L', title: "Cancel racing clear, cancelling another user's order, or a direct matcher call with an arbitrary user: exactly one chain-consistent outcome; unauthorized calls reject" },
  { id: 'P0-12', priority: 'P0', tier: 'D', title: 'Add, partial close, full close, flip: correct weighted entry, realized/unrealized split and new entry after the flip; flat positions deleted' },
  { id: 'P0-13', priority: 'P0', tier: 'D', title: 'Two concurrent reduce-only closes, or a stale reduce-only order after the position closed: each fill clipped to the remaining position, excess cancelled, nothing opens or flips' },
  { id: 'P0-14', priority: 'P0', tier: 'L', title: 'Margin limits (insufficient withdrawable collateral, over 5x, over the 10 SOL position cap, or over the 50 SOL/side open-interest cap): rejected at post with the stated reason; settlement never rejects for margin' },
  { id: 'P0-15', priority: 'P0', tier: 'L', title: 'Withdrawal while a batch is Cleared but unsettled: blocked globally; works again after settlement' },
  { id: 'P0-16', priority: 'P0', tier: 'L', title: 'Oracle boundaries (age 60/61 s, confidence 1%/1%+, future-dated, wrong owner or instrument, inactive): settlement reverts with nothing applied and the keeper retries; posts, non-flat withdrawals and liquidation blocked; a flat portfolio can still withdraw' },
  { id: 'P0-17', priority: 'P0', tier: 'L', title: 'Liquidation of a healthy, health = 0 and unhealthy account: the first two reject; the unhealthy one has its orders cancelled, then is taken over in 25% steps with the liquidator initial margin checked each step; 1% + 1% penalties; value conserved' },
  { id: 'P0-18', priority: 'P0', tier: 'L', title: 'Bad debt within the fund: absorbed by the fund; balance check holds' },
  { id: 'P0-19', priority: 'P0', tier: 'L', title: 'Stress 1 and 2 (oracle $110 to $120, and the reverse): conversion drift of exactly -0.000758 / +0.000758 SOL to the fund' },
  { id: 'P0-20', priority: 'P0', tier: 'L', title: 'Stress 3: winner withdraws before the loser closes: winner paid at once; loser stays locked' },
  { id: 'P0-21', priority: 'P0', tier: 'L', title: 'Stress 4 exhaustion: winner credited in full; uncovered_bad_debt recorded; both pauses apply; debt paid off first; admin can only unpause after recovery' },
  { id: 'P0-22', priority: 'P0', tier: 'L', title: 'Risk-off below 0.4 x open interest: orders adding exposure reject; cancels, reduce-only orders, settlement, liquidation and withdrawals still work' },
  { id: 'P0-23', priority: 'P0', tier: 'L', title: 'Insurance top-up by anyone moves real lamports; fund withdrawal by a non-admin, or below the required reserve, rejects' },
  { id: 'P0-24', priority: 'P0', tier: 'L', title: 'Settlement with a missing or duplicate portfolio: the whole batch reverts' },
  { id: 'P0-25', priority: 'P0', tier: 'L', title: 'Clear run twice, settle run twice, or settling with another batch results: all rejected' },
  { id: 'P0-26', priority: 'P0', tier: 'L', title: 'Batch at the order cap: all involved portfolios settle in one transaction' },
  { id: 'P0-27', priority: 'P0', tier: 'L', title: 'Removed paths unreachable (market, IOC, post-only, commit/reveal, ComputeClearing, ClearAndMatch); maker_fee_bps < 0 rejects; funding never accrues' },
  { id: 'P0-28', priority: 'P0', tier: 'D', title: 'Keeper killed after clear and before settle: restarts and settles once; the next batch appears' },
  { id: 'P0-29', priority: 'P0', tier: 'L', title: 'Two concurrent keepers: no double processing; a missing batch account: keeper halts and alerts, with no fallback to an older batch' },
  { id: 'P0-30', priority: 'P0', tier: 'D', title: 'Indexer cold start or down: trading and balances stay truthful from RPC; UI shows unavailable, never 0; history backfills from the start slot with no duplicates' },
  { id: 'P0-31', priority: 'P0', tier: 'D′', title: 'Oracle worker stopped, maker stopped, or fee SOL below floor: fails closed after 60 s; each status check fires; UI banner shows; everything recovers when restored' },
  { id: 'P0-32', priority: 'P0', tier: 'D′', title: 'Both runbooks rehearsed with the admin key: Cleared > 2 min, and exhaustion: unpause withdrawals first' },
  { id: 'P0-33', priority: 'P0', tier: 'D', title: 'Latency: at least 30 taker orders over at least 30 minutes including a cold start; accepted p95 <= 5 s; settled p50 <= 20 s and max <= 60 s' },
  { id: 'P0-34', priority: 'P0', tier: 'D (browser)', title: 'UI truthfulness: lifecycle states, chart labelled not executable, unknown is never 0, a reason on every blocked action, restricted-demo omissions, earlier devnet balances not carried over' },
  { id: 'P0-35', priority: 'P0', tier: 'D', title: '2 h soak (about 700 batches) with the maker quoting and a scripted taker: end-of-run audit clean; no stuck Cleared batch; no missing batch' },
  { id: 'P1-1', priority: 'P1', tier: 'M', title: 'Wallet switch, reconnect and reload with no stale data' },
  { id: 'P1-2', priority: 'P1', tier: 'L', title: 'DFBA paper vectors: marginal pro-rata and identical-price allocation, with deterministic dust' },
  { id: 'P1-3', priority: 'P1', tier: 'L', title: 'Adversarial and overflow inputs at the order cap' },
  { id: 'P1-4', priority: 'P1', tier: 'D′', title: 'Pause banner and paused-state UI in the browser' },
].map(row => Object.freeze({ ...row, scenario: row.title })));

const BY_ID = new Map(GATE_ROWS.map(row => [row.id, row]));
const STATUSES = new Set(['pass', 'fail', 'not run']);

// Tier spellings are equivalent only in notation (prime vs apostrophe),
// never in evidence level: L never counts as D, and so on.
function normalizeTier(tier) {
  if (typeof tier !== 'string') return tier;
  return tier.trim().replace(/′/g, "'").replace(/\s+/g, ' ');
}
function tiersEqual(a, b) {
  return normalizeTier(a) === normalizeTier(b);
}

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function evidenceText(row) {
  const parts = [];
  if (row.batchIds?.length) parts.push(`batches: ${row.batchIds.join(', ')}`);
  if (row.batchId !== undefined) parts.push(`batch: ${row.batchId}`);
  if (row.signatures?.length) parts.push(`signatures: ${row.signatures.join(', ')}`);
  if (row.signature) parts.push(`signature: ${row.signature}`);
  if (row.expected !== undefined) parts.push(`expected: ${row.expected}`);
  if (row.observed !== undefined) parts.push(`observed: ${row.observed}`);
  if (row.notes) parts.push(String(row.notes));
  if (row.note) parts.push(String(row.note));
  if (row.evidence) parts.push(String(row.evidence));
  return parts.join('; ');
}

// Build the pinned Markdown report. `programs` is the candidate manifest
// program list ([{name, programId, sha256}]); `rows` supplies per-row
// results and defaults every unsupplied row to "not run".
function buildReport({ commit, cluster, programs, rows } = {}) {
  assert.ok(typeof commit === 'string' && commit.trim(), 'commit pin required');
  assert.ok(typeof cluster === 'string' && cluster.trim(), 'cluster pin required');
  assert.ok(Array.isArray(programs) && programs.length, 'programs pin required: [{name, programId, sha256}]');
  for (const program of programs) {
    assert.ok(program && typeof program.name === 'string' && program.name, 'program name required');
    assert.ok(typeof program.programId === 'string' && program.programId, `${program.name}: programId required`);
    assert.match(String(program.sha256 ?? ''), /^[a-f0-9]{64}$/i, `${program.name}: sha256 (SHA-256 of the .so) required`);
  }
  const supplied = new Map();
  for (const row of rows ?? []) {
    assert.ok(row && typeof row.id === 'string', 'row id required');
    const gate = BY_ID.get(row.id);
    assert.ok(gate, `unknown row id: ${row.id}`);
    assert.ok(!supplied.has(row.id), `duplicate row id: ${row.id}`);
    const status = row.status ?? 'not run';
    assert.ok(STATUSES.has(status), `${row.id}: status must be pass, fail, or not run`);
    if (status === 'pass') {
      assert.ok(
        row.tier !== undefined && tiersEqual(row.tier, gate.tier),
        `${row.id}: pass requires tier ${gate.tier}, got ${row.tier ?? 'none'} (no tier substitution)`,
      );
    }
    supplied.set(row.id, row);
  }
  const lines = [
    '# Acceptance gate report',
    '',
    `- Commit: \`${commit}\``,
    `- Cluster: ${cluster}`,
    '',
    '## Programs',
    '',
    '| Program | Program ID | .so SHA-256 |',
    '|---|---|---|',
    ...programs.map(p => `| ${escapeCell(p.name)} | \`${p.programId}\` | \`${String(p.sha256).toLowerCase()}\` |`),
    '',
    'Local (L) rows are proved on identical bytecode locally, not observed on devnet.',
    '',
    '## Gate rows',
    '',
    '| Row | Scenario | Required tier | Result | Evidence |',
    '|---|---|---|---|---|',
  ];
  for (const gate of GATE_ROWS) {
    const row = supplied.get(gate.id);
    const status = row?.status ?? 'not run';
    let evidence = row ? evidenceText(row) : '';
    if (row && row.tier !== undefined && !tiersEqual(row.tier, gate.tier) && status !== 'pass') {
      evidence = [evidence, `recorded tier ${row.tier}, requires ${gate.tier}`].filter(Boolean).join('; ');
    }
    lines.push(`| ${gate.id} | ${escapeCell(gate.title)} | ${gate.tier} | ${status} | ${escapeCell(evidence)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = { manifest: null, cluster: null, rows: null, output: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--manifest') options.manifest = argv[++i];
    else if (arg === '--cluster') options.cluster = argv[++i];
    else if (arg === '--rows') options.rows = argv[++i];
    else if (arg === '--output') options.output = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`unknown argument ${arg}`);
    else positional.push(arg);
  }
  if (!options.manifest && positional.length) options.manifest = positional.shift();
  if (!options.rows && positional.length) options.rows = positional.shift();
  if (!options.output && positional.length) options.output = positional.shift();
  if (positional.length) throw new Error(`unexpected argument ${positional[0]}`);
  for (const [flag, value] of [['--manifest', options.manifest], ['--cluster', options.cluster], ['--rows', options.rows], ['--output', options.output]]) {
    if ((flag === '--manifest' || flag === '--cluster' || flag === '--rows' || flag === '--output') &&
      argv.includes(flag) && value === undefined) throw new Error(`${flag}: missing value`);
  }
  assert.ok(options.manifest, 'usage: node tools/gate/report.js --manifest candidate.json [--cluster devnet] [--rows rows.json] [--output report.md]');
  return options;
}

function loadRows(path) {
  if (!path) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : parsed.rows;
  assert.ok(Array.isArray(rows), `${path}: rows JSON must be an array or {rows: [...]}`);
  return rows;
}

function main(argv) {
  const options = parseArgs(argv);
  const manifest = JSON.parse(readFileSync(resolve(options.manifest), 'utf8'));
  const markdown = buildReport({
    commit: manifest.commit,
    cluster: options.cluster ?? manifest.cluster ?? 'localnet',
    programs: manifest.programs,
    rows: loadRows(options.rows ? resolve(options.rows) : null),
  });
  if (options.output) writeFileSync(resolve(options.output), markdown);
  return { manifest: options.manifest, cluster: options.cluster ?? manifest.cluster ?? 'localnet', output: options.output ?? null, markdown };
}

if (require.main === module) {
  try {
    const result = main(process.argv.slice(2));
    if (!result.output) process.stdout.write(result.markdown);
  } catch (error) {
    process.stderr.write(`report failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { GATE_ROWS, buildReport, parseArgs, main, normalizeTier };
