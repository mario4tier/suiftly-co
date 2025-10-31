import { test } from '@playwright/test';

test('debug auth flow with console logs', async ({ page }) => {
  // Capture console logs
  page.on('console', msg => {
    const type = msg.type();
    const text = msg.text();
    console.log(`[BROWSER ${type.toUpperCase()}] ${text}`);
  });

  // Capture errors
  page.on('pageerror', error => {
    console.error(`[BROWSER ERROR] ${error.message}`);
  });

  // Step 1: Clear auth
  await page.goto('http://localhost:5174/');
  await page.evaluate(() => localStorage.clear());
  console.log('[TEST] Cleared localStorage');

  // Step 2: Go to login
  await page.goto('http://localhost:5174/login');
  console.log('[TEST] On login page');

  // Wait a bit for page to fully load
  await page.waitForTimeout(1000);

  // Take screenshot before clicking
  await page.screenshot({ path: 'before-mock-wallet.png' });
  console.log('[TEST] Screenshot taken before clicking');

  // Step 3: Click Mock Wallet
  console.log('[TEST] About to click Mock Wallet button...');
  await page.click('text=Mock Wallet');
  console.log('[TEST] Clicked Mock Wallet button');

  // Wait and see what happens
  await page.waitForTimeout(5000);

  // Take screenshot after clicking
  await page.screenshot({ path: 'after-mock-wallet.png', fullPage: true });
  console.log('[TEST] Screenshot taken after clicking');
  console.log(`[TEST] Current URL: ${page.url()}`);

  // Check localStorage
  const localStorage = await page.evaluate(() => {
    return JSON.stringify(window.localStorage);
  });
  console.log(`[TEST] localStorage: ${localStorage}`);
});
