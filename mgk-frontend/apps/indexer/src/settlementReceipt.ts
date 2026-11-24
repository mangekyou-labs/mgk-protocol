/** Settlement receipt payloads emitted directly by the core invocation (CPI-emitted data is ignored). */
function coreReceipts(logs: string[] | null | undefined, core: string): Buffer[] {
  const stack: string[] = [];
  const receipts: Buffer[] = [];
  for (const log of logs ?? []) {
    const invoke = /^Program (\S+) invoke \[\d+\]$/.exec(log);
    if (invoke) {stack.push(invoke[1]!); continue;}
    const exit = /^Program (\S+) (success|failed:.*)$/.exec(log);
    if (exit) {
      if (stack.pop() !== exit[1]) throw new Error('Malformed invocation logs');
      continue;
    }
    if (stack.at(-1) !== core || !log.startsWith('Program data: ')) continue;
    const [tag, encoded] = log.slice(14).split(' ');
    if (!tag || Buffer.from(tag, 'base64').toString() !== 'mgk-settlement-v1') continue;
    const data = Buffer.from(encoded ?? '', 'base64');
    if (data.length < 10) throw new Error('Truncated settlement receipt');
    receipts.push(data);
  }
  if (stack.length) throw new Error('Truncated invocation logs');
  return receipts;
}

/** Only accept complete receipts emitted directly by the core invocation. */
export function settlementQuantities(logs: string[] | null | undefined, core: string, batchId: bigint, allocations: bigint[]): bigint[] {
  let receipt: bigint[] | undefined;
  for (const data of coreReceipts(logs, core)) {
    if (data.readBigUInt64LE(0) !== batchId) continue;
    const count = data.readUInt16LE(8);
    if (receipt || count !== allocations.length || data.length !== 10 + count * 8) throw new Error('Incomplete or duplicate settlement receipt');
    receipt = Array.from({length: count}, (_, i) => data.readBigUInt64LE(10 + i * 8));
    if (receipt.some((qty, i) => qty > allocations[i]!)) throw new Error('Settlement receipt exceeds allocation');
  }
  if (!receipt) throw new Error('Effective settlement receipt unavailable');
  return receipt;
}

/**
 * The batch one SettleBatch invocation settled, read from its own receipt. Used when
 * the Batch and Results accounts were later closed and can no longer be read.
 */
export function settledBatchId(logs: string[] | null | undefined, core: string): bigint {
  const receipts = coreReceipts(logs, core);
  if (receipts.length !== 1) throw new Error('Expected exactly one settlement receipt');
  return receipts[0]!.readBigUInt64LE(0);
}
