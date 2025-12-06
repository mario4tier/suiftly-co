import { test, expect } from '@playwright/test';

test('visual check of sidebar separator', async ({ page }) => {
  // Go directly to dashboard (skip auth for visual check)
  await page.goto('http://localhost:22710/dashboard');

  // Wait for sidebar to load
  await page.waitForSelector('aside');

  // Take screenshot
  await page.screenshot({ path: 'sidebar-check.png', fullPage: true });

  console.log('Screenshot saved to sidebar-check.png');
});
