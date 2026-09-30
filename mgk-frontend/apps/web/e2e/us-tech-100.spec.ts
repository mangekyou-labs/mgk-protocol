import { expect, test } from '@playwright/test';

test('licensed-partner sandbox settles an order and exposes deterministic evidence', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/demo/us-tech-100?preview=settled');

  await expect(page.getByRole('heading', { name: 'US Tech 100 Sandbox' })).toBeVisible();
  await expect(page.getByText('Simulated partner sandbox')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Deterministic receipt' })).toBeVisible();
  await expect(page.getByText('MGK-US100-84A7C2')).toBeVisible();
  await expect(page.getByText('Ask auction · maker sells × taker buys')).toBeVisible();
  await expect(page.getByText('Price priority; pro-rata at the marginal price')).toBeVisible();
  await expect(page.getByText('No wallet, backend, live market data, or onchain write')).toBeVisible();

  await page.screenshot({
    path: 'artifacts/us-tech-100-receipt.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('keyboard flow covers eligibility, order entry, lifecycle, and reset', async ({ page }) => {
  await page.goto('/demo/us-tech-100');

  await page.getByRole('checkbox', { name: /licensed IFC partner workflow/i }).check();
  await page.getByRole('radio', { name: 'Taker' }).check();
  await page.getByRole('radio', { name: 'Buy' }).check();
  await page.getByLabel('Limit price').fill('21482.50');
  await page.getByLabel('Quantity').fill('12');

  await page.getByRole('button', { name: 'Submit simulated order' }).focus();
  await page.keyboard.press('Enter');

  await expect(page.getByText('Collecting')).toHaveAttribute('aria-current', 'step');
  await page.getByRole('button', { name: 'Advance to clearing' }).press('Enter');
  await expect(page.getByText('Clearing')).toHaveAttribute('aria-current', 'step');
  await page.getByRole('button', { name: 'Settle batch' }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Deterministic receipt' })).toBeVisible();
  await expect(page.getByText('$21,478.25')).toBeVisible();
  await expect(page.getByLabel('Simulated deterministic receipt').getByText('12', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Start another simulation' }).press('Enter');
  await expect(page.getByRole('button', { name: 'Submit simulated order' })).toBeVisible();
});
