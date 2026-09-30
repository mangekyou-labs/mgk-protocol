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

    await page.locator('[data-testid="order-form-price-input"]').fill('100.25');
    await page.locator('[data-testid="order-form-qty-input"]').fill('2.5');
    await page.getByRole('checkbox', { name: /post as maker/i }).check();
    await page.locator('[data-testid="order-form-submit-buy"]').click();

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
    expect(postOrder?.data.slice(0, 3)).toEqual([20, 0, 1]);

    const wire = Uint8Array.from(postOrder?.data ?? []);
    const view = new DataView(wire.buffer);
    expect(view.getBigInt64(3, true)).toBe(100_250_000n);
    expect(view.getBigUint64(11, true)).toBe(2_500_000n);
    expect(view.getUint16(19, true)).toBe(0);
    expect(view.getUint8(21)).toBe(0);
    expect(postOrder?.keys).toHaveLength(6);
    expect(postOrder?.keys[1]?.isSigner).toBe(true);
  });
});
