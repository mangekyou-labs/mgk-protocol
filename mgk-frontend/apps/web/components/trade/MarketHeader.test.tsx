import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MarketHeader } from './MarketHeader';

const usd = (dollars: number) => BigInt(Math.round(dollars * 1_000_000));

describe('<MarketHeader />', () => {
  it('names the single market', () => {
    render(<MarketHeader oracle={{ state: 'unavailable', price: null, ageSeconds: null }} mark={null} collectingBatchId={null} />);
    expect(screen.getByTestId('market-selector')).toHaveTextContent('SOL-USD Perp');
  });

  it('shows the oracle price with its age', () => {
    render(
      <MarketHeader
        oracle={{ state: 'valid', price: usd(150.25), ageSeconds: 3 }}
        mark={null}
        collectingBatchId={null}
      />,
    );
    expect(screen.getByTestId('stat-oracle')).toHaveTextContent('$150.25 3s');
  });

  it('flags a stale oracle with how old it is', () => {
    render(
      <MarketHeader
        oracle={{ state: 'stale', price: usd(150.25), ageSeconds: 74 }}
        mark={null}
        collectingBatchId={null}
      />,
    );
    expect(screen.getByTestId('stat-oracle')).toHaveTextContent('$150.25 · stale 74s');
  });

  it('says the oracle is unavailable instead of showing a price', () => {
    render(
      <MarketHeader oracle={{ state: 'unavailable', price: null, ageSeconds: null }} mark={null} collectingBatchId={null} />,
    );
    const oracle = screen.getByTestId('stat-oracle');
    expect(oracle).toHaveTextContent('unavailable');
    expect(oracle).not.toHaveTextContent('$');
  });

  it('labels the mark with the batch it came from', () => {
    render(
      <MarketHeader
        oracle={{ state: 'valid', price: usd(150), ageSeconds: 1 }}
        mark={{ price: usd(149.9), batchId: 41n }}
        collectingBatchId={42n}
      />,
    );
    expect(screen.getByTestId('stat-mark')).toHaveTextContent('$149.90 batch 41');
  });

  it('shows the batch currently collecting orders', () => {
    render(
      <MarketHeader oracle={{ state: 'valid', price: usd(150), ageSeconds: 1 }} mark={null} collectingBatchId={42n} />,
    );
    expect(screen.getByTestId('stat-collecting')).toHaveTextContent('batch 42');
  });

  it('renders unknown mark and batch as "--", never 0', () => {
    render(
      <MarketHeader oracle={{ state: 'unavailable', price: null, ageSeconds: null }} mark={null} collectingBatchId={null} />,
    );
    expect(screen.getByTestId('stat-mark')).toHaveTextContent('--');
    expect(screen.getByTestId('stat-collecting')).toHaveTextContent('--');
    expect(screen.getByTestId('market-header')).not.toHaveTextContent(/\b0(\.00)?\b/);
  });

  it('states that funding is off', () => {
    render(
      <MarketHeader oracle={{ state: 'valid', price: usd(150), ageSeconds: 1 }} mark={null} collectingBatchId={1n} />,
    );
    expect(screen.getByTestId('stat-funding')).toHaveTextContent('off');
  });

  it('has no ticker extras such as 24h volume or open interest', () => {
    render(
      <MarketHeader oracle={{ state: 'valid', price: usd(150), ageSeconds: 1 }} mark={null} collectingBatchId={1n} />,
    );
    expect(screen.queryByText(/24h/i)).toBeNull();
    expect(screen.queryByTestId('stat-oi')).toBeNull();
  });
});
