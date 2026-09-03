import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/public-e2e',
  outputDir: './.tmp/playwright-public-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['line']],
  use: {
    baseURL: 'http://127.0.0.1:4175',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command:
        'node scripts/check-freeze.mjs && node node_modules/vite/bin/vite.js build app && node tests/public-e2e/serve-public-candidate.mjs',
      url: 'http://127.0.0.1:4175',
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command:
        'node node_modules/vite/bin/vite.js app --host 127.0.0.1 --port 4176 --strictPort',
      url: 'http://127.0.0.1:4176',
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
