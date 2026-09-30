import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('useAccountActions send options', () => {
  it('does not skip preflight on wallet transactions', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'useAccountActions.ts'),
      'utf8',
    );
    expect(src).toContain('WALLET_TX_SEND_OPTS');
    expect(src).not.toMatch(/skipPreflight:\s*true/);
  });
});
