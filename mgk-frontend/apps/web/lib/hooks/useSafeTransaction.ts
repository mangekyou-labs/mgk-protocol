'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { VersionedTransaction, type Connection, type Transaction } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';
import { config, deployment } from '@/lib/config';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

/** Every signing path checks the actual RPC cluster and manifest accounts. */
export async function assertDeployment(connection: Connection): Promise<void> {
  if (!config.deploymentReady) throw new Error('Demo deployment is pending. Wait for the published devnet market before signing.');
  if (deployment.cluster !== 'devnet' || await connection.getGenesisHash() !== DEVNET_GENESIS) {
    throw new Error('Wrong cluster. Select a devnet RPC and reconnect your wallet.');
  }
  const response = await fetch('/api/deployment-manifest', { cache: 'no-store' });
  if (!response.ok) throw new Error('Cannot verify the current deployment manifest. Reload or retry when the app is reachable.');
  const current = await response.json();
  // Compare named fields rather than relying on JSON object key order.
  const identity = (value: typeof deployment) => [value.name, value.cluster, value.startSlot, value.ready,
    ...(['perps_core', 'perps_matcher', 'oracle'] as const).map(k => value.programs?.[k]),
    ...(['registry', 'instrument', 'oracle', 'insurance', 'maker'] as const).map(k => value.accounts?.[k])];
  if (JSON.stringify(identity(current)) !== JSON.stringify(identity(deployment))) {
    throw new Error('Deployment manifest mismatch. Reload the app to use the current devnet market before signing.');
  }
  const programs = [config.coreProgramId, config.matcherProgramId, config.oracleProgramId];
  const addresses = [config.registryAddress, config.instrumentAddress, config.oracleAddress, config.vaultAddress];
  if (addresses.some(a => !a)) throw new Error('Deployment manifest mismatch. Reload the app with the current devnet deployment.');
  const accounts = await connection.getMultipleAccountsInfo([...programs, ...addresses.map(a => a!)], 'confirmed');
  const mismatch = () => new Error('Deployment manifest mismatch. Reload the current app build or contact the operator; signing is blocked.');
  if (programs.some((_, i) => !accounts[i]?.executable)) throw mismatch();
  for (let i = 0; i < addresses.length; i++) {
    const owner = i === 2 ? config.oracleProgramId : config.coreProgramId;
    if (!accounts[i + 3]?.owner.equals(owner)) throw mismatch();
  }
  try {
    sdk.state.decodeRegistry(new Uint8Array(accounts[3]!.data));
    const instrument = sdk.state.decodeInstrument(new Uint8Array(accounts[4]!.data));
    if (instrument.instrumentId !== 0 || !instrument.oracleAddr.equals(config.oracleAddress!)) throw mismatch();
    sdk.state.decodeAccount('PriceOracle', new Uint8Array(accounts[5]!.data));
    sdk.state.decodeAccount('Vault', new Uint8Array(accounts[6]!.data));
  } catch { throw mismatch(); }
}

/** Simulate before requesting a signature; invalidate work on wallet/RPC changes. */
export function useSafeTransaction() {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const identity = useRef({ publicKey, connected, connection });
  const busy = useRef(false);
  useEffect(() => { identity.current = { publicKey, connected, connection }; }, [publicKey, connected, connection]);
  useEffect(() => () => { identity.current = { publicKey: null, connected: false, connection }; }, [connection]);

  return useCallback(async (tx: Transaction): Promise<string> => {
    if (!publicKey || connected === false) throw new Error('Connect your wallet before signing.');
    if (busy.current) throw new Error('A wallet request is already in progress.');
    busy.current = true;
    const unchanged = () => {
      const now = identity.current;
      if (!now.publicKey?.equals(publicKey) || now.connected === false || now.connection !== connection) {
        throw new Error('Wallet or RPC changed. Review the amount and retry.');
      }
    };
    try {
      await assertDeployment(connection);
      unchanged();
      const latest = await connection.getLatestBlockhash('confirmed');
      tx.feePayer = publicKey;
      tx.recentBlockhash = latest.blockhash;
      const simulation = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, commitment: 'confirmed' });
      if (simulation.value.err) throw new Error(`Simulation failed; no signature requested: ${JSON.stringify(simulation.value.err)}`);
      unchanged();
      return await sendTransaction(tx, connection, { skipPreflight: false, preflightCommitment: 'confirmed' });
    } finally { busy.current = false; }
  }, [publicKey, connected, sendTransaction, connection]);
}
