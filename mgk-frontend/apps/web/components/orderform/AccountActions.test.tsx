import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as sdk from '@mgk/sdk';
import { AccountActions } from './AccountActions';

const mocks = vi.hoisted(() => ({ deposit: vi.fn().mockResolvedValue({ sig: 'sig' }), withdraw: vi.fn(), block: null as string | null, lowFeeBalance: false, registry: { pauseFlags: 0, batchIdCounter: 0n } as sdk.state.RegistryState | null, batch: null as sdk.state.BatchState | null }));
vi.mock('@/lib/hooks/useAccountActions', () => ({ useAccountActions: () => ({ deposit: mocks.deposit, withdraw: mocks.withdraw }) }));
vi.mock('@/lib/hooks/useReadiness', () => ({ useReadiness: () => ({ walletLamports: 2000000000n, loading: false, error: null, signingBlockedReason: mocks.block, lowFeeBalance: mocks.lowFeeBalance, refresh: vi.fn() }) }));
vi.mock('@/components/wallet/useAutoConnect', () => ({ useAutoConnect: () => ({ connected: true }) }));
vi.mock('@/lib/stores/useBatchStore', () => ({ useBatchStore: (selector: (s: unknown) => unknown) => selector({ data: mocks.batch, registry: mocks.registry, error: null }) }));
/** Funded portfolios start folded; expand the controls the way a user would. */
function renderOpen(ui: React.ReactElement) {
  render(ui);
  fireEvent.click(screen.getByTestId('account-actions-summary'));
}
it('accepts an exact 9-decimal deposit before a portfolio exists, with no faucet step', async () => {
  render(<AccountActions portfolio={null} portfolioLoading={false} />);
  expect(screen.queryByRole('button', { name: /devnet SOL/i })).toBeNull();
  expect(screen.queryByRole('link', { name: /faucet/i })).toBeNull();
  expect(screen.queryByText(/not carried over/i)).toBeNull();
  fireEvent.change(screen.getByLabelText('Collateral amount in SOL'), { target: { value: '1.234567891' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create portfolio and deposit' }));
  await waitFor(() => expect(mocks.deposit).toHaveBeenCalledWith(1234567891n));
});
it('rejects excess decimals and over-withdrawals for flat collateral', () => {
  renderOpen(<AccountActions portfolio={{ equity: 200000001n, freeCollateral: 1n, reservedCollateral: 0n, positions: [] } as unknown as sdk.state.PortfolioState} portfolioLoading={false} />);
  expect(screen.getByText(/0.200000001 SOL/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Collateral amount in SOL'), { target: { value: '0.200000002' } });
  expect(screen.getByRole('button', { name: 'Withdraw' })).toBeDisabled();
  expect(screen.getByText(/exceeds withdrawable/i)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Collateral amount in SOL'), { target: { value: '0.0000000001' } });
  expect(screen.getByRole('button', { name: 'Deposit' })).toBeDisabled();
  expect(screen.getByText(/at most 9 decimals/i)).toBeInTheDocument();
});

it('does not claim a stale withdrawable amount or reject recovered risk collateral before simulation', () => {
  renderOpen(<AccountActions portfolio={{ equity: 1000000000n, freeCollateral: 550000000n, reservedCollateral: 1n, positions: [] } as unknown as sdk.state.PortfolioState} portfolioLoading={false} />);
  expect(screen.getByText(/Withdrawable collateral: unavailable/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Collateral amount in SOL'), { target: { value: '0.6' } });
  expect(screen.getByRole('button', { name: 'Withdraw' })).toBeEnabled();
  expect(screen.queryByText(/0.55 SOL/)).not.toBeInTheDocument();
});

beforeEach(() => { mocks.block = null; mocks.lowFeeBalance = false; mocks.registry = { pauseFlags: 0, batchIdCounter: 0n } as sdk.state.RegistryState; mocks.batch = null; });
it.each([
  ['paused', { pauseFlags: 2, batchIdCounter: 0n }, null, 'Withdrawals are paused. Wait for the operator to restore withdrawals.'],
  ['unavailable', { pauseFlags: 0, batchIdCounter: 1n }, null, 'Current batch status unavailable. Retry when RPC has recovered.'],
] as const)('explains the shared withdrawal policy when batch status is %s', (_, registry, batch, reason) => {
  mocks.registry = registry as sdk.state.RegistryState;
  mocks.batch = batch as sdk.state.BatchState | null;
  renderOpen(<AccountActions portfolio={{ equity: 1000000000n, reservedCollateral: 0n, positions: [] } as unknown as sdk.state.PortfolioState} portfolioLoading={false} />);
  fireEvent.change(screen.getByLabelText('Collateral amount in SOL'), { target: { value: '0.1' } });
  expect(screen.getByRole('button', { name: 'Withdraw' })).toBeDisabled();
  expect(screen.getByText(reason)).toBeInTheDocument();
});

it('keeps withdraw enabled through the brief Cleared phase; the action waits for settlement', () => {
  mocks.registry = { pauseFlags: 0, batchIdCounter: 1n } as sdk.state.RegistryState;
  mocks.batch = { status: sdk.state.BatchStatus.Cleared } as sdk.state.BatchState;
  renderOpen(<AccountActions portfolio={{ equity: 1000000000n, reservedCollateral: 0n, positions: [] } as unknown as sdk.state.PortfolioState} portfolioLoading={false} />);
  fireEvent.change(screen.getByLabelText('Collateral amount in SOL'), { target: { value: '0.1' } });
  expect(screen.getByRole('button', { name: 'Withdraw' })).toBeEnabled();
  expect(screen.getByRole('status')).toBeEmptyDOMElement();
});

it('disables deposit and withdraw when the wallet cannot cover fees', () => {
  mocks.lowFeeBalance = true;
  renderOpen(<AccountActions portfolio={{ equity: 1000000000n, reservedCollateral: 0n, positions: [] } as unknown as sdk.state.PortfolioState} portfolioLoading={false} />);
  fireEvent.change(screen.getByLabelText('Collateral amount in SOL'), { target: { value: '0.1' } });
  expect(screen.getByRole('button', { name: 'Deposit' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Withdraw' })).toBeDisabled();
});

const funded = { equity: 598000000n, freeCollateral: 598000000n, reservedCollateral: 0n, positions: [] } as unknown as sdk.state.PortfolioState;

it('folds to a one-line wallet and collateral summary once collateral exists', () => {
  render(<AccountActions portfolio={funded} portfolioLoading={false} />);
  const summary = screen.getByTestId('account-actions-summary');
  expect(summary).toHaveTextContent('Wallet 2.00 SOL · Collateral 0.598 SOL · Deposit');
  expect(summary).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByLabelText('Collateral amount in SOL')).toBeNull();
  fireEvent.click(summary);
  expect(summary).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByLabelText('Collateral amount in SOL')).toBeInTheDocument();
});

it.each([
  ['no portfolio', null],
  ['no collateral', { ...funded, equity: 0n, freeCollateral: 0n }],
] as const)('opens the deposit controls by default with %s, since depositing is step one', (_, portfolio) => {
  render(<AccountActions portfolio={portfolio as sdk.state.PortfolioState | null} portfolioLoading={false} />);
  expect(screen.getByTestId('account-actions-summary')).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByLabelText('Collateral amount in SOL')).toBeInTheDocument();
});

it('keeps a failed transaction message visible after folding the controls', async () => {
  vi.mocked(mocks.deposit).mockRejectedValueOnce(new Error('User rejected the request.'));
  renderOpen(<AccountActions portfolio={funded} portfolioLoading={false} />);
  fireEvent.change(screen.getByLabelText('Collateral amount in SOL'), { target: { value: '0.1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Deposit' }));
  const status = await screen.findByRole('status');
  await waitFor(() => expect(status).not.toBeEmptyDOMElement());
  const text = status.textContent;
  fireEvent.click(screen.getByTestId('account-actions-summary'));
  expect(screen.getByRole('status')).toHaveTextContent(text!);
});
