import { expect, test } from '@playwright/test';

// CI verifies hydration and navigation without a wallet, indexer, or RPC service.
test.beforeEach(async ({ page, baseURL }) => {
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === new URL(baseURL!).origin) {
      await route.continue();
    } else {
      await route.fulfill({ status: 503, body: 'External services disabled in smoke tests' });
    }
  });
});

test('landing page launches the restored trading shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'On-chain perps, fair ordering.' })).toBeVisible();
  await page.getByTestId('launch-app-cta').click();
  await expect(page).toHaveURL(/\/trade$/);
  await expect(page.getByTestId('market-selector')).toHaveText('SOL-USD Perp');
});

test('/portfolio redirects to the trading screen', async ({ page }) => {
  await page.goto('/portfolio');
  await expect(page).toHaveURL(/\/trade$/);
  await expect(page.getByTestId('portfolio-page')).toHaveCount(0);
  await expect(page.getByTestId('market-selector')).toHaveText('SOL-USD Perp');
});

for (const width of [375, 768, 1280]) {
  test(`disconnected trading shell hydrates and opens wallet selection at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/trade');
    await expect(page.getByTestId('app-header')).toBeVisible();
    await expect(page.getByTestId('market-selector')).toHaveText('SOL-USD Perp');
    await expect(page.getByRole('heading', { name: 'Connect a wallet' })).toBeVisible();
    await expect(page.getByTestId('demo-notice')).toContainText('Earlier devnet balances were not carried over.');
    await page.getByTestId('wallet-button').getByRole('button', { name: 'Select Wallet' }).click();
    await expect(page.getByRole('heading', { name: /connect a wallet on solana/i })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
