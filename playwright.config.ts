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
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Wait for existing server to be ready (started via start-dev.sh)
  webServer: {
    command: 'echo "Using existing dev server on port 5173"',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 5000,
  },
});
