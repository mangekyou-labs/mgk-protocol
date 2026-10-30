import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type * as sdk from '@mgk/sdk';
import { AccountActions } from './AccountActions';

const mocks = vi.hoisted(() => ({ deposit: vi.fn().mockResolvedValue({ sig: 'sig' }), withdraw: vi.fn(), block: null as string | null }));
vi.mock('@/lib/hooks/useAccountActions', () => ({ useAccountActions: () => ({ deposit: mocks.deposit, withdraw: mocks.withdraw }) }));
vi.mock('@/lib/hooks/useReadiness', () => ({ useReadiness: () => ({ walletLamports: 2000000000n, loading: false, error: null, signingBlockedReason: mocks.block, refresh: vi.fn(), getDevnetSol: vi.fn() }) }));
vi.mock('@/components/wallet/useAutoConnect', () => ({ useAutoConnect: () => ({ connected: true }) }));
vi.mock('@/lib/stores/useBatchStore', () => ({ useBatchStore: (selector: (s: unknown) => unknown) => selector({ data: null, registry: { pauseFlags: 0 }, error: null }) }));
it('offers devnet SOL and accepts an exact 9-decimal deposit before a portfolio exists', async () => {
  render(<AccountActions portfolio={null} portfolioLoading={false} />);
  expect(screen.getByRole('button', { name: 'Get devnet SOL' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Collateral amount in SOL'), { target: { value: '1.234567891' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create portfolio and deposit' }));
  await waitFor(() => expect(mocks.deposit).toHaveBeenCalledWith(1234567891n));
});
it('rejects excess decimals and over-withdrawals, showing the net reservation amount', () => {
  render(<AccountActions portfolio={{ freeCollateral: 200000001n, reservedCollateral: 799999999n } as sdk.state.PortfolioState} portfolioLoading={false} />);
  expect(screen.getByText(/0.200000001 SOL/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Collateral amount in SOL'), { target: { value: '0.200000002' } });
  expect(screen.getByRole('button', { name: 'Withdraw' })).toBeDisabled();
  expect(screen.getByText(/exceeds withdrawable/i)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Collateral amount in SOL'), { target: { value: '0.0000000001' } });
  expect(screen.getByRole('button', { name: 'Deposit' })).toBeDisabled();
  expect(screen.getByText(/at most 9 decimals/i)).toBeInTheDocument();
});
