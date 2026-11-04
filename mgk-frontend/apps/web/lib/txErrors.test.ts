import { describe, expect, it } from 'vitest';

import { describeTxError, explorerTxUrl } from './txErrors';

describe('describeTxError', () => {
  it.each([
    ['Unexpected error', 'Your wallet could not send this transaction. Make sure it is set to Devnet, then try again.'],
    ['WalletSendTransactionError: Unexpected error', 'Your wallet could not send this transaction. Make sure it is set to Devnet, then try again.'],
    ['User rejected the request.', 'You cancelled the request in your wallet.'],
    ['Transaction cancelled', 'You cancelled the request in your wallet.'],
    ['Blockhash not found', 'The transaction expired before it confirmed. Try again.'],
    ['block height exceeded', 'The transaction expired before it confirmed. Try again.'],
    ['Simulation failed; no signature requested: {"InstructionError":[0,"InsufficientFundsForRent"]}', 'Not enough SOL in your wallet to cover this transaction and its fees.'],
    ['Attempt to debit an account but found no record of a prior credit.', 'Not enough SOL in your wallet to cover this transaction and its fees.'],
    ['TypeError: Failed to fetch', 'Network busy. Try again in a moment.'],
  ])('turns %j into plain language', (raw, expected) => {
    expect(describeTxError(raw)).toBe(expected);
  });

  it('keeps a decoded simulation reason without the internal prefix', () => {
    expect(describeTxError('Simulation failed; no signature requested: Insufficient collateral')).toBe(
      'Insufficient collateral. Nothing was signed.',
    );
  });

  it('passes an actionable app error through unchanged', () => {
    expect(describeTxError('Wrong cluster. Select a devnet RPC and reconnect your wallet.')).toBe(
      'Wrong cluster. Select a devnet RPC and reconnect your wallet.',
    );
  });

  it('keeps only the first line of a long raw error', () => {
    const raw = `Something odd happened\n${'log line\n'.repeat(20)}`;
    expect(describeTxError(raw)).toBe('Something odd happened');
  });
});

describe('explorerTxUrl', () => {
  it('links a signature on the devnet explorer', () => {
    expect(explorerTxUrl('5Sig')).toBe('https://explorer.solana.com/tx/5Sig?cluster=devnet');
  });
});
