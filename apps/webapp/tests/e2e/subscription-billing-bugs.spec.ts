/**
 * Subscription Billing Bug Detection E2E Tests
 *
 * These tests detect specific bugs reported in production:
 * 1. Next Scheduled Payment shows wrong date (last day of month instead of 1st of next month)
 * 2. Missing reconciliation credit for unused days
 *
 * Tests use DBClock to ensure deterministic credit calculations regardless of system date.
 */

import { test, expect } from '@playwright/test';
import { resetCustomer } from '../helpers/db';
import { setMockClock, resetClock } from '../helpers/clock';

const MOCK_WALLET_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const API_BASE = 'http://localhost:22700';

test.describe('Subscription Billing - Bug Detection', () => {
  test('BUG 1: Next Scheduled Payment shows 1st of next month (not last day of current month)', async ({ page }) => {
    // Freeze time to November 15, 2025 for deterministic credit calculation
    // Mid-month ensures a meaningful partial month credit will be created
    await setMockClock(page.request, '2025-11-15T12:00:00Z');

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
    await page.click('button:has-text("Mock Wallet 0")');
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

    // Expand Next Scheduled Payment/Refund
    // Use text selector for regex pattern
    await page.locator('text=/Next Scheduled (Payment|Refund)/').click();

    // BUG DETECTION: Check the entire card (not just date section)
    // The button contains both date and amount in separate divs
    // Use filter instead of has-text with regex for better compatibility
    const nextPaymentButton = page.locator('button').filter({ hasText: /Next Scheduled (Payment|Refund)/ });
    const fullText = await nextPaymentButton.textContent();

    console.log('Next Scheduled Payment/Refund text:', fullText);

    // Should show next month's 1st day (not current month's last day)
    // With DBClock set to Nov 15, 2025, next billing date is December 1, 2025
    console.log('Expected next billing date: December 1');
    await expect(nextPaymentButton).toContainText('December'); // Month name
    await expect(nextPaymentButton).toContainText('1'); // Day 1

    // Should show NET charge (not $0.00) - actual amount varies by date
    // Don't check specific amounts without DBClock
    await expect(nextPaymentButton).not.toContainText('$0.00');

    // Expanded section should show line items with service name (no colons)
    await expect(page.locator('text=Seal Pro tier')).toBeVisible();
    // Credit includes service name and month in format: "Seal partial month credit (November)"
    await expect(page.locator('text=/Seal partial month credit \\(/i')).toBeVisible();
    await expect(page.locator('text=/Total (Charge|Refund)/')).toBeVisible();

    // Verify line items exist in expanded section (amounts vary by date)
    const expandedSection = page.locator('text=Seal Pro tier').locator('../..');
    await expect(expandedSection).toContainText('$29.00'); // Seal Pro subscription (fixed price)
    await expect(expandedSection).toContainText(/Total (Charge|Refund)/); // Total label exists
  });

  test('BUG 2: Reconciliation credit created for unused days in partial month', async ({ page }) => {
    // Freeze time to November 24, 2025 for deterministic credit calculation
    await setMockClock(page.request, '2025-11-24T12:00:00Z');

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
    await page.click('button:has-text("Mock Wallet 0")');
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
    // Subscribing on November 24 should create credit for unused days
    // Days used: Nov 24-30 = 7 days
    // Days NOT used: Nov 1-23 = 23 days
    // Expected credit: $29 * (23/30) = $22.23 (2223 cents)

    // This test will FAIL if credit not created, exposing the bug
    expect(data.credits).toBeDefined();
    expect(data.credits.length).toBeGreaterThan(0);

    const reconCredit = data.credits?.find((c: any) => c.reason === 'reconciliation');
    expect(reconCredit).toBeDefined();

    const expectedCredit = Math.floor((2900 * 23) / 30);
    expect(reconCredit.originalAmountUsdCents).toBe(expectedCredit); // Exact match now

    console.log(`✅ Nov 24: Credit = $${reconCredit.originalAmountUsdCents / 100} (expected $${expectedCredit / 100})`);

    // Reset clock for subsequent tests
    await resetClock(page.request);
  });
});

