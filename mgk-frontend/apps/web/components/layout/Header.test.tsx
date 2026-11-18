import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';

import { Header } from './Header';

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/trade'),
}));

vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: vi.fn(() => ({
    autoConnect: false,
    wallets: [],
    wallet: null,
    publicKey: null,
    connecting: false,
    connected: false,
    disconnecting: false,
    select: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    sendTransaction: vi.fn(),
  })),
}));

vi.mock('@solana/wallet-adapter-react-ui', () => ({
  useWalletModal: vi.fn(() => ({ visible: false, setVisible: vi.fn() })),
}));

describe('Header', () => {
  it('renders the mgk logo', () => {
    render(<Header />);
    expect(screen.getByLabelText('mgk')).toBeInTheDocument();
  });

  it('links only to the trade screen, with no Portfolio nav', () => {
    render(<Header />);
    expect(screen.getByRole('link', { name: 'Trade' })).toHaveAttribute('href', '/trade');
    expect(screen.queryByRole('link', { name: 'Portfolio' })).toBeNull();
  });

  it('has no faucet step in the header', () => {
    render(<Header />);
    expect(screen.queryByRole('link', { name: /devnet sol|faucet/i })).toBeNull();
  });

  it('renders the wallet button', () => {
    render(<Header />);
    expect(screen.getByTestId('wallet-button')).toBeInTheDocument();
  });

  it('is 44px tall per the design spec', () => {
    render(<Header />);
    const header = screen.getByTestId('app-header');
    expect(header.className).toMatch(/h-11/);
  });

  it('marks the active nav link with aria-current="page"', () => {
    render(<Header />);
    expect(screen.getByRole('link', { name: 'Trade' })).toHaveAttribute('aria-current', 'page');
  });
});
