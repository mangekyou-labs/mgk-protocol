import {describe, expect, it} from 'vitest';
import {settlementQuantities} from './settlementReceipt.js';
const receipt = (quantities: bigint[], batch = 5n) => {
  const payload = Buffer.alloc(10 + quantities.length * 8);
  payload.writeBigUInt64LE(batch); payload.writeUInt16LE(quantities.length, 8);
  quantities.forEach((qty, i) => payload.writeBigUInt64LE(qty, 10 + i * 8));
  return `Program data: ${Buffer.from('mgk-settlement-v1').toString('base64')} ${payload.toString('base64')}`;
};
const logs = (record: string) => ['Program core invoke [1]', record, 'Program core success'];
describe('effective settlement receipts', () => {
  it('keeps zero ordinals and clipped quantities in the full vector', () => {
    expect(settlementQuantities(logs(receipt([0n, 3n, 8n])), 'core', 5n, [5n, 7n, 8n])).toEqual([0n, 3n, 8n]);
  });
  it('rejects CPI spoofing, missing logs, truncation and allocation inflation', () => {
    const spoof = ['Program core invoke [1]', 'Program attacker invoke [2]', receipt([3n]), 'Program attacker success', 'Program core success'];
    for (const entries of [spoof, null, ['Program core invoke [1]', receipt([3n])], logs('Program data: bWdrLXNldHRsZW1lbnQtdjE= AA=='), logs(receipt([9n]))]) {
      expect(() => settlementQuantities(entries, 'core', 5n, [8n])).toThrow();
    }
  });
  it('rejects duplicate vectors and incomplete vectors', () => {
    expect(() => settlementQuantities(['Program core invoke [1]', receipt([3n]), receipt([3n]), 'Program core success'], 'core', 5n, [8n])).toThrow();
    expect(() => settlementQuantities(logs(receipt([3n])), 'core', 5n, [8n, 2n])).toThrow();
  });
});
