import { describe, expect, it } from 'vitest';
import {
  indexerBatchMatchesExpected,
  indexerReportedBatchId,
} from './indexerBatch';

describe('indexerBatchMatchesExpected', () => {
  it('rejects a poisoned indexer address whose batch id diverges', () => {
    const body = {
      batchAddress: '11111111111111111111111111111111',
      batchId: '99',
    };
    expect(indexerBatchMatchesExpected(body, 4n)).toBe(false);
  });

  it('accepts the indexer address only when batch ids match', () => {
    const body = { batch_address: 'x', batchId: '4' };
    expect(indexerBatchMatchesExpected(body, 4n)).toBe(true);
  });

  it('rejects a body with no batch id (address-only trust)', () => {
    expect(indexerReportedBatchId({ batchAddress: 'x' })).toBeNull();
    expect(indexerBatchMatchesExpected({ batchAddress: 'x' }, 4n)).toBe(false);
  });
});
