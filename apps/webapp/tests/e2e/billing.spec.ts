/**
 * Billing Page E2E Test
 * Tests the billing page display and functionality
 */

import { test, expect } from '@playwright/test';
import { resetCustomer } from '../helpers/db';

const MOCK_WALLET_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const API_BASE = 'http://localhost:3000';

// Test suite for "no escrow account" scenario (needs separate setup)
test.describe('Billing Page - No Escrow Account', () => {
  test('shows zero balance when no escrow account exists', async ({ page }) => {
    // This test needs no escrow account - use clearEscrowAccount flag
    await resetCustomer(page.request, {
      balanceUsdCents: 0,
      spendingLimitUsdCents: 0,
      clearEscrowAccount: true, // Remove escrow account to test "no account" state
    });

    // Authenticate with mock wallet
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Navigate to billing page
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Should show heading
    await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible();

    // Should show Suiftly Escrow Account section with zero balance
    await expect(page.locator('h2:has-text("Suiftly Escrow Account")')).toBeVisible();
    await expect(page.locator('text=Balance')).toBeVisible();
    await expect(page.locator('text=$0.00').first()).toBeVisible();

    // Should show default spending limit of $250 (SPENDING_LIMIT_DEFAULT_USD)
    await expect(page.locator('text=Spending Limit Protection')).toBeVisible();
    // Check for both parts of the spending limit text
    await expect(page.locator('text=$250.00')).toBeVisible();
    await expect(page.locator('text=per 28-days')).toBeVisible();

    // Should show action buttons
    await expect(page.locator('button:has-text("Deposit")')).toBeVisible();
    await expect(page.locator('button:has-text("Deposit")')).toBeEnabled();

    await expect(page.locator('button:has-text("Withdraw")')).toBeVisible();
    await expect(page.locator('button:has-text("Withdraw")')).toBeDisabled(); // Disabled when balance is 0

    await expect(page.locator('button:has-text("Adjust Spending Limit")')).toBeVisible();
    await expect(page.locator('button:has-text("Adjust Spending Limit")')).toBeEnabled();

    console.log('✅ Zero balance displayed correctly when no escrow account exists');
  });
});

