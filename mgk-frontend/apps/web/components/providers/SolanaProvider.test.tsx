import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { SolanaProvider } from './SolanaProvider';

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

it('uses devnet when CI supplies an empty RPC variable', () => {
  vi.stubEnv('NEXT_PUBLIC_RPC_URL', '');
  render(<SolanaProvider>app</SolanaProvider>);
  expect(screen.getByTestId('connection')).toHaveAttribute('data-endpoint', 'https://api.devnet.solana.com');
});

it('preserves an explicitly configured RPC endpoint', () => {
  vi.stubEnv('NEXT_PUBLIC_RPC_URL', 'https://rpc.example.test');
  render(<SolanaProvider>app</SolanaProvider>);
  expect(screen.getByTestId('connection')).toHaveAttribute('data-endpoint', 'https://rpc.example.test');
});
