'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import * as sdk from '@mgk/sdk';
import { assertDeployment } from './useSafeTransaction';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

/** Wallet funding is always read from RPC, including before portfolio creation. */
export function useReadiness() {
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();
  const session = useMemo(() => ({ publicKey, connected, connection }), [publicKey, connected, connection]);
  const [state, setState] = useState<{ session?: object; walletLamports: bigint | null; loading: boolean; error: string | null; signingBlockedReason: string | null }>({ walletLamports: null, loading: true, error: null, signingBlockedReason: 'Checking devnet deployment…' });
  const epoch = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++epoch.current;
    try {
      if (!publicKey || !connected) return;
      if (await connection.getGenesisHash() !== DEVNET_GENESIS) throw new Error('Wrong cluster. Select a devnet RPC and reconnect your wallet.');
      const balance = await connection.getBalance(publicKey, 'confirmed');
      if (!Number.isSafeInteger(balance) || balance < 0) throw new Error('Wallet balance unavailable: RPC returned an inexact balance.');
      let signingBlockedReason: string | null = null;
      try { await assertDeployment(connection); } catch (error) { signingBlockedReason = error instanceof Error ? error.message : 'Deployment unavailable. Reload and retry.'; }
      if (id === epoch.current) setState({ session, walletLamports: BigInt(balance), loading: false, error: null, signingBlockedReason });
    } catch (error) {
      if (id === epoch.current) setState({ session, walletLamports: null, loading: false, error: error instanceof Error ? error.message : String(error), signingBlockedReason: 'Cannot verify devnet. Check your RPC and retry.' });
    }
  }, [publicKey, connected, connection, session]);
  useEffect(() => {
    const requestEpoch = epoch;
    const timer = setTimeout(() => { void refresh(); }, 0);
    const interval = setInterval(() => { void refresh(); }, 10000);
    return () => { requestEpoch.current++; clearTimeout(timer); clearInterval(interval); };
  }, [refresh]);
  const getDevnetSol = useCallback(async () => {
    if (!publicKey || !connected) throw new Error('Connect a wallet to get devnet SOL.');
    if (await connection.getGenesisHash() !== DEVNET_GENESIS) throw new Error('Switch to a devnet RPC before requesting SOL.');
    const sig = await connection.requestAirdrop(publicKey, 1_000_000_000);
    await sdk.confirmSignature(connection, sig);
    await refresh();
    return { sig };
  }, [publicKey, connected, connection, refresh]);
  const current = connected && publicKey && state.session === session;
  return { ...(current ? state : { walletLamports: null, loading: !!connected, error: null, signingBlockedReason: connected ? 'Checking devnet deployment…' : 'Connect your wallet before signing.' }), refresh, getDevnetSol };
}
