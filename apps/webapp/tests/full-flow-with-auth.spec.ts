import { test, expect } from '@playwright/test';

test('complete flow: login with mock wallet and navigate dashboard', async ({ page }) => {
  // Step 1: Clear any existing auth
  await page.goto('http://localhost:5174/');
  await page.evaluate(() => localStorage.clear());
  console.log('✓ Cleared localStorage');

  // Step 2: Go to login page
  await page.goto('http://localhost:5174/login');
  console.log('✓ Navigated to login page');

  // Step 3: Click Mock Wallet button
  await page.click('text=Mock Wallet 0');
  console.log('✓ Clicked Mock Wallet button');

  // Step 4: Wait for authentication and redirect to dashboard
  await page.waitForURL(/\/(dashboard|services)/, { timeout: 10000 });
  console.log(`✓ Redirected to: ${page.url()}`);

  // Step 5: Take screenshot of authenticated dashboard
  await page.screenshot({ path: 'authenticated-dashboard.png', fullPage: true });
  console.log('✓ Screenshot saved to authenticated-dashboard.png');

  // Step 6: Verify wallet widget is visible
  const walletWidget = await page.locator('button:has-text("0x")').first();
  await expect(walletWidget).toBeVisible();
  console.log('✓ Wallet widget is visible');

  // Step 7: Navigate to different pages
  await page.click('text=gRPC');
  await page.waitForURL(/\/services\/grpc/);
  console.log('✓ Navigated to gRPC page');

  await page.click('text=GraphQL');
  await page.waitForURL(/\/services\/graphql/);
  console.log('✓ Navigated to GraphQL page');

  await page.click('text=Dashboard');
  await page.waitForURL(/\/dashboard/);
  console.log('✓ Navigated back to Dashboard');

  // Step 8: Final screenshot
  await page.screenshot({ path: 'dashboard-final.png', fullPage: true });
  console.log('✓ Final screenshot saved');

  console.log('\n=== FULL FLOW SUCCESSFUL ===');
});
