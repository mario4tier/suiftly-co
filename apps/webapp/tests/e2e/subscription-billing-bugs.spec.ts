/**
 * Subscription Billing Bug Detection E2E Tests
 *
 * These tests detect specific bugs reported in production:
 * 1. Next Scheduled Payment shows wrong date (last day of month instead of 1st of next month)
 * 2. Missing reconciliation credit for unused days
 */

import { test, expect } from '@playwright/test';
import { resetCustomer } from '../helpers/db';

const MOCK_WALLET_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const API_BASE = 'http://localhost:3000';

test.describe('Subscription Billing - Bug Detection', () => {
  test('BUG 1: Next Scheduled Payment shows 1st of next month (not last day of current month)', async ({ page }) => {
    // Reset customer
    await resetCustomer(page.request, {
      balanceUsdCents: 0,
      spendingLimitUsdCents: 25000,
      clearEscrowAccount: true,
    });

    // Deposit funds
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 50,
        initialSpendingLimitUsd: 250,
      },
    });

    // Authenticate
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Subscribe to Seal Pro
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    // Navigate to billing page
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Expand Next Scheduled Payment
    await page.locator('text=Next Scheduled Payment').click();

    // BUG DETECTION: Check the entire card (not just date section)
    // The button contains both date and amount in separate divs
    const nextPaymentButton = page.locator('button:has-text("Next Scheduled Payment")');
    const fullText = await nextPaymentButton.textContent();

    console.log('Next Scheduled Payment text:', fullText);

    // Should show next month's 1st day (not current month's last day)
    // Calculate expected next billing date dynamically
    const now = new Date();
    const nextBillingDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const expectedMonth = nextBillingDate.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC'
    });

    console.log('Expected next billing date:', expectedMonth);
    await expect(nextPaymentButton).toContainText(expectedMonth.split(' ')[0]); // Month name
    await expect(nextPaymentButton).toContainText('1'); // Day 1

    // Should show NET charge (not $0.00) - actual amount varies by date
    // Don't check specific amounts without DBClock
    await expect(nextPaymentButton).not.toContainText('$0.00');

    // Expanded section should show line items with service name (no colons)
    await expect(page.locator('text=Seal Pro tier')).toBeVisible();
    // Credit includes month name in format: "Seal partial month credit (November)"
    await expect(page.locator('text=/Seal partial month credit \\(/i')).toBeVisible();
    await expect(page.locator('text=Total Charge')).toBeVisible();

    // Verify line items exist in expanded section (amounts vary by date)
    const expandedSection = page.locator('text=Seal Pro tier').locator('../..');
    await expect(expandedSection).toContainText('$29.00'); // Seal Pro subscription (fixed price)
    await expect(expandedSection).toContainText('Total Charge'); // Total label exists
  });

  test('BUG 2: Reconciliation credit created for unused days in partial month', async ({ page }) => {
    // Reset customer
    await resetCustomer(page.request, {
      balanceUsdCents: 0,
      spendingLimitUsdCents: 25000,
      clearEscrowAccount: true,
    });

    // Deposit funds
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 50,
        initialSpendingLimitUsd: 250,
      },
    });

    // Authenticate
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Subscribe to Seal Pro
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    // Check database for reconciliation credit via API
    const response = await page.request.get(`${API_BASE}/test/data/customer`);
    const data = await response.json();

    console.log('Customer data:', JSON.stringify(data, null, 2));

    // Verify reconciliation credit exists in database
    // Subscribing mid-month (November 24) should create credit for unused days
    // Expected: $29 * (days_not_used / 30) where days_not_used = Nov 1-23 = 23 days
    // Credit should be approximately $22.23

    // This test will FAIL if credit not created, exposing the bug
    expect(data.credits).toBeDefined();
    expect(data.credits.length).toBeGreaterThan(0);

    const reconCredit = data.credits?.find((c: any) => c.reason === 'reconciliation');
    expect(reconCredit).toBeDefined();
    expect(reconCredit.originalAmountUsdCents).toBeGreaterThan(2000); // At least $20
    expect(reconCredit.originalAmountUsdCents).toBeLessThan(2400); // At most $24
  });
});
