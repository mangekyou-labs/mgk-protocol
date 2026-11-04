'use client';

import { useMemo, type ReactNode } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';

import '@solana/wallet-adapter-react-ui/styles.css';

/** Server-side placeholder; Connection needs an absolute URL but never fetches during SSR. */
const SSR_RPC = 'https://api.devnet.solana.com';

/** Every browser read and send goes through the same-origin proxy, which holds the upstream keys. */
export function browserRpcEndpoint(): string {
  return typeof window === 'undefined' ? SSR_RPC : `${window.location.origin}/api/rpc`;
}

export function SolanaProvider({ children }: { children: ReactNode }) {
  const endpoint = useMemo(() => browserRpcEndpoint(), []);

  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
