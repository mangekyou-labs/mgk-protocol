import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type * as sdk from '@mgk/sdk';
import { ReadinessChecklist } from './ReadinessChecklist';
const mocks = vi.hoisted(() => ({ connected: true, balance: 1000000000n as bigint | null, reason: null as string | null }));
vi.mock('@/components/wallet/useAutoConnect', () => ({ useAutoConnect: () => ({ connected: mocks.connected }) }));
vi.mock('@/components/wallet/WalletButton', () => ({ WalletButton: () => <button>Connect wallet</button> }));
vi.mock('@/lib/hooks/useReadiness', () => ({ useReadiness: () => ({ walletLamports: mocks.balance, signingBlockedReason: mocks.reason, loading: false }) }));
vi.mock('@/components/orderform/AccountActions', () => ({ AccountActions: () => <div>Collateral controls</div> }));
it('keeps a connected wallet without collateral out of the order form', () => {
  render(<ReadinessChecklist portfolio={null} loading={false}><div>Order form</div></ReadinessChecklist>);
  expect(screen.getByText('Wallet connected, not ready')).toBeInTheDocument();
  expect(screen.getByText('Collateral controls')).toBeInTheDocument();
  expect(screen.queryByText('Order form')).not.toBeInTheDocument();
});
it('shows the order form only with RPC funding, collateral and a matching deployment', () => {
  const portfolio = { principal: 100000000n, equity: 100000000n } as sdk.state.PortfolioState;
  const { rerender } = render(<ReadinessChecklist portfolio={portfolio} loading={false}><div>Order form</div></ReadinessChecklist>);
  expect(screen.getByText('Order form')).toBeInTheDocument();
  mocks.reason = 'Wrong cluster. Select a devnet RPC.';
  rerender(<ReadinessChecklist portfolio={portfolio} loading={false}><div>Order form</div></ReadinessChecklist>);
  expect(screen.queryByText('Order form')).not.toBeInTheDocument();
  expect(screen.getByText(mocks.reason)).toBeInTheDocument();
});

beforeEach(() => { mocks.connected = true; mocks.balance = 1000000000n; mocks.reason = null; });
it('preserves form input and its mounted instance during a background portfolio refresh', () => {
  const portfolio = { equity: 100000000n } as sdk.state.PortfolioState;
  const form = <input aria-label="Order quantity" defaultValue="" />;
  const { rerender } = render(<ReadinessChecklist portfolio={portfolio} loading={false}>{form}</ReadinessChecklist>);
  const input = screen.getByLabelText('Order quantity');
  fireEvent.change(input, { target: { value: '0.42' } });
  rerender(<ReadinessChecklist portfolio={portfolio} loading={true}>{form}</ReadinessChecklist>);
  expect(screen.getByLabelText('Order quantity')).toBe(input);
  expect(input).toHaveValue('0.42');
  rerender(<ReadinessChecklist portfolio={portfolio} loading={false}>{form}</ReadinessChecklist>);
  expect(screen.getByLabelText('Order quantity')).toBe(input);
});

it('gates initial loading, wallet identity changes and RPC errors instead of exposing the form', () => {
  const portfolio = { equity: 100000000n } as sdk.state.PortfolioState;
  const form = <div>Order form</div>;
  const { rerender } = render(<ReadinessChecklist portfolio={null} loading={true}>{form}</ReadinessChecklist>);
  expect(screen.queryByText('Order form')).not.toBeInTheDocument();
  expect(screen.getByText('Reading collateral from RPC…')).toBeInTheDocument();
  rerender(<ReadinessChecklist portfolio={portfolio} loading={false} error="RPC unavailable">{form}</ReadinessChecklist>);
  expect(screen.queryByText('Order form')).not.toBeInTheDocument();
  expect(screen.getByText('RPC unavailable')).toBeInTheDocument();
  mocks.connected = false;
  rerender(<ReadinessChecklist portfolio={portfolio} loading={false}>{form}</ReadinessChecklist>);
  expect(screen.queryByText('Order form')).not.toBeInTheDocument();
});
