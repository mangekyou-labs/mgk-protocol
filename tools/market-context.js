"use strict";
const {PublicKey} = require('@solana/web3.js');
const {marketSeedBytes, marketSeeds, wrapInstruction} = require('../mgk-frontend/packages/layout/market');

/** Immutable context per invocation/process. Children bind the derived registry. */
function createMarketContext(coreProgramId, marketSeed) {
  const core = new PublicKey(coreProgramId);
  const seed = marketSeedBytes(marketSeed);
  const registry = PublicKey.findProgramAddressSync(marketSeeds([Buffer.from('registry')], seed), core)[0];
  return Object.freeze({
    registry,
    pda: (seeds, owner = core) => PublicKey.findProgramAddressSync(marketSeeds(seeds, seed, registry.toBytes()), owner),
    wrap: (program, data) => wrapInstruction(program, data, seed),
  });
}
function assertLegacyManifest(manifest) {
  if (manifest.schema_version === 2 || manifest.marketSeed) {
    throw Error('This legacy CLI does not support scoped markets; use the manifest-bound workers or runtime harness');
  }
}

function assertLegacyCliManifest() {
  if (!process.env.DEPLOYMENT_MANIFEST) return;
  const {readFileSync} = require('node:fs');
  const {loadManifest} = require('../mgk-frontend/packages/layout/manifest');
  const manifest = loadManifest(JSON.parse(readFileSync(process.env.DEPLOYMENT_MANIFEST, 'utf8')));
  assertLegacyManifest(manifest);
}
module.exports = {createMarketContext, assertLegacyManifest, assertLegacyCliManifest};
