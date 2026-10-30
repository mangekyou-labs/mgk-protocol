import { describe, expect, it } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import { state } from '@mgk/sdk';
import { findCommitmentsForBatch } from './keeper.js';

// The fixture was emitted from the actual Rust Commitment type, including its header.
describe('keeper commitment scan', () => {
  it('filters the on-chain batch field and decodes the user and status from Commitment', async () => {
    const bytes = Buffer.from(state.layouts.Commitment.fixture);
    const expected = state.decodeCommitment(bytes);
    const program = new PublicKey(new Uint8Array(32).fill(1));
    const pubkey = new PublicKey(new Uint8Array(32).fill(2));
    let filters: unknown;
    const connection = {
      getProgramAccounts: async (_program: PublicKey, config: {filters: unknown}) => {
        filters = config.filters;
        return [{pubkey, account: {data: bytes}}];
      },
    } as unknown as Connection;
    const rows = await findCommitmentsForBatch(connection, program, expected.batchId);
    expect(filters).toEqual([
      {memcmp: {offset: 8, bytes: expect.any(String)}},
      {dataSize: state.COMMITMENT_SIZE},
    ]);
    expect(rows).toEqual([{pubkey, batchId: expected.batchId, user: expected.user, status: expected.status}]);
    expect(await findCommitmentsForBatch(connection, program, expected.batchId + 1n)).toEqual([]);
  });
});
