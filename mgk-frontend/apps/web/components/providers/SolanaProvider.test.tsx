import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { getChainForEndpoint } from '@solana/wallet-standard-util';
import { browserRpcEndpoint, SolanaProvider } from './SolanaProvider';

vi.mock('@solana/wallet-adapter-react', () => ({
  ConnectionProvider: ({ endpoint, children }: { endpoint: string; children: ReactNode }) => (
    <div data-testid="connection" data-endpoint={endpoint}>{children}</div>
  ),
  WalletProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@solana/wallet-adapter-react-ui', () => ({
  WalletModalProvider: ({ children }: { children: ReactNode }) => children,
}));

afterEach(() => vi.unstubAllEnvs());

it('reads chain state through the same-origin RPC proxy', () => {
  render(<SolanaProvider>app</SolanaProvider>);
  expect(screen.getByTestId('connection')).toHaveAttribute('data-endpoint', `${window.location.origin}/api/rpc/devnet`);
});

it('ignores a public RPC variable so upstream keys stay server-side', () => {
  vi.stubEnv('NEXT_PUBLIC_RPC_URL', 'https://rpc.example.test');
  render(<SolanaProvider>app</SolanaProvider>);
  expect(screen.getByTestId('connection')).toHaveAttribute('data-endpoint', `${window.location.origin}/api/rpc/devnet`);
});

it('names devnet in the endpoint so wallets sign for devnet, not mainnet', () => {
  for (const origin of ['https://mgk-frontend.vercel.app', 'http://localhost:3000']) {
    vi.stubGlobal('location', new URL(origin));
    expect(getChainForEndpoint(browserRpcEndpoint())).toBe('solana:devnet');
  }
  vi.unstubAllGlobals();
});
