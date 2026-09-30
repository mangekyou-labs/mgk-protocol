import type { Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type PersonaRole = 'maker' | 'taker';

const requireFromHere = createRequire(import.meta.url);
const toolsRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'tools',
);

type InjectFn = (
  page: Page,
  role: PersonaRole,
) => Promise<{ role: PersonaRole; publicKey: string; rpc: string }>;

/**
 * Playwright test helper wrapping tools/cli-inject-live-wallet.cjs.
 * Capture-only mockPhantom.signAndSendTransaction is not the live path.
 */
export async function installLiveSigningWallet(
  page: Page,
  role: PersonaRole,
): Promise<{ role: PersonaRole; publicKey: string; rpc: string }> {
  const inject = requireFromHere(
    join(toolsRoot, 'cli-inject-live-wallet.cjs'),
  ) as InjectFn;
  return inject(page, role);
}
