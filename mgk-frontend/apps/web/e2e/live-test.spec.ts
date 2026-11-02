import { test, expect } from '@playwright/test';

test.describe('Live Website Navigation & Verification', () => {
  test('navigates live to http://localhost:3000/trade and verifies all DFBA components', async ({ page }) => {
    console.log('1. Navigating to http://localhost:3000/trade ...');
    const response = await page.goto('http://localhost:3000/trade', { waitUntil: 'networkidle' });
    expect(response?.status()).toBe(200);

    console.log('2. Checking header and navigation ...');
    await expect(page.locator('[data-testid="app-header"]')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Trade' })).toBeVisible();

    console.log('3. Testing Select Wallet modal button ...');
    const walletBtn = page.getByRole('button', { name: 'Select Wallet' });
    await expect(walletBtn).toBeVisible();
    await walletBtn.click();

    console.log('4. Verifying Wallet adapter modal appears ...');
    const modalHeading = page.getByRole('heading', { name: /connect a wallet on solana/i });
    await expect(modalHeading).toBeVisible({ timeout: 5_000 });

    // Close wallet modal
    const closeBtn = page.locator('.wallet-adapter-modal-button-close');
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
    }

    console.log('5. Verifying Market Header SOL-USD Perp ...');
    await expect(page.locator('[data-testid="market-header"]')).toBeVisible();
    await expect(page.getByTestId('market-selector')).toHaveText('SOL-USD Perp');

    console.log('6. Verifying Order Form inputs ...');
    const priceInput = page.getByLabel('Price (USD)');
    const qtyInput = page.getByLabel('Size (SOL)');
    await expect(priceInput).toBeVisible();
    await priceInput.fill('150.50');
    await qtyInput.fill('2.0');
    expect(await priceInput.inputValue()).toBe('150.50');
    expect(await qtyInput.inputValue()).toBe('2.0');

    console.log('7. Switching Order Form side to Sell ...');
    const sellTab = page.getByRole('button', { name: 'Sell / Short' });
    await sellTab.click();
    await expect(sellTab).toHaveAttribute('aria-pressed', 'true');

    console.log('9. Testing Bottom Tabs ...');
    await page.locator('button[data-tab-id="balances"]').click();
    await expect(page.locator('[data-testid="bottom-tabs-content"]')).toHaveAttribute('data-active-tab', 'balances');

    console.log('10. Taking screenshot of live website ...');
    await page.screenshot({ path: '/Users/kyler/.gemini/antigravity/brain/12c9a6bc-e006-49c7-8fe0-3faed72e2757/trade_page_live.png', fullPage: true });
    console.log('LIVE WEBSITE TEST PASSED SUCCESSFULLY!');
  });
});
