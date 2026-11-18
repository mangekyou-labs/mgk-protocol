import { test, expect } from '@playwright/test';

test.describe('Browser origin hydration', () => {
  for (const origin of ['http://127.0.0.1:3000', 'http://localhost:3000'] as const) {
    test(`opens the wallet selector from ${origin}`, async ({ page }) => {
      await page.goto(`${origin}/trade`);

      await page.getByRole('button', { name: 'Select Wallet' }).click();

      await expect(
        page.getByRole('heading', { name: /connect a wallet on solana/i }),
      ).toBeVisible({ timeout: 3_000 });
    });

    test(`hydrates the reference chart from ${origin}`, async ({ page }) => {
      await page.goto(`${origin}/trade`);

      await expect(page.getByTestId('price-chart-label')).toContainText(
        'Reference price · Binance',
        { timeout: 3_000 },
      );
    });
  }
});

test.describe('Trade page — layout smoke', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/trade');
  });

  test('renders the header with logo, nav, and wallet button', async ({
    page,
  }) => {
    await expect(page.locator('[data-testid="app-header"]')).toBeVisible();
    await expect(page.getByRole('link', { name: 'mgk home' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Trade' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Portfolio' })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Select Wallet' }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Get devnet SOL' }),
    ).toHaveCount(0);
  });

  test('renders the market header with SOL-USD Perp', async ({ page }) => {
    await expect(
      page.locator('[data-testid="market-header"]'),
    ).toBeVisible();
    await expect(
      page.getByTestId('market-selector'),
    ).toHaveText('SOL-USD Perp');
    await expect(page.getByTestId('stat-funding')).toContainText('off');
  });

  test('renders the three-column layout: chart, order book, order form', async ({
    page,
  }) => {
    await expect(page.locator('[data-testid="chart-section"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="orderbook-section"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="orderform-section"]'),
    ).toBeVisible();
  });

  test('has no ticker row, chart toolbar, or depth extras', async ({ page }) => {
    await expect(page.getByTestId('ticker-bar')).toHaveCount(0);
    await expect(page.getByTestId('chart-toolbar')).toHaveCount(0);
    await expect(page.getByTestId('orderbook-imbalance')).toHaveCount(0);
  });

  test('renders the trade page without critical console errors', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    // Wait for async data to settle
    await page.waitForTimeout(10_000);
    // Only fail on React/minified errors, not on RPC 429 / WS connection refused
    const critical = errors.filter(
      (e) =>
        !e.includes('429') &&
        !e.includes('ERR_CONNECTION_REFUSED') &&
        !e.includes('Failed to load resource'),
    );
    expect(critical).toEqual([]);
  });
});

test.describe('Status bar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/trade');
  });

  test('shows offline, Devnet pill, and disconnected wallet', async ({
    page,
  }) => {
    await expect(page.locator('[data-testid="status-bar"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="status-bar"]'),
    ).toContainText('Devnet');
    await expect(
      page.locator('[data-testid="status-bar"]'),
    ).toContainText('Not Connected');
  });
});

