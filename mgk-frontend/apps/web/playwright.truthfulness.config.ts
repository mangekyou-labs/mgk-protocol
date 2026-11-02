import { defineConfig, devices } from '@playwright/test';

// Remote runs never start or silently fall back to a local server.
const baseURL = process.env.E2E_BASE_URL;
if (!baseURL) throw new Error('E2E_BASE_URL is required. Use e2e:truthfulness:local for controlled local evidence.');
const target = new URL(baseURL);
if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.search || target.hash || target.pathname !== '/') throw new Error('Invalid E2E_BASE_URL');
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
export default defineConfig({
  testDir: './e2e/truthfulness',
  testMatch: '*.spec.ts',
  outputDir: './test-results/truthfulness',
  workers: 1, retries: 0, timeout: 120_000, forbidOnly: !!process.env.CI,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: 'test-results/truthfulness/results.json' }]],
  use: {
    baseURL, ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1100 },
    trace: 'off', screenshot: 'only-on-failure', serviceWorkers: 'block',
    ...(bypass ? { extraHTTPHeaders: { 'x-vercel-protection-bypass': bypass, 'x-vercel-set-bypass-cookie': 'true' } } : {}),
  },
});
