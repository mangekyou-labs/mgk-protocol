import { PublicKey } from '@solana/web3.js';
import { deriveBookPda, deriveInstrumentPda, deriveRegistryPda, deriveVaultPda } from '@mgk/sdk';
import { loadManifest } from '../../../packages/layout/manifest.js';
import rawManifest from '../../../../deployments/devnet.json';

// Optional public build-time manifest selects a scoped market without rewriting devnet.json.
export const deployment = loadManifest(process.env.NEXT_PUBLIC_DEPLOYMENT_MANIFEST_JSON ? JSON.parse(process.env.NEXT_PUBLIC_DEPLOYMENT_MANIFEST_JSON) : rawManifest);
const key = (value: string | null) => value ? new PublicKey(value) : null;
const coreProgramId = new PublicKey(deployment.programs.perps_core);
const matcherProgramId = new PublicKey(deployment.programs.perps_matcher);
const feeds = {
  // Pyth feed IDs (Hermes content-addressed, same across all networks)
  pythBtcFeedId: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  pythEthFeedId: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  pythSolFeedId: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
} as const;

const marketContext={marketSeed:deployment.marketSeed,coreProgramId};
if (deployment.ready && deployment.marketSeed && (
  deriveRegistryPda(coreProgramId, marketContext)[0].toBase58() !== deployment.accounts.registry ||
  deriveVaultPda(coreProgramId, marketContext)[0].toBase58() !== deployment.accounts.insurance ||
  deriveInstrumentPda(0, coreProgramId, marketContext)[0].toBase58() !== deployment.accounts.instrument
)) throw Error('Deployment namespace mismatch');
export const config = {
  marketSeed:deployment.marketSeed,
  marketContext,
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || 'https://api.devnet.solana.com',
  indexerUrl: process.env.NEXT_PUBLIC_INDEXER_URL || 'http://localhost:4000',
  hermesUrl: process.env.NEXT_PUBLIC_HERMES_URL || 'https://hermes.pyth.network',
  coreProgramId,
  matcherProgramId,
  oracleProgramId: new PublicKey(deployment.programs.oracle),
  registryAddress: key(deployment.accounts.registry),
  vaultAddress: key(deployment.accounts.insurance),
  instrumentAddress: key(deployment.accounts.instrument),
  oracleAddress: key(deployment.accounts.oracle),
  bookAddress: deployment.ready ? deriveBookPda(0, matcherProgramId, marketContext)[0] : null,
  deploymentReady: deployment.ready,
  ...feeds,
} as const;
export type AppConfig = typeof config;
