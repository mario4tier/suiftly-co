/**
 * Platform Subscription Without Funds E2E Test
 * Tests that platform subscription without sufficient funds still creates
 * the service in pending state and shows the correct UI transitions.
 */

import { test, expect } from '@playwright/test';
import { getBanner } from '../helpers/locators';

const API_BASE = 'http://localhost:22700';

test.describe('Platform Subscription Without Funds', () => {
  test.beforeEach(async ({ page, request }) => {
    // Reset customer: zero balance, no escrow account
    await request.post(`${API_BASE}/test/data/reset`, {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 25000,
        clearEscrowAccount: true,
      },
    });

    // Authenticate
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.waitForLoadState('networkidle');

    // Navigate to billing page (platform subscription form)
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });
  });

  test('billing page transitions after platform subscription without funds', async ({ page }) => {
    // Should start with "Choose a Platform Plan" card
    await expect(page.locator('h3:has-text("Choose a Platform Plan")')).toBeVisible();

    // Accept TOS and subscribe
    await page.locator('#platform-tos').click();
    const subscribeButton = page.locator('button:has-text("Subscribe to")');
    await expect(subscribeButton).toBeEnabled({ timeout: 5000 });
    await subscribeButton.click();
    await page.waitForTimeout(2000);

    // EXPECTED: Even without funds, the page should transition
    // (platform service created with pending payment)
    await expect(page.locator('h3:has-text("Choose a Platform Plan")')).not.toBeVisible({ timeout: 5000 });

    console.log('✅ Billing page transitioned after subscription without funds');
  });

  test('platform service is created in database even without funds', async ({ page }) => {
    // Subscribe without funds
    await page.locator('#platform-tos').click();
    await page.locator('button:has-text("Subscribe to")').click();
    await page.waitForTimeout(2000);

    // Check via API that platform service was created
    const customerData = await page.request.get(`${API_BASE}/test/data/customer`);
    const data = await customerData.json();

    // Platform subscription is set on customer (it's a billing concept, not infra state)
    expect(data.customer.platformTier).not.toBeNull();
    // Payment pending is tracked via pendingInvoiceId on customer
    expect(data.customer.pendingInvoiceId).not.toBeNull();

    console.log('✅ Platform service created in database with payment pending');
  });

  test('page refresh maintains subscription pending state', async ({ page }) => {
    // Subscribe without funds
    await page.locator('#platform-tos').click();
    await page.locator('button:has-text("Subscribe to")').click();
    await page.waitForTimeout(2000);

    // Plan card should be gone
    await expect(page.locator('h3:has-text("Choose a Platform Plan")')).not.toBeVisible({ timeout: 5000 });

    // Refresh page
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Should still show subscription management (not back to plan card)
    await expect(page.locator('h3:has-text("Choose a Platform Plan")')).not.toBeVisible({ timeout: 5000 });

    console.log('✅ Subscription pending state persists across page refresh');
  });
});
