import { defineConfig, devices } from '@playwright/test';

if (process.env.CAS_E2E_ALLOW_WRITES !== 'true') {
  throw new Error(
    'The browser suite can register users and create or update records. Set CAS_E2E_ALLOW_WRITES=true only when every service points to a disposable test project.',
  );
}

export default defineConfig({
  testDir: './e2e',
  timeout: 45000,
  expect: {
    timeout: 10000,
  },
  fullyParallel: false,
  workers: 1, // run sequentially to avoid state collisions in shared SQLite
  reporter: [
    ['list'],
    ['json', { outputFile: 'playwright-report.json' }],
    ['html', { outputFolder: 'playwright-report', open: 'never' }]
  ],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    browserName: 'chromium',
    headless: true,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
});
