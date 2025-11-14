/**
 * Subscription Without Funds E2E Test
 * Tests that subscription without sufficient funds still creates the service
 * and transitions the UI from onboarding to interactive form.
 *
 * Issue: When subscribing without funds, the service is created but the UI
 * doesn't transition because the API returns an error instead of success.
 */

import { test, expect } from '@playwright/test';
import { getBanner } from '../helpers/locators';

test.describe('Subscription Without Funds', () => {
  test.beforeEach(async ({ page, request }) => {
    // Reset customer test data (delete all services, zero balance, NO escrow account)
    await request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 0, // $0 balance
        spendingLimitUsdCents: 25000, // $250
        clearEscrowAccount: true, // Ensure no escrow account exists
      },
    });

    // Authenticate with mock wallet
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');

    // Wait for redirect to /dashboard after auth
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Navigate to seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
  });

  test('UI transitions to interactive form after subscription without funds', async ({ page }) => {
    // Should start with onboarding form
    await expect(page.locator('h3:has-text("Guaranteed Bandwidth")')).toBeVisible();

    // Accept terms and subscribe
    await page.locator('label:has-text("Agree to")').click();
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await expect(subscribeButton).toBeEnabled();
    await subscribeButton.click();

    // Wait for subscription response (may show error about funds)
    await page.waitForTimeout(2000);

    // EXPECTED BEHAVIOR: Even without funds, the page should transition to interactive form
    // The onboarding form should disappear
    await expect(page.locator('h3:has-text("Guaranteed Bandwidth")')).not.toBeVisible({ timeout: 5000 });

    // Should show payment pending banner (not the normal disabled state banner)
    await expect(getBanner(page)).toContainText('Subscription payment pending', { timeout: 5000 });
    await expect(getBanner(page)).toContainText('Add funds via');

    // Should see the service toggle (interactive form is shown)
    await expect(page.locator('#service-toggle')).toBeVisible({ timeout: 5000 });

    console.log('✅ UI transitioned to interactive form after subscription without funds');
  });

  test('Service is created in database even without funds', async ({ page }) => {
    // Subscribe without funds
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await page.waitForTimeout(2000);

    // Verify service was created by checking that interactive form is shown
    // (which only happens if service exists in database)
    await expect(page.locator('#service-toggle')).toBeVisible({ timeout: 5000 });
    await expect(getBanner(page)).toContainText('Subscription payment pending');

    console.log('✅ Service created in database with subscriptionChargePending=true');
  });

  test('Page refresh maintains interactive form state', async ({ page }) => {
    // Subscribe without funds
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await page.waitForTimeout(2000);

    // Should be showing interactive form with payment pending banner
    await expect(getBanner(page)).toContainText('Subscription payment pending', { timeout: 5000 });

    // Refresh page
    await page.reload();

    // Should still show interactive form with payment pending banner (not revert to onboarding)
    await expect(getBanner(page)).toContainText('Subscription payment pending', { timeout: 5000 });
    await expect(page.locator('h3:has-text("Guaranteed Bandwidth")')).not.toBeVisible();

    console.log('✅ Interactive form state persists across page refresh');
  });

  test('Cannot enable service without funds', async ({ page }) => {
    // Subscribe without funds
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await page.waitForTimeout(2000);

    // Should show interactive form
    await expect(page.locator('#service-toggle')).toBeVisible({ timeout: 5000 });

    // Service should be OFF
    const toggle = page.locator('#service-toggle');
    await expect(toggle).not.toBeChecked();

    // Try to enable service
    await toggle.click();

    // Should show error toast about needing to deposit funds
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Insufficient funds.*Deposit/i })).toBeVisible({ timeout: 5000 });

    // Service should remain OFF
    await expect(toggle).not.toBeChecked();

    console.log('✅ Cannot enable service without depositing funds');
  });

  test('Navigating away and back shows interactive form', async ({ page }) => {
    // Subscribe without funds
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await page.waitForTimeout(2000);

    // Navigate away to dashboard
    await page.click('text=Dashboard');
    await page.waitForURL('/dashboard', { timeout: 5000 });

    // Navigate back to seal service
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Should show interactive form with payment pending banner (not onboarding)
    await expect(getBanner(page)).toContainText('Subscription payment pending', { timeout: 5000 });
    await expect(page.locator('h3:has-text("Guaranteed Bandwidth")')).not.toBeVisible();

    console.log('✅ After navigating away and back, interactive form is shown');
  });
});
