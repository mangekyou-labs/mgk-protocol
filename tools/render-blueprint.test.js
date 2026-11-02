'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const renderYaml = readFileSync(join(root, 'render.yaml'), 'utf8');

function serviceBlock(name) {
  const start = renderYaml.indexOf(`- name: ${name}`);
  assert.notEqual(start, -1, `render.yaml must define service ${name}`);
  const rest = renderYaml.slice(start);
  const next = rest.indexOf('\n  - name: ', 1);
  return next === -1 ? rest : rest.slice(0, next);
}

test('render defines keeper, oracle and maker workers with autoDeploy disabled', () => {
  for (const name of ['mgk-keeper', 'mgk-oracle', 'mgk-maker']) {
    const block = serviceBlock(name);
    assert.match(block, /type:\s*worker/, `${name} must be a background worker`);
    assert.match(block, /autoDeploy:\s*false/, `${name} must disable autoDeploy (pinned commits)`);
  }
});

test('every worker consumes the shared deployment manifest', () => {
  for (const name of ['mgk-keeper', 'mgk-oracle', 'mgk-maker']) {
    const block = serviceBlock(name);
    assert.match(block, /DEPLOYMENT_MANIFEST/, `${name} must set DEPLOYMENT_MANIFEST`);
    assert.match(block, /deployments\/devnet\.json/, `${name} must point at deployments/devnet.json`);
  }
  assert.match(serviceBlock('mgk-keeper'), /MONITORING_CONFIG/);
  assert.match(serviceBlock('mgk-maker'), /MONITORING_CONFIG/);
  assert.match(serviceBlock('mgk-keeper'), /KEEPER_KEYPAIR/);
  assert.match(serviceBlock('mgk-oracle'), /ORACLE_AUTHORITY_KEYPAIR/);
  assert.match(serviceBlock('mgk-maker'), /MAKER_KEYPAIR/);
  assert.match(serviceBlock('mgk-maker'), /maker-worker-cli\.js --loop/);
});

test('render has no legacy BATCH_ADDRESS or fixed backfill window overrides', () => {
  assert.doesNotMatch(renderYaml, /BATCH_ADDRESS/);
  assert.doesNotMatch(renderYaml, /BACKFILL_SLOTS/);
});

test('monitoring floors are positive and the uptime monitor is configured', () => {
  const monitoring = JSON.parse(readFileSync(join(root, 'deployments/monitoring.json'), 'utf8'));
  assert.match(monitoring.feeFloorLamports, /^[1-9][0-9]*$/);
  assert.match(monitoring.insuranceFloorLamports, /^[1-9][0-9]*$/);
  assert.equal(monitoring.uptime.path, '/api/status');
  assert.ok(monitoring.uptime.intervalSeconds >= 30 && monitoring.uptime.intervalSeconds <= 300);
  assert.ok(monitoring.uptime.alertChannel, 'an alert channel must be chosen');
});

test('runbooks cover cleared-unsettled, insurance exhaustion and rollback', () => {
  const cleared = join(root, 'docs/runbooks/cleared-unsettled.md');
  const insurance = join(root, 'docs/runbooks/insurance-exhausted.md');
  const rollback = join(root, 'docs/runbooks/rollback.md');
  for (const p of [cleared, insurance, rollback]) assert.ok(existsSync(p), `${p} must exist`);
  assert.match(readFileSync(cleared, 'utf8'), /2 min|120 s/);
  assert.match(readFileSync(insurance, 'utf8'), /uncovered|top.?up/i);
  const rollbackText = readFileSync(rollback, 'utf8');
  assert.match(rollbackText, /Vercel/);
  assert.match(rollbackText, /pinned commit/);
  assert.match(rollbackText, /\.so/);
});
