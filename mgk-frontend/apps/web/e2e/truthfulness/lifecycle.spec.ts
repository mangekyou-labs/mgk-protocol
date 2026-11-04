import { test, expect } from './fixture';

test('onboard, deposit, post, cancel, await settlement, settle, close and withdraw', async ({ page, market, evidence }) => {
  await page.goto('/trade');
  await expect(page.getByRole('heading', { name: 'Deposit collateral' })).toBeVisible();
  await expect(page.getByTestId('order-form')).toHaveCount(0);
  await expect(page.getByTestId('demo-notice')).toContainText('Earlier devnet balances were not carried over.');
  await expect(page.getByTestId('price-chart-label')).toContainText('Reference price · Binance');
  await page.getByTestId('demo-notice').locator('summary').click();
  await expect(page.getByText('No mainnet, other markets,', { exact: false })).toBeVisible();
  await evidence('01-connected-not-ready');

  await page.getByTestId('account-actions-amount').fill('1');
  await expect(page.getByTestId('account-actions-deposit')).toBeEnabled();
  await page.getByTestId('account-actions-deposit').click();
  await expect(page.getByTestId('order-form')).toBeVisible();
  await page.getByRole('tab', { name: 'Collateral', exact: true }).click();
  await expect(page.getByTestId('balances-equity')).toHaveText('1.000000000 SOL');
  await evidence('02-deposited');
  await page.reload();
  await expect(page.getByTestId('order-form')).toBeVisible();
  await page.getByRole('tab', { name: 'Collateral', exact: true }).click();
  await expect(page.getByTestId('balances-equity')).toHaveText('1.000000000 SOL');
  await evidence('03-reloaded-chain-observation');

  const submit = page.getByTestId('order-form-submit');
  await expect(submit).toBeDisabled();
  await expect(submit).toHaveText('Enter a price.');
  await page.getByLabel('Price (USD)', { exact: true }).fill('100');
  await page.getByLabel('Size (SOL)', { exact: true }).fill('0.0001');
  await expect(submit).toBeDisabled();
  await expect(submit).toHaveText('Size must be a multiple of 0.001 SOL.');
  await evidence('04-disabled-reason');
  await page.getByLabel('Size (SOL)', { exact: true }).fill('11');
  await expect(submit).toContainText('Portfolio exposure limit');
  await expect(submit).toBeDisabled();
  await evidence('04b-exposure-limit');
  await page.getByLabel('Size (SOL)', { exact: true }).fill('1');
  await page.getByLabel('Price (USD)', { exact: true }).fill('100000');
  await expect(submit).toContainText('margin');
  await expect(submit).toBeDisabled();
  await evidence('04c-margin-reason');
  await page.getByLabel('Price (USD)', { exact: true }).fill('100');
  await page.getByLabel('Size (SOL)', { exact: true }).fill('0.1');
  await expect(submit).toBeEnabled();
  market.holdWallet = true; market.holdConfirmation = true;
  await submit.click();
  await expect(submit).toHaveText('Approve in wallet…');
  await expect.poll(() => market.releaseWallet !== null).toBe(true);
  await evidence('04d-approve-in-wallet');
  market.releaseWallet!(); market.holdWallet = false;
  await expect(submit).toHaveText('Confirming…');
  await evidence('04e-confirming');
  market.holdConfirmation = false;
  await expect(page.getByTestId('order-lifecycle')).toHaveText('Accepted · on the book in batch 0');
  await page.getByRole('tab', { name: 'Open orders', exact: true }).click();
  await expect(page.getByTestId('open-order-row')).toHaveCount(1);
  await expect(page.getByTestId('order-lifecycle')).not.toContainText('Filled');
  await evidence('05-posted-resting');
  await expect(page.getByTestId('tx-toast-status')).toHaveText('Transaction Confirmed');
  // The fixed confirmation toast can cover Cancel with CI's font metrics.
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.getByTestId('tx-toast')).toHaveCount(0, { timeout: 2_000 });
  await page.getByTestId('open-order-cancel').click();
  await expect(page.getByTestId('open-orders-empty')).toBeVisible();
  await evidence('06-cancelled');

  await submit.click();
  await expect(page.getByTestId('open-order-row')).toHaveCount(1);
  market.clear();
  await expect(page.getByTestId('order-lifecycle')).toHaveText('Batch 0 cleared · awaiting settlement');
  await expect(submit).toBeDisabled();
  await expect(submit).toHaveText('Batch 0 cleared, awaiting settlement.');
  await page.getByTestId('account-actions-amount').fill('0.5');
  await expect(page.getByTestId('account-actions-withdraw')).toBeDisabled();
  await expect(page.getByTestId('readiness-reason')).toContainText(/settlement/i);
  await page.getByRole('tab', { name: 'Positions', exact: true }).click();
  await expect(page.getByTestId('position-row')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Fills', exact: true }).click();
  await expect(page.getByTestId('trade-history-empty')).toBeVisible();
  await evidence('07-filled-awaiting-settlement');

  market.settle();
  await expect(page.getByTestId('order-lifecycle')).toHaveText('Filled · settled in batch 0');
  await page.getByRole('tab', { name: 'Positions', exact: true }).click();
  await expect(page.getByTestId('position-row')).toHaveCount(1);
  await expect(page.getByTestId('positions')).toContainText('DFBA mark, batch 0');
  await evidence('08-settled-position');

  // The keeper, not the wallet, supplies fixture settlement observations.
  await page.getByRole('button', { name: 'Close long 0.100 SOL', exact: true }).click();
  await expect(page.getByLabel('Reduce only')).toBeChecked();
  await expect(page.getByLabel('Size (SOL)', { exact: true })).toHaveValue('0.100');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByTestId('order-lifecycle')).toContainText('Accepted');
  await evidence('09-close-posted-reduce-only');
  market.clear();
  await expect(page.getByTestId('order-lifecycle')).toContainText('awaiting settlement');
  await expect(page.getByTestId('position-row')).toHaveCount(1);
  await evidence('10-close-awaiting-settlement');
  market.settle(true);
  await expect(page.getByTestId('position-row')).toHaveCount(0);
  await expect(page.getByTestId('positions')).toContainText('You have no open positions yet.');
  await evidence('11-closed');

  await page.getByTestId('account-actions-amount').fill('0.5');
  await expect(page.getByTestId('account-actions-withdraw')).toBeEnabled();
  await page.getByTestId('account-actions-withdraw').click();
  await page.getByRole('tab', { name: 'Collateral', exact: true }).click();
  await expect(page.getByTestId('balances-equity')).toHaveText('0.500000000 SOL');
  await evidence('12-withdrawn');
});

