'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { DEVNET_GENESIS, genesisHash } from '@/lib/genesis';
import { FAILURE_THRESHOLD, NETWORK_BUSY, friendlyRpcError } from '@/lib/polling';
import { assertDeployment } from './useSafeTransaction';

/** Below this a wallet cannot pay the signature fee plus a priority fee. */
export const MIN_FEE_LAMPORTS = 10_000n;

/** A definite answer from RPC (wrong cluster, bad balance), reported without retrying. */
class ReadinessError extends Error {}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Wallet funding is always read from RPC, including before portfolio creation. */
export function useReadiness() {
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();
  const session = useMemo(() => ({ publicKey, connected, connection }), [publicKey, connected, connection]);
  const [state, setState] = useState<{ session?: object; walletLamports: bigint | null; loading: boolean; error: string | null; signingBlockedReason: string | null }>({ walletLamports: null, loading: true, error: null, signingBlockedReason: 'Checking devnet deployment…' });
  const epoch = useRef(0);
  const failures = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++epoch.current;
    try {
      if (!publicKey || !connected) return;
      if (await genesisHash(connection) !== DEVNET_GENESIS) throw new ReadinessError('Wrong cluster. Select a devnet RPC and reconnect your wallet.');
      const balance = await connection.getBalance(publicKey, 'confirmed');
      if (!Number.isSafeInteger(balance) || balance < 0) throw new ReadinessError('Wallet balance unavailable: RPC returned an inexact balance.');
      let signingBlockedReason: string | null = null;
      try { await assertDeployment(connection); } catch (error) {
        // A busy RPC is retried like any other read; a real mismatch blocks signing now.
        if (friendlyRpcError(message(error)) === NETWORK_BUSY) throw error;
        signingBlockedReason = message(error) || 'Deployment unavailable. Reload and retry.';
      }
      if (id !== epoch.current) return;
      failures.current = 0;
      setState({ session, walletLamports: BigInt(balance), loading: false, error: null, signingBlockedReason });
    } catch (error) {
      if (id !== epoch.current) return;
      // Keep the last reading through transient failures; report once they persist.
      if (!(error instanceof ReadinessError) && ++failures.current < FAILURE_THRESHOLD) return;
      const text = error instanceof ReadinessError ? error.message : friendlyRpcError(message(error)) ?? NETWORK_BUSY;
      setState({ session, walletLamports: null, loading: false, error: text, signingBlockedReason: error instanceof ReadinessError ? 'Cannot verify devnet. Check your RPC and retry.' : NETWORK_BUSY });
    }
  }, [publicKey, connected, connection, session]);
  useEffect(() => {
    const requestEpoch = epoch;
    failures.current = 0;
    const timer = setTimeout(() => { void refresh(); }, 0);
    const interval = setInterval(() => { void refresh(); }, 10000);
    return () => { requestEpoch.current++; clearTimeout(timer); clearInterval(interval); };
  }, [refresh]);
  const current = connected && publicKey && state.session === session;
  const shown = current ? state : { walletLamports: null, loading: !!connected, error: null, signingBlockedReason: connected ? 'Checking devnet deployment…' : 'Connect your wallet before signing.' };
  const lowFeeBalance = shown.walletLamports !== null && shown.walletLamports < MIN_FEE_LAMPORTS;
  return { ...shown, lowFeeBalance, refresh };
}
