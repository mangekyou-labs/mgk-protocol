#!/usr/bin/env node
'use strict';
// Record a candidate immediately after building, then pass the saved manifest to the harness.
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const [directory, output] = process.argv.slice(2);
assert.ok(directory && output, 'usage: node tools/runtime/candidate.js ARTIFACT_DIRECTORY OUTPUT_MANIFEST');
const deployment = require('../../deployments/devnet.json');
const programs = [
  ['mgk_oracle', deployment.programs.oracle],
  ['mgk_perps_core', deployment.programs.perps_core],
  ['mgk_perps_matcher', deployment.programs.perps_matcher],
].map(([name, programId]) => {
  const path = resolve(join(directory, `${name}.so`)), bytes = readFileSync(path);
  assert.equal(bytes.subarray(0, 4).toString('hex'), '7f454c46', `${name}: expected ELF artifact`);
  return { name, programId, path, sha256: createHash('sha256').update(bytes).digest('hex') };
});
writeFileSync(output, JSON.stringify({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), programs }, null, 2) + '\n');
