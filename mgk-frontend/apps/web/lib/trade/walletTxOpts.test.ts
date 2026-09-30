import { describe, expect, it } from 'vitest';
import { WALLET_TX_SEND_OPTS } from './walletTxOpts';

describe('WALLET_TX_SEND_OPTS', () => {
  it('does not skip RPC preflight for fund-moving wallet txs', () => {
    expect(WALLET_TX_SEND_OPTS.skipPreflight).toBe(false);
  });
});
