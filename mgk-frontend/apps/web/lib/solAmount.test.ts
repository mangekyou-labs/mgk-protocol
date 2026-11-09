import { expect, it } from 'vitest';
import { parseSol, formatSol, formatSolCompact } from './solAmount';
it('preserves exact lamports including the u64 maximum', () => {
  expect(parseSol('1.234567891')).toBe(1234567891n);
  expect(parseSol('18446744073.709551615')).toBe(18446744073709551615n);
  expect(formatSol(18446744073709551615n)).toBe('18446744073.709551615');
  for (const value of ['18446744073.709551616', '0.0000000001', '-1', '1e3', '0', 'Infinity']) expect(parseSol(value)).toBeNull();
});
it('shortens balances for one-line summaries without rounding up', () => {
  expect(formatSolCompact(32920287818n)).toBe('32.92');
  expect(formatSolCompact(597995000n)).toBe('0.597');
  expect(formatSolCompact(0n)).toBe('0.000');
  expect(formatSolCompact(null)).toBe('unavailable');
});