test('unknown prices and outages remain unavailable; pause and stale oracle explain disabled actions', async ({ page, market, evidence }) => {
  market.collateral = 1_000_000_000n; market.position = true;
  await page.goto('/trade');
  await expect(page.getByTestId('position-row')).toHaveCount(1);
  await expect(page.getByTestId('position-pnl')).toHaveText('Unavailable');
  await expect(page.getByTestId('position-sol-pnl')).toHaveText('Unavailable');
  await evidence('unknown-mark-is-not-zero');
  market.paused = true;
  await expect(page.getByTestId('order-form-submit')).toBeDisabled();
  await expect(page.getByTestId('order-form-submit')).toContainText(/paused/i);
  await expect(page.getByTestId('system-status')).toContainText('Cancels and reduce-only closes remain permitted');
  await evidence('pause-reason');
  market.paused = false; market.staleOracle = true;
  await expect(page.getByTestId('order-form-submit')).toContainText(/stale/i);
  await expect(page.getByTestId('position-sol-pnl')).toHaveText('Unavailable');
  await expect(page.getByTestId('position-health')).toHaveText('Unavailable');
  await evidence('stale-oracle');
  market.missingOracle = true;
  await expect(page.getByTestId('position-liq')).toHaveText('Unavailable');
  await evidence('oracle-down-risk-unavailable');
  market.missingOracle = false;
  market.indexer = 'syncing';
  await page.getByRole('tab', { name: 'Fills', exact: true }).click();
  await expect(page.getByTestId('trade-history-unavailable')).toContainText('syncing');
  await evidence('indexer-syncing');
  market.indexer = 'down';
  await expect(page.getByTestId('trade-history-unavailable')).toContainText('unavailable');
  await expect(page.getByTestId('system-status')).toContainText('History is unavailable');
  await evidence('indexer-down');
  market.rpcDown = true;
  await page.getByRole('tab', { name: 'Collateral', exact: true }).click();
  await expect(page.getByTestId('bottom-tabs-content')).toContainText('Portfolio unavailable');
  await expect(page.getByTestId('balances-equity')).toHaveCount(0);
  await evidence('rpc-down-collateral-unknown');
});

for (const reason of ['wrong cluster', 'manifest mismatch'] as const) {
  test(`${reason} blocks signing with an actionable reason`, async ({ page, market, evidence }) => {
    market.collateral = 1_000_000_000n;
    market.wrongCluster = reason === 'wrong cluster';
    market.manifestMismatch = reason === 'manifest mismatch';
    await page.goto('/trade');
    await expect(page.getByRole('heading', { name: 'Deposit collateral' })).toBeVisible();
    await page.getByTestId('account-actions-amount').fill('0.1');
    await expect(page.getByTestId('account-actions-deposit')).toBeDisabled();
    await expect(page.getByTestId('readiness-reason')).toContainText(reason === 'wrong cluster' ? /Check your RPC|devnet/i : /manifest mismatch.*Reload/i);
    await expect(page.getByTestId('order-form')).toHaveCount(0);
    expect(market.walletRequests).toEqual([]);
    await evidence(reason.replaceAll(' ', '-'));
  });
}
