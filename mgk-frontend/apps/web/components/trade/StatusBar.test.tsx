import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StatusBar } from './StatusBar';
import type { ProtocolStatusReading } from '@/lib/hooks/useProtocolStatus';
const wallet = vi.hoisted(() => ({
  connected: false,
  publicKey: null as { toBase58(): string } | null,
}));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => wallet }));
describe('Status bar', () => {
  it('never equates an attached wallet with healthy RPC', () => {
    wallet.connected = true;
    wallet.publicKey = {
      toBase58: () => 'DdqGmK5uamYN5vmuZrzpQhKeehLdwtPLVJdhu5P2iJKC',
    };
    render(
      <StatusBar status={{ data: null, error: 'offline', loading: false }} />,
    );
    expect(screen.getByTestId('status-wallet-label')).toHaveTextContent(
      'Wallet: connected',
    );
    expect(screen.getByTestId('status-rpc')).toHaveTextContent(
      'RPC: unavailable',
    );
    expect(screen.getByTestId('status-indexer-label')).toHaveTextContent(
      'down / unavailable',
    );
  });
  it.each([
    [{ severity: 'ok', syncing: false, lagSlots: 0 }, 'live'],
    [{ severity: 'warn', syncing: true, lagSlots: 151 }, 'syncing'],
    [{ severity: 'warn', available: false }, 'down / unavailable'],
  ])('reports indexer state from chain status %j', (indexer, label) => {
    const status = {
      data: {
        severity: 'ok',
        checks: { rpc: { severity: 'critical', reachable: false }, indexer },
      },
      loading: false,
      error: null,
    } as ProtocolStatusReading;
    render(<StatusBar status={status} />);
    expect(screen.getByTestId('status-rpc')).toHaveTextContent('unreachable');
    expect(screen.getByTestId('status-indexer-label')).toHaveTextContent(label);
  });
});
