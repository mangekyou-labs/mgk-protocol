import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { state } from '@mgk/sdk';
import { Positions } from './Positions';
import { useMarketBar } from '@/lib/hooks/useMarketBar';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  instrument: 'SOL',
  oracle: {
    isActive: true,
    price: 125_000_000n,
    confidence: 0n,
    timestamp: 1000n,
    instrument: { equals: (key: string): boolean => key === 'SOL' },
  },
}));
vi.mock('@solana/wallet-adapter-react', () => {
  const connection = { getMultipleAccountsInfo: mocks.fetch };
  return { useConnection: () => ({ connection }) };
});
vi.mock('@/lib/config', () => ({
  config: {
    vaultAddress: 'vault',
    oracleAddress: 'oracle',
    instrumentAddress: 'SOL',
    coreProgramId: 'core',
    oracleProgramId: 'oracleProgram',
  },
}));
vi.mock('@/lib/stores/useBatchStore', () => ({
  useBatchPolling: () => ({
    data: null,
    registry: null,
    currentBatchId: null,
    error: null,
  }),
}));
vi.mock('@mgk/sdk', async (original) => ({
  ...(await original<typeof import('@mgk/sdk')>()),
  decodePriceOracle: () => mocks.oracle,
}));
const data = {
  positionsLen: 1,
  equity: 500_000_000n,
  positions: [
    {
      instrumentId: 0,
      qty: 1000n,
      entryVwap: 100_000_000n,
      entryRemainder: 0n,
      entryDenominator: 0n,
    },
  ],
} as state.PortfolioState;
function LivePositions() {
  const market = useMarketBar(30_000);
  return (
    <Positions
      data={data}
      mark={{ price: 120_000_000n, batchId: 8n }}
      oracle={market.oracle}
    />
  );
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe('live oracle position estimates', () => {
  it('expires the oracle between chain reads and rejects an oracle for another instrument', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    mocks.oracle.instrument = { equals: (key: string): boolean => key === 'SOL' };
    mocks.fetch.mockResolvedValue([
      null,
      { data: new Uint8Array(), owner: { equals: () => true } },
    ]);
    const { unmount } = render(<LivePositions />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('position-pnl')).toHaveTextContent('20.00 USD');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(screen.getByTestId('position-pnl')).toHaveTextContent('Unavailable');
    expect(screen.getByTestId('position-health')).toHaveTextContent(
      'Unavailable',
    );
    unmount();
    vi.setSystemTime(1_000_000);
    mocks.oracle.instrument = { equals: () => false };
    render(<LivePositions />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('position-pnl')).toHaveTextContent('Unavailable');
  });
  it('keeps the oracle estimate through one failed chain read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    mocks.oracle.instrument = { equals: (key: string): boolean => key === 'SOL' };
    mocks.fetch
      .mockResolvedValueOnce([
        null,
        { data: new Uint8Array(), owner: { equals: () => true } },
      ])
      .mockRejectedValue(new Error('429 Too Many Requests'));
    render(<LivePositions />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('position-pnl')).toHaveTextContent('20.00 USD');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('position-pnl')).toHaveTextContent('20.00 USD');
  });
});
