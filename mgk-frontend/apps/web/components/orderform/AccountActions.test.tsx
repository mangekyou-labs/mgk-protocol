import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as sdk from '@mgk/sdk';
import { AccountActions } from './AccountActions';

const mocks = vi.hoisted(() => ({ deposit: vi.fn().mockResolvedValue({ sig: 'sig' }), withdraw: vi.fn(), block: null as string | null, registry: { pauseFlags: 0, batchIdCounter: 0n } as sdk.state.RegistryState | null, batch: null as sdk.state.BatchState | null }));
vi.mock('@/lib/hooks/useAccountActions', () => ({ useAccountActions: () => ({ deposit: mocks.deposit, withdraw: mocks.withdraw }) }));
vi.mock('@/lib/hooks/useReadiness', () => ({ useReadiness: () => ({ walletLamports: 2000000000n, loading: false, error: null, signingBlockedReason: mocks.block, refresh: vi.fn(), getDevnetSol: vi.fn() }) }));
vi.mock('@/components/wallet/useAutoConnect', () => ({ useAutoConnect: () => ({ connected: true }) }));
vi.mock('@/lib/stores/useBatchStore', () => ({ useBatchStore: (selector: (s: unknown) => unknown) => selector({ data: mocks.batch, registry: mocks.registry, error: null }) }));
it('offers devnet SOL and accepts an exact 9-decimal deposit before a portfolio exists', async () => {
  render(<AccountActions portfolio={null} portfolioLoading={false} />);
  expect(screen.getByRole('button', { name: 'Get devnet SOL' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Collateral amount in SOL'), { target: { value: '1.234567891' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create portfolio and deposit' }));
  await waitFor(() => expect(mocks.deposit).toHaveBeenCalledWith(1234567891n));
});
it('rejects excess decimals and over-withdrawals for flat collateral', () => {
  render(<AccountActions portfolio={{ equity: 200000001n, freeCollateral: 1n, reservedCollateral: 0n, positions: [] } as unknown as sdk.state.PortfolioState} portfolioLoading={false} />);
  expect(screen.getByText(/0.200000001 SOL/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Collateral amount in SOL'), { target: { value: '0.200000002' } });
  expect(screen.getByRole('button', { name: 'Withdraw' })).toBeDisabled();
  expect(screen.getByText(/exceeds withdrawable/i)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Collateral amount in SOL'), { target: { value: '0.0000000001' } });
  expect(screen.getByRole('button', { name: 'Deposit' })).toBeDisabled();
  expect(screen.getByText(/at most 9 decimals/i)).toBeInTheDocument();
});

it('does not claim a stale withdrawable amount or reject recovered risk collateral before simulation', () => {
  render(<AccountActions portfolio={{ equity: 1000000000n, freeCollateral: 550000000n, reservedCollateral: 1n, positions: [] } as unknown as sdk.state.PortfolioState} portfolioLoading={false} />);
  expect(screen.getByText(/Withdrawable collateral: unavailable/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Collateral amount in SOL'), { target: { value: '0.6' } });
  expect(screen.getByRole('button', { name: 'Withdraw' })).toBeEnabled();
  expect(screen.queryByText(/0.55 SOL/)).not.toBeInTheDocument();
});

beforeEach(() => { mocks.block = null; mocks.registry = { pauseFlags: 0, batchIdCounter: 0n } as sdk.state.RegistryState; mocks.batch = null; });
it.each([
  ['paused', { pauseFlags: 2, batchIdCounter: 0n }, null, 'Withdrawals are paused. Wait for the operator to restore withdrawals.'],
  ['Cleared', { pauseFlags: 0, batchIdCounter: 1n }, { status: sdk.state.BatchStatus.Cleared }, 'Withdrawals blocked: batch Cleared, awaiting settlement.'],
  ['unavailable', { pauseFlags: 0, batchIdCounter: 1n }, null, 'Current batch status unavailable. Retry when RPC has recovered.'],
] as const)('explains the shared withdrawal policy when batch status is %s', (_, registry, batch, reason) => {
  mocks.registry = registry as sdk.state.RegistryState;
  mocks.batch = batch as sdk.state.BatchState | null;
  render(<AccountActions portfolio={{ equity: 1000000000n, reservedCollateral: 0n, positions: [] } as unknown as sdk.state.PortfolioState} portfolioLoading={false} />);
  fireEvent.change(screen.getByLabelText('Collateral amount in SOL'), { target: { value: '0.1' } });
  expect(screen.getByRole('button', { name: 'Withdraw' })).toBeDisabled();
  expect(screen.getByText(reason)).toBeInTheDocument();
});
