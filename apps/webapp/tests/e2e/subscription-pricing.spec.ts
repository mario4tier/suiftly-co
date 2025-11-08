/**
 * Subscription Pricing Validation Tests
 * Tests that subscription validation shows correct pricing in error messages
 * and properly handles various balance scenarios
 */

import { test, expect } from '@playwright/test';

test.describe('Subscription Pricing Validation', () => {
  test.beforeEach(async ({ page }) => {
    // Authenticate with mock wallet first
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');

    // Wait for redirect to /dashboard after auth
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Wait for authentication toast to disappear before starting tests
    await page.waitForTimeout(3000);
  });

  test('all three tiers show correct prices when balance is insufficient', async ({ page }) => {
    // Reset with zero balance
    await page.request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 0, // $0
        spendingLimitUsdCents: 25000, // $250
      },
    });

    // Navigate to seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Accept terms
    await page.locator('label:has-text("Agree to")').click();

    // Test STARTER tier - $9
    await page.getByRole('heading', { name: 'STARTER' }).click();
    let subscribeButton = page.locator('button:has-text("Subscribe to Service")');

    // Count existing toasts before clicking
    const initialToastCount = await page.locator('[data-sonner-toast]').count();
    await subscribeButton.click();

    // Wait for new toast to appear
    await page.waitForSelector(`[data-sonner-toast]:nth-child(${initialToastCount + 1})`, { timeout: 5000 });
    let toast = page.locator('[data-sonner-toast]').last();
    await expect(toast).toContainText('Insufficient balance');
    await expect(toast).toContainText('Need $9');
    await expect(toast).toContainText('have $0');

    console.log('✅ STARTER tier shows correct price: $9');

    // Reset data (subscription creates service record even if payment fails)
    await page.request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 0, // $0
        spendingLimitUsdCents: 25000, // $250
      },
    });

    // Dismiss toast and test PRO tier - $29
    await page.waitForTimeout(2000); // Wait for toast to auto-dismiss
    await page.getByRole('heading', { name: 'PRO' }).click();
    subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();

    // Wait for validation response and check toast message
    await page.waitForTimeout(500);
    toast = page.locator('[data-sonner-toast]').last();
    await expect(toast).toContainText('Insufficient balance');
    await expect(toast).toContainText('Need $29');
    await expect(toast).toContainText('have $0');

    console.log('✅ PRO tier shows correct price: $29');

    // Reset data (subscription creates service record even if payment fails)
    await page.request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 0, // $0
        spendingLimitUsdCents: 25000, // $250
      },
    });

    // Dismiss toast and test ENTERPRISE tier - $185
    await page.waitForTimeout(2000); // Wait for toast to auto-dismiss
    await page.getByRole('heading', { name: 'ENTERPRISE' }).click();
    subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();

    // Wait for validation response and check toast message
    await page.waitForTimeout(500);
    toast = page.locator('[data-sonner-toast]').last();
    await expect(toast).toContainText('Insufficient balance');
    await expect(toast).toContainText('Need $185');
    await expect(toast).toContainText('have $0');

    console.log('✅ ENTERPRISE tier shows correct price: $185');
    console.log('✅ All three tiers show correct pricing in error messages');
  });

  test('PRO tier subscription fails when balance is short by $1', async ({ page }) => {
    // Reset with $28 balance (need $29 for PRO)
    await page.request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 2800, // $28.00
        spendingLimitUsdCents: 25000, // $250
      },
    });

    // Navigate to seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Accept terms and select PRO tier (default)
    await page.locator('label:has-text("Agree to")').click();
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();

    // Wait for validation response and check toast message
    await page.waitForTimeout(500);
    const toast = page.locator('[data-sonner-toast]').last();
    await expect(toast).toContainText('Insufficient balance');
    await expect(toast).toContainText('Need $29');
    await expect(toast).toContainText('have $28');

    console.log('✅ PRO tier correctly rejects when balance is $28 (short by $1)');
  });

  test('PRO tier subscription succeeds when balance is exactly $29', async ({ page }) => {
    // Reset with exactly $29 balance
    await page.request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 2900, // $29.00
        spendingLimitUsdCents: 25000, // $250
      },
    });

    // Navigate to seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Accept terms and select PRO tier (default)
    await page.locator('label:has-text("Agree to")').click();
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();

    // Wait for validation and subscription to complete
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    // Should redirect away from onboarding form - wait for service state banner
    await expect(page.locator('text=/Service is subscribed but currently disabled/i')).toBeVisible({ timeout: 5000 });

    // The page should now show the service management interface
    await expect(page.getByRole('heading', { name: 'Guaranteed Bandwidth' })).not.toBeVisible();

    console.log('✅ PRO tier subscription succeeds with exactly $29 balance');
  });

  test('STARTER tier subscription fails when balance is short by $1', async ({ page }) => {
    // Reset with $8 balance (need $9 for STARTER)
    await page.request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 800, // $8.00
        spendingLimitUsdCents: 25000, // $250
      },
    });

    // Navigate to seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Accept terms and select STARTER tier
    await page.locator('label:has-text("Agree to")').click();
    await page.getByRole('heading', { name: 'STARTER' }).click();
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();

    // Wait for validation response and check toast message
    await page.waitForTimeout(500);
    const toast = page.locator('[data-sonner-toast]').last();
    await expect(toast).toContainText('Insufficient balance');
    await expect(toast).toContainText('Need $9');
    await expect(toast).toContainText('have $8');

    console.log('✅ STARTER tier correctly rejects when balance is $8 (short by $1)');
  });

  test('STARTER tier subscription succeeds when balance is exactly $9', async ({ page }) => {
    // Reset with exactly $9 balance
    await page.request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 900, // $9.00
        spendingLimitUsdCents: 25000, // $250
      },
    });

    // Navigate to seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Accept terms and select STARTER tier
    await page.locator('label:has-text("Agree to")').click();
    await page.getByRole('heading', { name: 'STARTER' }).click();
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();

    // Wait for validation and subscription to complete
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    // Should redirect away from onboarding form - wait for service state banner
    await expect(page.locator('text=/Service is subscribed but currently disabled/i')).toBeVisible({ timeout: 5000 });

    // Should redirect away from onboarding form
    await expect(page.getByRole('heading', { name: 'Guaranteed Bandwidth' })).not.toBeVisible();

    console.log('✅ STARTER tier subscription succeeds with exactly $9 balance');
  });

  test('ENTERPRISE tier subscription fails when balance is short by $1', async ({ page }) => {
    // Reset with $184 balance (need $185 for ENTERPRISE)
    await page.request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 18400, // $184.00
        spendingLimitUsdCents: 25000, // $250
      },
    });

    // Navigate to seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Accept terms and select ENTERPRISE tier
    await page.locator('label:has-text("Agree to")').click();
    await page.getByRole('heading', { name: 'ENTERPRISE' }).click();
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();

    // Wait for validation response and check toast message
    await page.waitForTimeout(500);
    const toast = page.locator('[data-sonner-toast]').last();
    await expect(toast).toContainText('Insufficient balance');
    await expect(toast).toContainText('Need $185');
    await expect(toast).toContainText('have $184');

    console.log('✅ ENTERPRISE tier correctly rejects when balance is $184 (short by $1)');
  });

  test('ENTERPRISE tier subscription succeeds when balance is exactly $185', async ({ page }) => {
    // Reset with exactly $185 balance
    await page.request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 18500, // $185.00
        spendingLimitUsdCents: 25000, // $250
      },
    });

    // Navigate to seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Accept terms and select ENTERPRISE tier
    await page.locator('label:has-text("Agree to")').click();
    await page.getByRole('heading', { name: 'ENTERPRISE' }).click();
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();

    // Wait for validation and subscription to complete
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    // Should redirect away from onboarding form - wait for service state banner
    await expect(page.locator('text=/Service is subscribed but currently disabled/i')).toBeVisible({ timeout: 5000 });

    // Should redirect away from onboarding form
    await expect(page.getByRole('heading', { name: 'Guaranteed Bandwidth' })).not.toBeVisible();

    console.log('✅ ENTERPRISE tier subscription succeeds with exactly $185 balance');
  });

  test('subscribe button shows correct prices for all tiers', async ({ page }) => {
    // Reset with sufficient balance
    await page.request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 100000, // $1000
        spendingLimitUsdCents: 25000, // $250
      },
    });

    // Navigate to seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Accept terms
    await page.locator('label:has-text("Agree to")').click();

    // Check STARTER price - $9
    await page.getByRole('heading', { name: 'STARTER' }).click();
    await expect(page.locator('button:has-text("$9.00/month")')).toBeVisible();
    console.log('✅ STARTER tier button shows $9.00/month');

    // Check PRO price - $29
    await page.getByRole('heading', { name: 'PRO' }).click();
    await expect(page.locator('button:has-text("$29.00/month")')).toBeVisible();
    console.log('✅ PRO tier button shows $29.00/month');

    // Check ENTERPRISE price - $185
    await page.getByRole('heading', { name: 'ENTERPRISE' }).click();
    await expect(page.locator('button:has-text("$185.00/month")')).toBeVisible();
    console.log('✅ ENTERPRISE tier button shows $185.00/month');

    console.log('✅ All tier buttons show correct pricing');
  });
});
