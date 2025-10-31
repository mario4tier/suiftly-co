import { test, expect } from '@playwright/test';

test('dashboard redirects to login when not authenticated', async ({ page }) => {
  // Clear localStorage to ensure we're not authenticated
  await page.goto('http://localhost:5174/');
  await page.evaluate(() => localStorage.clear());

  // Try to access dashboard
  await page.goto('http://localhost:5174/dashboard');

  // Should redirect to login
  await page.waitForURL(/\/login/);

  expect(page.url()).toContain('/login');
  console.log('✓ Dashboard correctly redirects to login when not authenticated');
});

test('dashboard is accessible after authentication', async ({ page }) => {
  // Go to login page
  await page.goto('http://localhost:5174/login');

  // Connect with mock wallet
  await page.click('text=Connect Mock Wallet');

  // Wait for authentication and redirect
  await page.waitForURL(/\/dashboard/, { timeout: 10000 });

  // Verify we're on dashboard
  expect(page.url()).toContain('/dashboard');
  console.log('✓ Dashboard accessible after authentication');

  // Verify wallet widget is shown
  const walletWidget = await page.locator('text=/0x[a-f0-9]{4}\.\.\.[a-f0-9]{4}/').first();
  await expect(walletWidget).toBeVisible();
  console.log('✓ Wallet widget displayed');
});
