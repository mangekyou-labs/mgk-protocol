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

  it('renders the "Get devnet SOL" CTA pointing to the public faucet', () => {
    render(<Header />);
    const cta = screen.getByRole('link', { name: /get devnet sol/i });
    expect(cta).toHaveAttribute('href', 'https://faucet.solana.com');
    expect(cta).toHaveAttribute('target', '_blank');
    expect(cta).toHaveAttribute('rel', 'noopener noreferrer');
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
