import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './apps/webapp/tests/e2e',
  fullyParallel: false, // Run sequentially to avoid state conflicts
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Single worker to avoid race conditions
  reporter: 'line',
  globalSetup: './playwright-global-setup.ts',
  globalTeardown: './playwright-global-teardown.ts',
  maxFailures: 1, // Stop on first test failure for fast feedback
  // 60s per-test timeout (Playwright default is 30s). Long E2E suites
  // run for 15+ minutes on this dev box, and individual UI interactions
  // can occasionally exceed 30s under system load even though the test
  // itself is correct (observed: platform-subscription 30s timeout that
  // passes in 10s when run in isolation). A 60s budget absorbs load
  // jitter; a truly hung test still fails, just 30s later.
  timeout: 60_000,

  use: {
    baseURL: 'http://localhost:22710', // See ~/mhaxbe/PORT_MAP.md for port allocation
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Grant clipboard permissions for tests that verify copy functionality
    permissions: ['clipboard-read', 'clipboard-write'],
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
    // Servers started via globalSetup with test config
    {
      name: 'short-expiry',
      testMatch: /token-refresh\.spec\.ts/,
      grep: /Short Expiry/,
      retries: 1,  // Retry timing-sensitive tests once
      use: { ...devices['Desktop Chrome'] },
    },

    // Other E2E tests (existing tests)
    {
      name: 'chromium',
      testIgnore: /token-refresh\.spec\.ts/, // Exclude token refresh tests
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
