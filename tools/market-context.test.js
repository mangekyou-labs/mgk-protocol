'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PublicKey}=require('@solana/web3.js');
const {createMarketContext}=require('./market-context');
const core=new PublicKey('J5fVjwm96cQxcSqUz4QAmRBT75x7aN9NgG4xcnMmcfSv');
const matcher=new PublicKey('AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF');
test('contexts bind the same user/id/counter to distinct registry identities under the same IDs',()=>{
 const contexts=[createMarketContext(core),createMarketContext(core,new Uint8Array(32).fill(7)),createMarketContext(core,new Uint8Array(32).fill(8))];
 for(const kind of ['registry','vault','instrument','portfolio','batch','commitment','book','results']){
  const suffix=kind==='registry'||kind==='vault'?[]:kind==='portfolio'?[new Uint8Array(32).fill(4)]:kind==='instrument'||kind==='book'?[Buffer.alloc(2)]:kind==='commitment'?[Buffer.alloc(8),new Uint8Array(32).fill(4),Buffer.alloc(8)]:[Buffer.alloc(8)];
  const owner=['book','results'].includes(kind)?matcher:core;
  const actual=contexts.map(c=>c.pda([Buffer.from(kind),...suffix],owner)[0].toBase58());
  assert.equal(new Set(actual).size,3,kind);
  const expected=PublicKey.findProgramAddressSync([Buffer.from(kind),...(kind==='registry'?[new Uint8Array(32).fill(7)]:[contexts[1].registry.toBuffer()]),...suffix],owner)[0];
  assert.equal(actual[1],expected.toBase58(),kind+' exact documented seeds');
 }
});

test('legacy-only CLIs fail closed when a scoped manifest is selected', () => {
  const {assertLegacyManifest} = require('./market-context');
  assert.doesNotThrow(() => assertLegacyManifest({schema_version:1}));
  assert.throws(() => assertLegacyManifest({schema_version:2}), /does not support scoped/);
});

test('historical CLI entrypoints reject a selected scoped manifest before loading keys', () => {
  const {mkdtempSync, writeFileSync, rmSync} = require('node:fs');
  const {join} = require('node:path');
  const {tmpdir} = require('node:os');
  const {spawnSync} = require('node:child_process');
  const directory = mkdtempSync(join(tmpdir(), 'mgk-cli-scope-'));
  const path = join(directory, 'deployment.json');
  const raw = require('../deployments/devnet.json');
  writeFileSync(path, JSON.stringify({...raw, schema_version: 2, market_seed: core.toBase58()}));
  try {
    for (const name of ['init-protocol', 'deploy-devnet', 'trade-e2e', 'set-instrument-fees', 'set-instrument-oracle']) {
      const result = spawnSync(process.execPath, [join(__dirname, `${name}.js`)], {
        encoding: 'utf8', env: {...process.env, DEPLOYMENT_MANIFEST: path},
      });
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, /does not support scoped markets/, name);
    }
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
