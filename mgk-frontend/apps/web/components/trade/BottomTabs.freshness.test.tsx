import { act, fireEvent, render, screen } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '@/lib/config';
import { BottomTabs } from './BottomTabs';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
const user = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
vi.mock('@solana/wallet-adapter-react', () => {
  const connection = { getMultipleAccountsInfo: mocks.fetch };
  return {
    useWallet: () => ({ connected: true, publicKey: user }),
    useConnection: () => ({ connection }),
  };
});
// Match the existing polling suite's jsdom PDA shim; decode real wire data.
vi.mock('@mgk/sdk', async (original) => ({
  ...(await original<typeof import('@mgk/sdk')>()),
  derivePortfolioPda: () => [user, 255],
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('portfolio freshness on the trade screen', () => {
  it('withholds positions and collateral when subsequent RPC reads hang, and recovers on a fresh read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const bytes = new Uint8Array(2848);
    bytes[0] = 4;
    bytes[1] = 3;
    bytes.set(user.toBytes(), 8);
    const view = new DataView(bytes.buffer);
    view.setBigInt64(48, 500_000_000n, true);
    view.setUint16(208, 1, true);
    view.setBigInt64(224, 1000n, true);
    view.setBigInt64(232, 100_000_000n, true);
    const account = { data: bytes, owner: config.coreProgramId };
    mocks.fetch.mockResolvedValueOnce([account]).mockReturnValue(new Promise(() => {}));
    const { rerender } = render(<BottomTabs
      mark={{ price: 120_000_000n, batchId: 8n }}
      oracle={{ state: 'valid', price: 125_000_000n, ageSeconds: 0 }}
    />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('position-pnl')).toHaveTextContent('20.00 USD');
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByTestId('position-row')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(screen.getByText(/Portfolio unavailable.*refresh is stale/)).toBeInTheDocument();
    // Fresh market data must not revalue a portfolio whose chain refresh stalled.
    rerender(<BottomTabs
      mark={{ price: 130_000_000n, batchId: 9n }}
      oracle={{ state: 'valid', price: 130_000_000n, ageSeconds: 0 }}
    />);
    expect(screen.getByText(/Portfolio unavailable.*refresh is stale/)).toBeInTheDocument();
    expect(screen.queryByTestId('position-row')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Collateral' }));
    expect(screen.getByText(/Portfolio unavailable.*refresh is stale/)).toBeInTheDocument();
    expect(screen.queryByTestId('balances-equity')).not.toBeInTheDocument();
    mocks.fetch.mockResolvedValue([account]);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(screen.getByTestId('balances-equity')).toHaveTextContent('0.500000000 SOL');
    fireEvent.click(screen.getByRole('tab', { name: 'Positions' }));
    expect(screen.getByTestId('position-pnl')).toHaveTextContent('30.00 USD');
  });
});
