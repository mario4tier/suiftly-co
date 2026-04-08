/**
 * Platform Subscription Pricing E2E Tests
 * Tests that platform subscription pricing is displayed correctly
 * and that subscribing with exact amounts works.
 *
 * Platform tiers: Starter ($1/mo) and Pro ($29/mo).
 */

import { test, expect } from '@playwright/test';
import { addCryptoPayment, resetCustomer, ensureTestBalance } from '../helpers/db';
import { getBanner } from '../helpers/locators';

const API_BASE = 'http://localhost:22700';

test.describe('Platform Subscription Pricing', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetCustomer(request);

    // Authenticate with mock wallet first
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');

    // Wait for redirect to /dashboard after auth
    await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.waitForLoadState('networkidle');
  });

  test('billing page shows platform plan card with correct tier prices', async ({ page }) => {
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Platform plan card should be visible
    await expect(page.locator('h3:has-text("Choose a Platform Plan")')).toBeVisible();

    // Should show both tier labels
    await expect(page.getByText('Starter', { exact: true })).toBeVisible();
    await expect(page.getByText('Pro', { exact: true }).first()).toBeVisible();

    // Should show correct prices
    await expect(page.getByText('$1/mo', { exact: true })).toBeVisible();
    await expect(page.getByText('$29/mo', { exact: true })).toBeVisible();

    console.log('✅ Platform plan card shows correct Starter ($1) and Pro ($29) prices');
  });

  test('platform starter subscription creates service even with insufficient balance', async ({ page }) => {
    // Reset with zero balance, no escrow account
    await page.request.post(`${API_BASE}/test/data/reset`, {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 25000,
        clearEscrowAccount: true,
      },
    });

    await page.reload();
    await page.waitForURL('/dashboard', { timeout: 5000 });

    // Navigate to billing
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Accept TOS
    await page.locator('#platform-tos').click();
    const subscribeButton = page.locator('button:has-text("Subscribe to")');
    await expect(subscribeButton).toBeEnabled({ timeout: 5000 });

    // Subscribe (no payment method, so payment will be pending)
    await subscribeButton.click();
    await page.waitForTimeout(2000);

    // Should transition away from the "Choose a Platform Plan" card
    await expect(page.locator('h3:has-text("Choose a Platform Plan")')).not.toBeVisible({ timeout: 5000 });

    console.log('✅ Platform Starter: Service created with payment pending');
  });

  test('platform pro subscription succeeds when balance is exactly $29', async ({ page }) => {
    // Reset and create escrow with exactly $29
    await page.request.post(`${API_BASE}/test/data/reset`, {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 25000,
        clearEscrowAccount: true,
      },
    });

    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        amountUsd: 29,
        initialSpendingLimitUsd: 250,
      },
    });

    await page.reload();
    await page.waitForURL('/dashboard', { timeout: 5000 });

    // Navigate to billing and add payment method
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });
    await addCryptoPayment(page);

    // Select Pro tier and subscribe
    await page.locator('text=Pro').first().click();
    await page.locator('#platform-tos').click();
    const subscribeButton = page.locator('button:has-text("Subscribe to")');
    await expect(subscribeButton).toBeEnabled({ timeout: 10000 });
    await subscribeButton.click();

    // Wait for actual state change: onboarding form gone
    await expect(page.locator('h3:has-text("Choose a Platform Plan")')).not.toBeVisible({ timeout: 10000 });

    console.log('✅ Platform Pro subscription succeeds with exactly $29 balance');
  });

  test('platform starter subscription succeeds when balance is exactly $1', async ({ page }) => {
    // Reset and create escrow with exactly $1
    await page.request.post(`${API_BASE}/test/data/reset`, {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 25000,
        clearEscrowAccount: true,
      },
    });

    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        amountUsd: 1,
        initialSpendingLimitUsd: 250,
      },
    });

    await page.reload();
    await page.waitForURL('/dashboard', { timeout: 5000 });

    // Navigate to billing and add payment method
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });
    await addCryptoPayment(page);

    // Starter is default, accept TOS and subscribe
    await page.locator('#platform-tos').click();
    const subscribeButton = page.locator('button:has-text("Subscribe to")');
    await expect(subscribeButton).toBeEnabled({ timeout: 10000 });
    await subscribeButton.click();

    // Wait for actual state change: onboarding form gone
    await expect(page.locator('h3:has-text("Choose a Platform Plan")')).not.toBeVisible({ timeout: 10000 });

    console.log('✅ Platform Starter subscription succeeds with exactly $1 balance');
  });
});
