import { expect, test } from '@playwright/test';

for (const path of ['/', '/trade', '/portfolio']) {
  for (const width of [375, 768, 1280]) {
    test(`${path} is closed for maintenance at ${width}px, including a remembered wallet`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(() => {
        const state = window as unknown as { maintenanceWalletCalls: string[] };
        state.maintenanceWalletCalls = [];
        const publicKey = { toBytes: () => new Uint8Array(32).fill(1) };
        const wallet: Record<string, unknown> = {
          isPhantom: true,
          isConnected: true,
          publicKey,
          on() {},
          off() {},
        };
        for (const method of ['connect', 'signTransaction', 'signAllTransactions', 'signAndSendTransaction', 'signMessage']) {
          wallet[method] = async () => {
            state.maintenanceWalletCalls.push(method);
            throw new Error(`Unexpected wallet request during maintenance: ${method}`);
          };
        }
        Object.defineProperty(window, 'solana', { configurable: true, value: wallet });
        Object.defineProperty(window, 'phantom', { configurable: true, value: { solana: wallet } });
        localStorage.setItem('walletName', JSON.stringify('Phantom'));
      });

      const transactionRequests: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST') transactionRequests.push(request.url());
      });

      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('status')).toContainText('The demo is being rebuilt.');
      await expect(page.getByRole('status')).toContainText('Earlier devnet balances were not carried over.');

      for (const name of ['Place order', 'Cancel order', 'Deposit', 'Withdraw']) {
        const button = page.getByRole('button', { name, exact: true });
        await expect(button).toBeDisabled();
        await expect(button).toHaveAccessibleDescription(/disabled while we rebuild the demo/);
      }

      await page.waitForLoadState('networkidle');
      expect(await page.evaluate(() => (
        window as unknown as { maintenanceWalletCalls: string[] }
      ).maintenanceWalletCalls)).toEqual([]);
      expect(transactionRequests).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
}
