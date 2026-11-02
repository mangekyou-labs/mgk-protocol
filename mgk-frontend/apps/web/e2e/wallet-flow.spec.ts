import { expect, test } from '@playwright/test';

import {
  installMockPhantom,
  installMockSolanaRpc,
  readCapturedTransactions,
} from './fixtures/mockPhantom';

test.describe('DFBA wallet flow without an extension', () => {
  test('connects a deterministic wallet and submits PostOrder', async ({ page }) => {
    await installMockSolanaRpc(page);
    await installMockPhantom(page);
    await page.goto('/trade');

    await expect(
      page.locator('[data-testid="app-header"] button[data-state]'),
    ).toHaveAttribute('data-state', 'connected');

    await page.getByLabel('Price (USD)').fill('100.25');
    await page.getByLabel('Size (SOL)').fill('2.5');
    await page.getByTestId('order-form-submit').click();

    await expect
      .poll(() =>
        readCapturedTransactions(page).then((transactions) => transactions.length),
      )
      .toBe(1);

    const [transaction] = await readCapturedTransactions(page);
    const postOrder = transaction?.instructions.find(
      (instruction) => instruction.data[0] === 20,
    );
    expect(postOrder).toBeDefined();
    expect(postOrder?.data).toHaveLength(22);
    // discriminator, side = buy, is_maker = 0 (the ticket has no maker toggle)
    expect(postOrder?.data.slice(0, 3)).toEqual([20, 0, 0]);

    const wire = Uint8Array.from(postOrder?.data ?? []);
    const view = new DataView(wire.buffer);
    expect(view.getBigInt64(3, true)).toBe(100_250_000n);
    // 2.5 SOL = 2,500 lots of 0.001 SOL
    expect(view.getBigUint64(11, true)).toBe(2_500n);
    expect(view.getUint16(19, true)).toBe(0);
    expect(view.getUint8(21)).toBe(0);
    expect(postOrder?.keys).toHaveLength(6);
    expect(postOrder?.keys[1]?.isSigner).toBe(true);
  });

  test('observes Collecting → Clearing → Settled copy after PostOrder', async ({
    page,
  }) => {
    const rpc = await installMockSolanaRpc(page);
    await installMockPhantom(page);
    await page.goto('/trade');

    await page.getByLabel('Price (USD)').fill('87.00');
    await page.getByLabel('Size (SOL)').fill('0.01');
    await page.getByTestId('order-form-submit').click();
    await expect
      .poll(() =>
        readCapturedTransactions(page).then((transactions) => transactions.length),
      )
      .toBe(1);

    await expect(page.getByTestId('status-batch-label')).toContainText(
      'Collecting',
    );
    await expect(page.getByTestId('status-batch-label')).toContainText(
      'Orders open',
    );
    await expect(page.getByTestId('order-lifecycle')).toHaveText(
      /Accepted · resting in batch \d+/,
    );

    rpc.setBatchPhase('clearing');
    await expect
      .poll(
        async () => page.getByTestId('status-batch-label').textContent(),
        { timeout: 8_000 },
      )
      .toMatch(/Clearing.*Orders closed.*Matching maker and taker flow/);

    rpc.setBatchPhase('settled-valid');
    await expect
      .poll(
        async () => page.getByTestId('status-batch-label').textContent(),
        { timeout: 8_000 },
      )
      .toMatch(/Settled.*Fills settled.*Mark updated/);
  });

  test('shows keeper lag when Collecting is past the close slot', async ({
    page,
  }) => {
    const rpc = await installMockSolanaRpc(page);
    await installMockPhantom(page);
    await page.goto('/trade');

    rpc.setBatchPhase('collecting-ready');
    await expect
      .poll(
        async () => page.getByTestId('status-batch-label').textContent(),
        { timeout: 8_000 },
      )
      .toMatch(/Ready to clear · Waiting for keeper · 00:00:13 late/);
  });
});

// =====================================================================
// T9.10.7: Prepare-close flows (positions are in 0.001-SOL lots)
// =====================================================================

test.describe('T9.10.7 prepare-close', () => {
  test('long position: close sets sell, reduce-only and the position size', async ({
    page,
  }) => {
    const rpc = await installMockSolanaRpc(page);
    await installMockPhantom(page);
    // Long 3 SOL = 3,000 lots, entry 87e6.
    rpc.setPortfolioPosition(0, 3_000n, 87_000_000n);
    await page.goto('/trade');

    const btn = page.getByRole('button', { name: 'Close long 3.000 SOL' });
    await expect(btn).toBeVisible();
    await btn.click();

    await expect(page.getByRole('button', { name: 'Sell / Short' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('checkbox', { name: 'Reduce only' })).toBeChecked();
    await expect(page.getByLabel('Size (SOL)')).toHaveValue('3.000');
  });

  test('short position: close sets buy, reduce-only and the position size', async ({
    page,
  }) => {
    const rpc = await installMockSolanaRpc(page);
    await installMockPhantom(page);
    rpc.setPortfolioPosition(0, -2_000n, 90_000_000n);
    await page.goto('/trade');

    const btn = page.getByRole('button', { name: 'Close short 2.000 SOL' });
    await expect(btn).toBeVisible();
    await btn.click();

    await expect(page.getByRole('button', { name: 'Buy / Long' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('checkbox', { name: 'Reduce only' })).toBeChecked();
    await expect(page.getByLabel('Size (SOL)')).toHaveValue('2.000');
  });

  test('captured post-order instruction has exact fields for a close', async ({
    page,
  }) => {
    const rpc = await installMockSolanaRpc(page);
    await installMockPhantom(page);
    rpc.setPortfolioPosition(0, 5_000n, 85_000_000n);
    await page.goto('/trade');

    await page.getByRole('button', { name: 'Close long 5.000 SOL' }).click();
    await page.getByLabel('Price (USD)').fill('85.00');
    await page.getByTestId('order-form-submit').click();

    await expect
      .poll(() =>
        readCapturedTransactions(page).then((transactions) => transactions.length),
      )
      .toBe(1);

    const [transaction] = await readCapturedTransactions(page);
    const postOrder = transaction?.instructions.find(
      (instruction) => instruction.data[0] === 20,
    );
    expect(postOrder).toBeDefined();
    // Discriminator 20 = PostOrder, side = 1 (Sell), is_maker = 0
    expect(postOrder?.data.slice(0, 3)).toEqual([20, 1, 0]);

    const wire = Uint8Array.from(postOrder?.data ?? []);
    const view = new DataView(wire.buffer);
    expect(view.getBigUint64(11, true)).toBe(5_000n);
    expect(view.getUint16(19, true)).toBe(0);
    expect(view.getUint8(21)).toBe(1);
  });
});
