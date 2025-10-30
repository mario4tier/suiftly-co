/**
 * Seal Service Configuration E2E Test
 * Phase 10: Test configuration form and live pricing
 */

import { test, expect } from '@playwright/test';

test.describe('Seal Service Configuration', () => {
  test.beforeEach(async ({ page }) => {
    // Authenticate
    await page.goto('http://localhost:5173/login');
    await page.click('text=Connect Wallet');
    await page.click('text=Connect Mock Wallet');

    // Wait for redirect to /services/seal
    await page.waitForURL('/services/seal', { timeout: 10000 });
  });

  test('configuration form is visible with default values', async ({ page }) => {
    // Should see page title
    await expect(page.locator('h2:has-text("Seal Storage")')).toBeVisible();

    // Should see tier selection
    await expect(page.locator('text=STARTER')).toBeVisible();
    await expect(page.locator('text=PRO')).toBeVisible();

    // Should see STARTER selected by default
    await expect(page.locator('button:has-text("STARTER") >> text=SELECTED')).toBeVisible();

    // Should see default price ($20 for Starter)
    await expect(page.locator('text=$20.00')).toBeVisible();

    // Should see Enable Service button
    await expect(page.locator('button:has-text("Enable Service")')).toBeVisible();
  });

  test('selecting PRO tier updates price correctly', async ({ page }) => {
    // Click PRO tier
    await page.click('button:has-text("PRO")');

    // PRO should now show SELECTED badge
    await expect(page.locator('button:has-text("PRO") >> text=SELECTED')).toBeVisible();

    // Price should update to $40
    await expect(page.locator('text=$40.00')).toBeVisible();

    console.log('✅ PRO tier selection works, price updated to $40');
  });

  test('enabling burst adds $10 to price', async ({ page }) => {
    // Select PRO tier first (burst only available for Pro)
    await page.click('button:has-text("PRO")');
    await expect(page.locator('text=$40.00')).toBeVisible();

    // Enable burst
    await page.click('label:has-text("Enable burst")');

    // Price should update to $50 ($40 + $10)
    await expect(page.locator('text=$50.00')).toBeVisible();

    console.log('✅ Burst enabled, price updated to $50');
  });

  test('burst is disabled for STARTER tier', async ({ page }) => {
    // Should be on STARTER by default
    // Burst checkbox should be disabled
    const burstCheckbox = page.locator('input[id="burst"]');
    await expect(burstCheckbox).toBeDisabled();

    console.log('✅ Burst correctly disabled for STARTER tier');
  });

  test('adding seal keys updates price correctly', async ({ page }) => {
    // Select PRO tier ($40 base)
    await page.click('button:has-text("PRO")');

    // Find seal keys input
    const sealKeysInput = page.locator('input[id="sealKeys"]');

    // Change from 1 to 2 seal keys (+$5)
    await sealKeysInput.fill('2');

    // Price should update to $45 ($40 + $5)
    await expect(page.locator('text=$45.00')).toBeVisible();

    console.log('✅ Adding seal key updated price to $45');
  });

  test('adding packages updates price correctly', async ({ page }) => {
    // Select PRO tier ($40 base)
    await page.click('button:has-text("PRO")');

    // Find packages input
    const packagesInput = page.locator('input[id="packages"]');

    // Change from 3 to 5 packages (+2 additional × $1 = $2)
    await packagesInput.fill('5');

    // Price should update to $42 ($40 + $2)
    await expect(page.locator('text=$42.00')).toBeVisible();

    console.log('✅ Adding packages updated price to $42');
  });

  test('complex configuration calculates correct total', async ({ page }) => {
    // Select PRO tier ($40)
    await page.click('button:has-text("PRO")');

    // Enable burst (+$10)
    await page.click('label:has-text("Enable burst")');

    // Set 2 seal keys (+$5)
    await page.locator('input[id="sealKeys"]').fill('2');

    // Set 5 packages per key (2 additional × $1 × 2 keys = $4)
    await page.locator('input[id="packages"]').fill('5');

    // Set 2 API keys (+$1)
    await page.locator('input[id="apiKeys"]').fill('2');

    // Total: $40 + $10 + $5 + $4 + $1 = $60
    await expect(page.locator('text=$60.00')).toBeVisible();

    console.log('✅ Complex configuration: $40 + $10 + $5 + $4 + $1 = $60');
  });
});
