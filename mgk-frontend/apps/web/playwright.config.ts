import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // This immutable build is the maintenance rollback target. Restore the live
  // trading suites when the rebuilt demo replaces this shell (issue #34).
  testMatch: 'maintenance.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:3019',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm dev --port 3019',
    url: 'http://localhost:3019',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