test.describe('M7 — TradingView widget + BottomTabs', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/trade');
  });

  test('mounts the TradingView widget at the fixed 15m interval', async ({
    page,
  }) => {
    const widget = page.locator('[data-testid="tradingview-widget"]');
    await expect(widget).toBeVisible();
    await expect(widget).toHaveAttribute('data-symbol', 'BINANCE:SOLUSDT');
    await expect(widget).toHaveAttribute('data-interval', '15');
  });

  test('never fires the deleted /api/pyth proxy endpoint', async ({ page }) => {
    // The historical-candles /api/pyth proxy was deleted in T7.2.
    const pythProxyRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/pyth')) {
        pythProxyRequests.push(req.url());
      }
    });
    // Settle the page through its full async load.
    await page.waitForTimeout(8_000);
    expect(pythProxyRequests).toEqual([]);
  });

  test('BottomTabs is mounted below the 3-column layout', async ({ page }) => {
    const tabs = page.locator('[data-testid="bottom-tabs"]');
    await expect(tabs).toBeVisible();
    // First row has 5 tabs, second row has 3 tabs.
    await expect(page.locator('[data-testid="bottom-tab"]')).toHaveCount(8);
  });

  test('BottomTabs shows the Positions component by default', async ({
    page,
  }) => {
    const content = page.locator('[data-testid="bottom-tabs-content"]');
    await expect(content).toHaveAttribute('data-active-tab', 'positions');
  });

  test('switching to the Balances tab mounts the Balances component', async ({
    page,
  }) => {
    await page.locator('button[data-tab-id="balances"]').click();
    const content = page.locator('[data-testid="bottom-tabs-content"]');
    await expect(content).toHaveAttribute('data-active-tab', 'balances');
  });

  test('MarketHeader shows unknown values as -- rather than 0', async ({
    page,
  }) => {
    // Without a running indexer there is no clear and no collecting batch.
    await expect(page.getByTestId('stat-mark')).toContainText('--');
    await expect(page.getByTestId('stat-collecting')).toContainText('--');
  });
});

test.describe('Order form — UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/trade');
  });

  test('offers a limit GTC order with price, lot size and reduce-only', async ({ page }) => {
    await expect(page.getByText('Limit · good-till-cancelled')).toBeVisible();
    await expect(page.getByLabel('Price (USD)')).toBeVisible();
    await expect(page.getByLabel('Size (SOL)')).toBeVisible();
    const reduceOnly = page.getByRole('checkbox', { name: 'Reduce only' });
    await expect(reduceOnly).not.toBeChecked();
    await reduceOnly.check();
    await expect(reduceOnly).toBeChecked();
  });

  test('side buttons switch between buy and sell', async ({ page }) => {
    const buy = page.getByRole('button', { name: 'Buy / Long' });
    const sell = page.getByRole('button', { name: 'Sell / Short' });
    await expect(buy).toHaveAttribute('aria-pressed', 'true');
    await sell.click();
    await expect(sell).toHaveAttribute('aria-pressed', 'true');
    await expect(buy).toHaveAttribute('aria-pressed', 'false');
  });

  test('has no market, IOC, TP/SL, or post-as-maker controls', async ({ page }) => {
    const form = page.getByTestId('order-form');
    await expect(form.getByText(/^market$/i)).toHaveCount(0);
    await expect(form.getByText(/IOC/)).toHaveCount(0);
    await expect(form.getByText(/TP\/SL/)).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: /post as maker/i })).toHaveCount(0);
  });

  test('disabled submit states its reason when no wallet is connected', async ({ page }) => {
    const submit = page.getByTestId('order-form-submit');
    await expect(submit).toBeDisabled();
    await expect(submit).not.toHaveText('');
  });
});

test.describe('Order form — no legacy commit-reveal journey', () => {
  test('legacy query params do not open a slashed or reveal journey', async ({
    page,
  }) => {
    for (const set of ['slashed', 'committing', 'awaiting_reveal', 'revealing']) {
      await page.goto(`/trade?set=${set}`);
      await expect(page.locator('[data-testid="orderform-section"]')).toBeVisible();
      await expect(
        page.locator('[data-testid="order-form-slashed-banner"]'),
      ).toHaveCount(0);
      await expect(page.getByText(/order slashed/i)).toHaveCount(0);
      await expect(page.getByText(/awaiting reveal/i)).toHaveCount(0);
      await expect(page.getByTestId('order-form-submit')).toBeVisible();
    }
  });

  test('?set=failed keeps the PostOrder form usable', async ({ page }) => {
    await page.goto('/trade?set=failed');
    await expect(
      page.locator('[data-testid="order-form-slashed-banner"]'),
    ).toHaveCount(0);
    await expect(page.getByTestId('order-form-submit')).toBeVisible();
  });
});

