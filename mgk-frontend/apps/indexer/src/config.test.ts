import {PublicKey} from '@solana/web3.js';
import {deriveRegistryPda, deriveVaultPda, deriveInstrumentPda} from '@mgk/sdk';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, it} from 'vitest';
import {loadDeployment, loadMonitoring} from './config.js';
it('loads repository defaults independently of the indexer working directory', () => {
  const deployment = loadDeployment();
  expect(deployment.ready).toBe(true);
  expect(deployment.startSlot).toBe(517959329);
  expect(loadMonitoring().feeFloorLamports).toBe('10000000');
});
it('refuses to index a pending manifest', () => {
  const deployed = JSON.parse(readFileSync(new URL('../../../../deployments/devnet.json', import.meta.url), 'utf8'));
  const pending = {...deployed,
    accounts: Object.fromEntries(Object.keys(deployed.accounts).map(k => [k, {status: 'pending'}])),
    start_slot: {status: 'pending'}};
  const path = join(mkdtempSync(join(tmpdir(), 'mgk-indexer-')), 'devnet.json');
  writeFileSync(path, JSON.stringify(pending));
  expect(() => loadDeployment(path)).toThrow('Deployment manifest pending');
});

it('rejects mixed scoped instruments even when registry and vault match', () => {
  const raw = JSON.parse(readFileSync(new URL('../../../../deployments/devnet.json', import.meta.url), 'utf8'));
  const core = new PublicKey(raw.programs.perps_core);
  const marketSeed = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
  const context = {marketSeed};
  const accounts = {...raw.accounts,
    registry: {status:'deployed', address:deriveRegistryPda(core, context)[0].toBase58()},
    insurance: {status:'deployed', address:deriveVaultPda(core, context)[0].toBase58()}};
  const path = join(mkdtempSync(join(tmpdir(), 'mgk-indexer-')), 'scoped.json');
  const manifest = {...raw, schema_version:2, market_seed:marketSeed, accounts};
  writeFileSync(path, JSON.stringify(manifest));
  expect(() => loadDeployment(path)).toThrow('namespace mismatch');
  accounts.instrument = {status:'deployed', address:deriveInstrumentPda(0, core, context)[0].toBase58()};
  writeFileSync(path, JSON.stringify(manifest));
  expect(loadDeployment(path).marketSeed).toBe(marketSeed);
});
