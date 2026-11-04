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

it('reads chain state through the same-origin RPC proxy', () => {
  render(<SolanaProvider>app</SolanaProvider>);
  expect(screen.getByTestId('connection')).toHaveAttribute('data-endpoint', `${window.location.origin}/api/rpc`);
});

it('ignores a public RPC variable so upstream keys stay server-side', () => {
  vi.stubEnv('NEXT_PUBLIC_RPC_URL', 'https://rpc.example.test');
  render(<SolanaProvider>app</SolanaProvider>);
  expect(screen.getByTestId('connection')).toHaveAttribute('data-endpoint', `${window.location.origin}/api/rpc`);
});
