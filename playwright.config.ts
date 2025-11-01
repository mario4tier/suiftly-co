import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './apps/webapp/tests/e2e',
  fullyParallel: false, // Run sequentially to avoid state conflicts
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Single worker to avoid race conditions
  reporter: 'line',

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    // Normal expiry tests (production config: 15m/30d)
    // Fast tests that verify tokens work correctly over time
    {
      name: 'normal-expiry',
      testMatch: /token-refresh\.spec\.ts/,
      grep: /Normal Config/,
      use: { ...devices['Desktop Chrome'] },
    },

    // Short expiry tests (test config: 2s/10s)
    // Tests complete 30-day lifecycle in ~15 seconds
    // NOTE: Requires manually starting servers with test config:
    //   ENABLE_SHORT_JWT_EXPIRY=true JWT_SECRET=TEST_DEV_SECRET_1234567890abcdef MOCK_AUTH=true DATABASE_URL="postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev" npm run dev --workspace=@suiftly/api
    //   npm run dev --workspace=@suiftly/webapp
    {
      name: 'short-expiry',
      testMatch: /token-refresh\.spec\.ts/,
      grep: /Short Expiry/,
      use: { ...devices['Desktop Chrome'] },
    },

    // Other E2E tests (existing tests)
    {
      name: 'chromium',
      testIgnore: /token-refresh\.spec\.ts/, // Exclude token refresh tests
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Default server for other tests (reuse existing dev server)
  webServer: {
    command: 'echo "Using existing dev server on port 5173"',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 5000,
  },
});