/**
 * Month Boundary Edge Cases
 * Tests credit calculation on various month boundaries
 */
test.describe('Month Boundary Edge Cases', () => {
  test('last second of month (Nov 30, 23:59:59) - should credit 29 days', async ({ page }) => {
    // Freeze to last second of November
    await setMockClock(page.request, '2025-11-30T23:59:59Z');

    await resetCustomer(page.request, {
      balanceUsdCents: 5000,
      spendingLimitUsdCents: 25000,
      clearEscrowAccount: true,
    });

    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 50,
        initialSpendingLimitUsd: 250,
      },
    });

    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForURL('/dashboard', { timeout: 10000 });

    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    const response = await page.request.get(`${API_BASE}/test/data/customer`);
    const data = await response.json();

    const reconCredit = data.credits?.find((c: any) => c.reason === 'reconciliation');
    expect(reconCredit).toBeDefined();

    // November has 30 days
    // Days used: Nov 30 only = 1 day
    // Days NOT used: Nov 1-29 = 29 days
    // Credit: $29 * (29/30) = $28.03 (2803 cents)
    const expectedCredit = Math.floor((2900 * 29) / 30);
    expect(reconCredit.originalAmountUsdCents).toBe(expectedCredit);

    console.log(`✅ Last second of Nov 30: Credit = $${reconCredit.originalAmountUsdCents / 100} (expected $${expectedCredit / 100})`);

    await resetClock(page.request);
  });

  test('first second of month (Dec 1, 00:00:01) - no credit (full month)', async ({ page }) => {
    // Freeze to first second of December
    await setMockClock(page.request, '2025-12-01T00:00:01Z');

    await resetCustomer(page.request, {
      balanceUsdCents: 5000,
      spendingLimitUsdCents: 25000,
      clearEscrowAccount: true,
    });

    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 50,
        initialSpendingLimitUsd: 250,
      },
    });

    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForURL('/dashboard', { timeout: 10000 });

    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    const response = await page.request.get(`${API_BASE}/test/data/customer`);
    const data = await response.json();

    // December has 31 days
    // Days used: Dec 1-31 = 31 days
    // Days NOT used: 0 days
    // Credit: $29 * (0/31) = $0.00
    // Since credit is 0, NO credit record should be created
    const reconCredit = data.credits?.find((c: any) => c.reason === 'reconciliation');
    expect(reconCredit).toBeUndefined(); // No credit for full month subscription

    console.log(`✅ First second of Dec 1: No credit issued (full month)`);

    await resetClock(page.request);
  });

  test('February 28 non-leap year (Feb 28, 2025) - 27 days credit', async ({ page }) => {
    // Freeze to Feb 28, 2025 (non-leap year)
    await setMockClock(page.request, '2025-02-28T12:00:00Z');

    await resetCustomer(page.request, {
      balanceUsdCents: 5000,
      spendingLimitUsdCents: 25000,
      clearEscrowAccount: true,
    });

    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 50,
        initialSpendingLimitUsd: 250,
      },
    });

    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForURL('/dashboard', { timeout: 10000 });

    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    const response = await page.request.get(`${API_BASE}/test/data/customer`);
    const data = await response.json();

    const reconCredit = data.credits?.find((c: any) => c.reason === 'reconciliation');
    expect(reconCredit).toBeDefined();

    // February 2025 has 28 days (non-leap year)
    // Days used: Feb 28 only = 1 day
    // Days NOT used: Feb 1-27 = 27 days
    // Credit: $29 * (27/28) = $27.96 (2796 cents)
    const expectedCredit = Math.floor((2900 * 27) / 28);
    expect(reconCredit.originalAmountUsdCents).toBe(expectedCredit);

    console.log(`✅ Feb 28 (non-leap): Credit = $${reconCredit.originalAmountUsdCents / 100} (expected $${expectedCredit / 100})`);

    await resetClock(page.request);
  });

  test('February 29 leap year (Feb 29, 2024) - 28 days credit', async ({ page }) => {
    // Freeze to Feb 29, 2024 (leap year)
    await setMockClock(page.request, '2024-02-29T12:00:00Z');

    await resetCustomer(page.request, {
      balanceUsdCents: 5000,
      spendingLimitUsdCents: 25000,
      clearEscrowAccount: true,
    });

    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 50,
        initialSpendingLimitUsd: 250,
      },
    });

    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForURL('/dashboard', { timeout: 10000 });

    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    const response = await page.request.get(`${API_BASE}/test/data/customer`);
    const data = await response.json();

    const reconCredit = data.credits?.find((c: any) => c.reason === 'reconciliation');
    expect(reconCredit).toBeDefined();

    // February 2024 has 29 days (leap year)
    // Days used: Feb 29 only = 1 day
    // Days NOT used: Feb 1-28 = 28 days
    // Credit: $29 * (28/29) = $28.00 (2800 cents)
    const expectedCredit = Math.floor((2900 * 28) / 29);
    expect(reconCredit.originalAmountUsdCents).toBe(expectedCredit);

    console.log(`✅ Feb 29 (leap year): Credit = $${reconCredit.originalAmountUsdCents / 100} (expected $${expectedCredit / 100})`);

    await resetClock(page.request);
  });

  test('January 1st first moment (Jan 1, 00:00:01) - no credit (full month)', async ({ page }) => {
    // Freeze to first second of January
    await setMockClock(page.request, '2025-01-01T00:00:01Z');

    await resetCustomer(page.request, {
      balanceUsdCents: 5000,
      spendingLimitUsdCents: 25000,
      clearEscrowAccount: true,
    });

    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 50,
        initialSpendingLimitUsd: 250,
      },
    });

    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForURL('/dashboard', { timeout: 10000 });

    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    const response = await page.request.get(`${API_BASE}/test/data/customer`);
    const data = await response.json();

    // January has 31 days
    // Days used: Jan 1-31 = 31 days
    // Days NOT used: 0 days
    // Credit: $29 * (0/31) = $0.00
    // Since credit is 0, NO credit record should be created
    const reconCredit = data.credits?.find((c: any) => c.reason === 'reconciliation');
    expect(reconCredit).toBeUndefined(); // No credit for full month subscription

    console.log(`✅ Jan 1 first second: No credit issued (subscribing on first day uses full month)`);

    await resetClock(page.request);
  });

  test('December 31st last moment (Dec 31, 23:59:59) - 30 days credit', async ({ page }) => {
    // Freeze to last second of December
    await setMockClock(page.request, '2025-12-31T23:59:59Z');

    await resetCustomer(page.request, {
      balanceUsdCents: 5000,
      spendingLimitUsdCents: 25000,
      clearEscrowAccount: true,
    });

    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 50,
        initialSpendingLimitUsd: 250,
      },
    });

    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForURL('/dashboard', { timeout: 10000 });

    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    const response = await page.request.get(`${API_BASE}/test/data/customer`);
    const data = await response.json();

    const reconCredit = data.credits?.find((c: any) => c.reason === 'reconciliation');
    expect(reconCredit).toBeDefined();

    // December has 31 days
    // Days used: Dec 31 only = 1 day
    // Days NOT used: Dec 1-30 = 30 days
    // Credit: $29 * (30/31) = $28.06 (2806 cents)
    const expectedCredit = Math.floor((2900 * 30) / 31);
    expect(reconCredit.originalAmountUsdCents).toBe(expectedCredit);

    console.log(`✅ Dec 31 last second: Credit = $${reconCredit.originalAmountUsdCents / 100} (expected $${expectedCredit / 100})`);

    await resetClock(page.request);
  });
});

