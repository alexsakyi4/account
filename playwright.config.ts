import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end suite. Runs against a real server + database:
 *
 *   npm run build && npm start   # or: npm run dev
 *   npx playwright install --with-deps
 *   npm run test:e2e
 *
 * The suite creates its own company through the UI so it never depends on
 * seed data, and it exercises the invoice → payment → bill → reconciliation
 * journey end to end.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    acceptDownloads: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:5173/login',
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
