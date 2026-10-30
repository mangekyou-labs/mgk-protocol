import { expect, it } from 'vitest';
import { parseSol, formatSol } from './solAmount';
it('preserves exact lamports including the u64 maximum', () => {
  expect(parseSol('1.234567891')).toBe(1234567891n);
  expect(parseSol('18446744073.709551615')).toBe(18446744073709551615n);
  expect(formatSol(18446744073709551615n)).toBe('18446744073.709551615');
  for (const value of ['18446744073.709551616', '0.0000000001', '-1', '1e3', '0', 'Infinity']) expect(parseSol(value)).toBeNull();
});
