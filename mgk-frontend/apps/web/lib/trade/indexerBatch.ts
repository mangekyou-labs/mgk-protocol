/** Parse indexer `/api/batch/current` batch id without trusting the address alone. */

export function indexerReportedBatchId(body: Record<string, unknown>): bigint | null {
  const raw = body.batchId ?? body.batch_id;
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number' && Number.isInteger(raw)) return BigInt(raw);
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      return BigInt(raw);
    } catch {
      return null;
    }
  }
  return null;
}

export function indexerBatchMatchesExpected(
  body: Record<string, unknown>,
  expectedBatchId: bigint,
): boolean {
  const reported = indexerReportedBatchId(body);
  if (reported === null) return false;
  return reported === expectedBatchId;
}
