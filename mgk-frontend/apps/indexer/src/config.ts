import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import {deriveRegistryPda, deriveVaultPda, deriveInstrumentPda} from '@mgk/sdk';
import { loadManifest } from '../../../packages/layout/manifest.js';

const deploymentFile = (name: string) => fileURLToPath(new URL(`../../../../deployments/${name}`, import.meta.url));
export function loadDeployment(path = process.env.DEPLOYMENT_MANIFEST ?? deploymentFile('devnet.json')) {
  const raw: unknown = JSON.parse(readFileSync(resolve(path), 'utf8'));
  const manifest = loadManifest(raw);
  if (!manifest.ready) throw new Error('Deployment manifest pending: deploy accounts and set start_slot before indexing');
  if (manifest.marketSeed) {
    const core = new PublicKey(manifest.programs.perps_core);
    const context = {marketSeed: manifest.marketSeed};
    if (deriveRegistryPda(core, context)[0].toBase58() !== manifest.accounts.registry ||
        deriveVaultPda(core, context)[0].toBase58() !== manifest.accounts.insurance ||
        deriveInstrumentPda(0, core, context)[0].toBase58() !== manifest.accounts.instrument) throw Error('Deployment namespace mismatch');
  }
  return manifest;
}
export interface MonitoringConfig {
  feePayers: { keeper: string | null; oracle: string | null; maker: string | null };
  feeFloorLamports: string;
  insuranceFloorLamports: string;
}
export function loadMonitoring(path = process.env.MONITORING_CONFIG ?? deploymentFile('monitoring.json')): MonitoringConfig {
  const config = JSON.parse(readFileSync(resolve(path), 'utf8')) as MonitoringConfig;
  for (const floor of [config.feeFloorLamports, config.insuranceFloorLamports]) {
    if (typeof floor !== 'string' || !/^[1-9][0-9]*$/.test(floor)) throw new Error('Monitoring floors must be positive decimal lamports');
  }
  for (const role of ['keeper', 'oracle', 'maker'] as const) {
    const address = config.feePayers[role];
    if (address !== null) new PublicKey(address);
  }
  return config;
}
