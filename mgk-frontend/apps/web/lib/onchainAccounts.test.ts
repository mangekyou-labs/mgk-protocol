import { PublicKey } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchIndexerBatchAddress } from './onchainAccounts';

describe('fetchIndexerBatchAddress', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when the indexer batch id diverges from the expected id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          batchAddress: '11111111111111111111111111111111',
          batchId: '99',
        }),
      })),
    );
    await expect(fetchIndexerBatchAddress(4n, 'http://indexer.test')).resolves.toBeNull();
  });

  it('returns the indexer address when batch ids match', async () => {
    const address = '11111111111111111111111111111111';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          batchAddress: address,
          batchId: '4',
        }),
      })),
    );
    const pk = await fetchIndexerBatchAddress(4n, 'http://indexer.test');
    expect(pk).toBeInstanceOf(PublicKey);
    expect(pk!.toBase58()).toBe(address);
  });

  it('returns null for an address-only indexer body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ batchAddress: '11111111111111111111111111111111' }),
      })),
    );
    await expect(fetchIndexerBatchAddress(4n, 'http://indexer.test')).resolves.toBeNull();
  });
});