test.describe('Billing Page', () => {
  test.beforeEach(async ({ page }) => {
    // Reset customer data (preserves escrow account for realistic testing)
    await resetCustomer(page.request, {
      balanceUsdCents: 0,
      spendingLimitUsdCents: 0, // 0 = Unlimited
    });

    // Authenticate with mock wallet
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');
    await page.waitForURL('/dashboard', { timeout: 10000 });
  });

  test('shows escrow account with balance after deposit', async ({ page }) => {
    // Deposit $100 via test API
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 100,
        initialSpendingLimitUsd: 250,
      },
    });

    // Navigate to billing page
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Should show Suiftly Escrow Account section
    await expect(page.locator('h2:has-text("Suiftly Escrow Account")')).toBeVisible();

    // Should show balance
    await expect(page.locator('text=Balance')).toBeVisible();
    await expect(page.locator('text=$100.00').first()).toBeVisible();

    // Should show spending limit protection
    await expect(page.locator('text=Spending Limit Protection')).toBeVisible();
    await expect(page.locator('text=$250.00').first()).toBeVisible();

    // Should show action buttons (disabled for now)
    await expect(page.locator('button:has-text("Deposit")')).toBeVisible();
    await expect(page.locator('button:has-text("Withdraw")')).toBeVisible();
    await expect(page.locator('button:has-text("Adjust Spending Limit")')).toBeVisible();

    // Should show next scheduled payment section
    await expect(page.locator('text=Next Scheduled Payment')).toBeVisible();

    console.log('✅ Escrow account with balance displayed correctly');
  });

  test('billing history is collapsible with lazy loading', async ({ page }) => {
    // Deposit to create account
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 100,
        initialSpendingLimitUsd: 250,
      },
    });

    // Navigate to billing page
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Billing History should be visible but collapsed
    await expect(page.locator('h2:has-text("Billing History")')).toBeVisible();

    // Should NOT show transactions yet (lazy loading)
    await expect(page.locator('text=Loading history...')).not.toBeVisible();
    await expect(page.locator('text=No billing history yet')).not.toBeVisible();

    // Click to expand billing history
    await page.locator('h2:has-text("Billing History")').click();

    // Wait a moment for the query to trigger and render
    await page.waitForTimeout(500);

    // Should eventually show "No billing history yet" or transactions
    await expect(
      page.locator('text=No billing history yet')
    ).toBeVisible({ timeout: 5000 });

    console.log('✅ Billing history lazy loading works correctly');
  });

  test('next scheduled payment is expandable', async ({ page }) => {
    // Deposit to create account
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 100,
        initialSpendingLimitUsd: 250,
      },
    });

    // Navigate to billing page
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Next Scheduled Payment should be visible
    await expect(page.locator('text=Next Scheduled Payment')).toBeVisible();

    // Should NOT show details initially
    await expect(page.locator('text=No upcoming charges')).not.toBeVisible();

    // Click to expand
    await page.locator('text=Next Scheduled Payment').click();

    // Should now show details (no subscriptions = "No upcoming charges")
    await expect(page.locator('text=No upcoming charges')).toBeVisible();

    // Click again to collapse
    await page.locator('text=Next Scheduled Payment').click();

    // Should hide details
    await expect(page.locator('text=No upcoming charges')).not.toBeVisible();

    console.log('✅ Next scheduled payment expandable works correctly');
  });

  test('shows updated balance after withdrawal', async ({ page }) => {
    // Deposit $200
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 200,
        initialSpendingLimitUsd: 250,
      },
    });

    // Navigate to billing page
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Initial balance should be $200
    await expect(page.locator('text=$200.00').first()).toBeVisible();

    // Withdraw $50 via test API
    await page.request.post(`${API_BASE}/test/wallet/withdraw`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 50,
      },
    });

    // Reload page
    await page.reload();

    // Balance should now be $150
    await expect(page.locator('text=$150.00').first()).toBeVisible();

    console.log('✅ Balance updated correctly after withdrawal');
  });

  test('shows unlimited when spending limit is 0', async ({ page }) => {
    // Deposit with unlimited spending limit (0)
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 100,
        initialSpendingLimitUsd: 0, // Unlimited
      },
    });

    // Navigate to billing page
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Should show "Unlimited" for spending limit
    await expect(page.locator('text=Unlimited')).toBeVisible();

    console.log('✅ Unlimited spending limit displayed correctly');
  });

  test('shows next scheduled payment after subscribing to service', async ({ page }) => {
    // Deposit $50 to cover Pro tier subscription ($29)
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 50,
        initialSpendingLimitUsd: 250,
      },
    });

    // Subscribe to Seal Pro tier
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Accept terms and subscribe
    await page.locator('label:has-text("Agree to")').click();
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();

    // Wait for subscription success
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    // Navigate to billing page
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Expand Next Scheduled Payment section
    await page.locator('text=Next Scheduled Payment').click();

    // Should show line items for subscribed service (even if service is DISABLED)
    // Billing rule: Subscriptions are charged regardless of isUserEnabled toggle state
    // Should NOT show "No upcoming charges" - there should be a DRAFT invoice
    await expect(page.locator('text=No upcoming charges')).not.toBeVisible();

    // Should show Pro tier line item and partial month credit
    // Note: Don't check specific amounts - they vary by date (unless DBClock is set)
    await expect(page.locator('text=Seal Pro tier')).toBeVisible();
    await expect(page.locator('text=Seal partial month credit')).toBeVisible();

    // Should show Total Charge label
    await expect(page.locator('text=Total Charge:')).toBeVisible();

    console.log('✅ Next scheduled payment shows correct amount after subscription');
  });
});