/**
 * Scheduled Change Date Display Tests
 * Ensures dates are displayed correctly without timezone shift
 * BUG: Date stored as "2025-12-01" was showing as "November 30, 2025" due to local timezone conversion
 */
test.describe('Scheduled Change Date Display', () => {
  test('scheduled downgrade shows correct date (not off by one day)', async ({ page }) => {
    // Set clock to Nov 15, 2025 - mid-month for a clear scheduled downgrade scenario
    await setMockClock(page.request, '2025-11-15T12:00:00Z');

    await resetCustomer(page.request, {
      balanceUsdCents: 20000, // $200 to cover enterprise
      spendingLimitUsdCents: 25000,
      clearEscrowAccount: true,
    });

    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 200,
        initialSpendingLimitUsd: 250,
      },
    });

    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Subscribe to Enterprise tier first
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Select Enterprise tier and subscribe
    await page.getByRole('heading', { name: 'ENTERPRISE' }).click();
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    // Navigate to overview to schedule downgrade
    await page.click('text=Overview');
    await page.waitForURL(/\/services\/seal\/overview/, { timeout: 5000 });

    // Click Change Plan to open modal
    await page.locator('button:has-text("Change Plan")').click();
    await expect(page.getByLabel('Change Plan')).toBeVisible({ timeout: 5000 });

    // Select Starter tier (downgrade) - click the tier heading in the modal
    await page.locator('h4:has-text("STARTER")').click();

    // Confirm downgrade
    await page.locator('button:has-text("Schedule Downgrade")').click();

    // Wait for modal to close and page to update
    await expect(page.getByLabel('Change Plan')).not.toBeVisible({ timeout: 5000 });

    // Check the banner on overview page shows correct date: December 1, 2025
    // The downgrade takes effect on the 1st of next month
    const downgradeBanner = page.locator('[data-testid="downgrade-scheduled-banner"]');
    await expect(downgradeBanner).toBeVisible({ timeout: 5000 });

    // CRITICAL: Must show "December 1, 2025" NOT "November 30, 2025"
    await expect(downgradeBanner).toContainText('December 1, 2025');
    await expect(downgradeBanner).toContainText('Starter');

    // Also verify the modal shows the same correct date
    await page.locator('button:has-text("Change Plan")').click();

    // Wait for modal to open and check the downgrade banner inside the modal dialog
    const modalDialog = page.getByLabel('Change Plan');
    await expect(modalDialog.locator('text=Downgrade Scheduled')).toBeVisible({ timeout: 5000 });

    // Modal should also show December 1, 2025
    await expect(modalDialog).toContainText('December 1, 2025');

    await resetClock(page.request);
  });

  test('scheduled cancellation shows correct date (not off by one day)', async ({ page }) => {
    // Set clock to Nov 15, 2025
    await setMockClock(page.request, '2025-11-15T12:00:00Z');

    await resetCustomer(page.request, {
      balanceUsdCents: 5000,
      spendingLimitUsdCents: 25000,
      clearEscrowAccount: true,
    });

    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 50,
        initialSpendingLimitUsd: 250,
      },
    });

    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Subscribe to Pro tier
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    // Navigate to overview to schedule cancellation
    await page.click('text=Overview');
    await page.waitForURL(/\/services\/seal\/overview/, { timeout: 5000 });

    // Click Change Plan to open modal
    await page.locator('button:has-text("Change Plan")').click();
    await expect(page.getByLabel('Change Plan')).toBeVisible({ timeout: 5000 });

    // Click Cancel Subscription
    await page.locator('button:has-text("Cancel Subscription")').click();

    // Confirm cancellation
    await page.locator('button:has-text("Cancel Subscription")').last().click();

    // Wait for modal to close
    await expect(page.getByLabel('Change Plan')).not.toBeVisible({ timeout: 5000 });

    // Check the banner on overview page shows correct date: November 30, 2025
    // Cancellation takes effect at end of current billing period (last day of month)
    const cancellationBanner = page.locator('[data-testid="cancellation-scheduled-banner"]');
    await expect(cancellationBanner).toBeVisible({ timeout: 5000 });

    // CRITICAL: Must show "November 30, 2025" NOT "November 29, 2025"
    await expect(cancellationBanner).toContainText('November 30, 2025');

    // Also verify the modal shows the same correct date
    await page.locator('button:has-text("Change Plan")').click();

    // Wait for modal to open and check the cancellation banner inside the modal dialog
    const modalDialog = page.getByLabel('Change Plan');
    await expect(modalDialog.locator('text=Cancellation Scheduled')).toBeVisible({ timeout: 5000 });

    // Modal should also show November 30, 2025
    await expect(modalDialog).toContainText('November 30, 2025');

    await resetClock(page.request);
  });
});
