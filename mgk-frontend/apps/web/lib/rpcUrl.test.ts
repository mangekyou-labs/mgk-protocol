import { describe, expect, it } from 'vitest';
import { rpcUrlContainsCredential } from './rpcUrl';

describe('rpcUrlContainsCredential', () => {
  it('flags a Helius-style api-key query on NEXT_PUBLIC_RPC_URL', () => {
    expect(
      rpcUrlContainsCredential('https://devnet.helius-rpc.com/?api-key=not-a-real-key'),
    ).toBe(true);
  });

  it('allows the public Solana devnet RPC', () => {
    expect(rpcUrlContainsCredential('https://api.devnet.solana.com')).toBe(false);
  });
});
