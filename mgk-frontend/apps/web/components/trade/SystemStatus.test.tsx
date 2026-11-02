import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { SystemStatus } from './SystemStatus';
import { StatusBar } from './StatusBar';
import { useProtocolStatus } from '@/lib/hooks/useProtocolStatus';
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({ connected: false, publicKey: null }),
}));
function LiveStatus() {
  const status = useProtocolStatus();
  return (
    <>
      <SystemStatus status={status} />
      <StatusBar status={status} />
    </>
  );
}
const healthy = {
  severity: 'ok',
  checks: {
    pause: { severity: 'ok', flags: 0 },
    oracle: { severity: 'ok' },
    batch: { severity: 'ok' },
    rpc: { severity: 'ok', reachable: true },
    indexer: { severity: 'ok', syncing: false, lagSlots: 0 },
  },
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('chain derived system status', () => {
  it('shows RPC independently of disconnected wallet and publicly lists restricted demo omissions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => healthy }),
    );
    render(<LiveStatus />);
    await waitFor(() =>
      expect(screen.getByTestId('status-rpc')).toHaveTextContent(
        'RPC: reachable',
      ),
    );
    expect(screen.getByTestId('status-wallet-label')).toHaveTextContent(
      'Wallet: disconnected',
    );
    expect(screen.getByTestId('status-cluster')).toHaveTextContent('devnet');
    expect(screen.getByText(/no ADL or socialized loss/i)).toBeInTheDocument();
    expect(screen.getByText(/Funding: off/i)).toBeInTheDocument();
  });
  it('shows exact pause scope plus oracle/batch outage and syncing history from status checks', () => {
    const status = {
      data: {
        ...healthy,
        checks: {
          ...healthy.checks,
          pause: { severity: 'critical' as const, flags: 1 | 2 | 4 | 32 },
          oracle: { severity: 'critical' as const },
          batch: { severity: 'critical' as const },
          indexer: { severity: 'warn' as const, syncing: true, lagSlots: 200 },
        },
      },
      loading: false,
      error: null,
    } as Parameters<typeof SystemStatus>[0]['status'];
    render(<SystemStatus status={status} />);
    expect(screen.getByText('New exposure paused.')).toBeInTheDocument();
    expect(screen.getByText('Withdrawals paused.')).toBeInTheDocument();
    expect(screen.getByText('Liquidations paused.')).toBeInTheDocument();
    expect(screen.getByText('Clearing paused.')).toBeInTheDocument();
    expect(screen.getByText(/Oracle stale or unavailable/)).toBeInTheDocument();
    expect(
      screen.getByText(/no settlement time is promised/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Indexer syncing/)).toBeInTheDocument();
  });
  it('clears a previously healthy status after an endpoint failure', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => healthy })
      .mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetcher);
    render(<LiveStatus />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('status-rpc')).toHaveTextContent(
      'RPC: reachable',
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByTestId('status-rpc')).toHaveTextContent(
      'RPC: unavailable',
    );
    expect(
      screen.getByText(/Indexer down \/ system status unavailable/),
    ).toBeInTheDocument();
  });
  it('expires healthy status while a subsequent request hangs', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => healthy })
        .mockReturnValue(new Promise(() => {})),
    );
    render(<LiveStatus />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('status-rpc')).toHaveTextContent(
      'RPC: reachable',
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
    });
    expect(screen.getByTestId('status-rpc')).toHaveTextContent(
      'RPC: unavailable',
    );
  });
});
