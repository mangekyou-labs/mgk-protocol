import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { toast } from 'sonner';

import { notifyTxConfirmed, notifyTxFailed, TxToaster } from './TxToast';

afterEach(() => act(() => { toast.dismiss(); }));

it('confirms with a title and a devnet explorer link for the signature', async () => {
  render(<TxToaster />);
  act(() => notifyTxConfirmed('Deposit confirmed', '5Sig'));
  expect(await screen.findByText('Deposit confirmed')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'View on Solana Explorer' })).toHaveAttribute(
    'href',
    'https://explorer.solana.com/tx/5Sig?cluster=devnet',
  );
});

it('explains a failure in plain words and offers no explorer link', async () => {
  render(<TxToaster />);
  act(() => notifyTxFailed('Deposit failed', 'WalletSendTransactionError: Unexpected error'));
  expect(await screen.findByText('Deposit failed')).toBeInTheDocument();
  expect(screen.getByText(/Make sure it is set to Devnet/)).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'View on Solana Explorer' })).toBeNull();
});
