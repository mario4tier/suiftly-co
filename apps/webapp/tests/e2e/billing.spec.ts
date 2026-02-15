/**
 * Billing Page E2E Test
 * Tests the billing page display and functionality
 */

import { test, expect } from '@playwright/test';
import { resetCustomer, addCryptoPayment } from '../helpers/db';
import { waitAfterMutation } from '../helpers/wait-utils';

const MOCK_WALLET_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const API_BASE = 'http://localhost:22700';

// Test suite for "no escrow payment method" scenario
test.describe('Billing Page - No Payment Methods', () => {
  test('shows add payment buttons when no methods configured', async ({ page }) => {
    await resetCustomer(page.request, {
      balanceUsdCents: 0,
      spendingLimitUsdCents: 0,
      clearEscrowAccount: true,
    });

    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForURL('/dashboard', { timeout: 10000 });

    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Should show heading
    await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible();

    // Escrow card should NOT be visible (no crypto payment method added)
    await expect(page.locator('h2:has-text("Suiftly Escrow Account")')).not.toBeVisible();

    // Should show add payment method buttons
    await expect(page.locator('[data-testid="add-crypto-payment"]')).toBeVisible();
    await expect(page.locator('[data-testid="add-credit-card"]')).toBeVisible();

    console.log('✅ No payment methods state displayed correctly');
  });

  test('adding crypto payment reveals escrow card with zero balance', async ({ page }) => {
    await resetCustomer(page.request, {
      balanceUsdCents: 0,
      spendingLimitUsdCents: 0,
      clearEscrowAccount: true,
    });

    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForURL('/dashboard', { timeout: 10000 });

    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Add crypto payment → escrow card appears
    await addCryptoPayment(page);

    // Should show Suiftly Escrow Account section with zero balance
    await expect(page.locator('h2:has-text("Suiftly Escrow Account")')).toBeVisible();
    await expect(page.getByText('Balance', { exact: true })).toBeVisible();
    await expect(page.locator('text=$0.00').first()).toBeVisible();

    // Should show default spending limit of $250
    await expect(page.locator('text=Spending Limit Protection')).toBeVisible();
    await expect(page.locator('text=$250.00')).toBeVisible();
    await expect(page.locator('text=per 28-days')).toBeVisible();

    // Should show action buttons
    await expect(page.locator('button:has-text("Deposit")')).toBeVisible();
    await expect(page.locator('button:has-text("Deposit")')).toBeEnabled();
    await expect(page.locator('button:has-text("Withdraw")')).toBeVisible();
    await expect(page.locator('button:has-text("Withdraw")')).toBeDisabled(); // Disabled when balance is 0
    await expect(page.locator('button:has-text("Adjust Spending Limit")')).toBeVisible();
    await expect(page.locator('button:has-text("Adjust Spending Limit")')).toBeEnabled();

    console.log('✅ Adding crypto payment reveals escrow card with zero balance');
  });
});

test.describe('Billing Page', () => {
  test.beforeEach(async ({ page }) => {
    await resetCustomer(page.request, {
      balanceUsdCents: 0,
      spendingLimitUsdCents: 0,
    });

    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
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

    // Add crypto payment to see escrow card
    await addCryptoPayment(page);

    // Should show Suiftly Escrow Account section
    await expect(page.locator('h2:has-text("Suiftly Escrow Account")')).toBeVisible();
    await expect(page.getByText('Balance', { exact: true })).toBeVisible();
    await expect(page.locator('text=$100.00').first()).toBeVisible();
    await expect(page.locator('text=Spending Limit Protection')).toBeVisible();
    await expect(page.locator('text=$250.00').first()).toBeVisible();
    await expect(page.locator('button:has-text("Deposit")')).toBeVisible();
    await expect(page.locator('button:has-text("Withdraw")')).toBeVisible();
    await expect(page.locator('button:has-text("Adjust Spending Limit")')).toBeVisible();

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

    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Billing History should be visible (no longer gated by escrow)
    await expect(page.locator('h2:has-text("Billing History")')).toBeVisible();

    // Should NOT show transactions yet (lazy loading)
    await expect(page.locator('text=Loading history...')).not.toBeVisible();
    await expect(page.locator('text=No billing history yet')).not.toBeVisible();

    // Click to expand billing history
    await page.locator('h2:has-text("Billing History")').click();

    await page.waitForTimeout(500);

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

    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Next Scheduled Payment should be visible (no longer gated by escrow)
    await expect(page.locator('text=/Next Scheduled (Payment|Refund)/')).toBeVisible();

    // Should NOT show details initially
    await expect(page.locator('text=No upcoming charges')).not.toBeVisible();

    // Click to expand
    await page.locator('text=/Next Scheduled (Payment|Refund)/').click();
    await expect(page.locator('text=No upcoming charges')).toBeVisible();

    // Click again to collapse
    await page.locator('text=/Next Scheduled (Payment|Refund)/').click();
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

    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Add crypto payment to see escrow card
    await addCryptoPayment(page);

    await expect(page.locator('text=$200.00').first()).toBeVisible();

    // Withdraw $50 via test API
    await page.request.post(`${API_BASE}/test/wallet/withdraw`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 50,
      },
    });

    await page.reload();
    await expect(page.locator('text=$150.00').first()).toBeVisible();

    console.log('✅ Balance updated correctly after withdrawal');
  });

  test('shows unlimited when spending limit is 0', async ({ page }) => {
    // Deposit with unlimited spending limit (0)
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 100,
        initialSpendingLimitUsd: 0,
      },
    });

    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Add crypto payment to see escrow card
    await addCryptoPayment(page);

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

    // Add crypto payment method (required for escrow payment to work)
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });
    await addCryptoPayment(page);

    // Subscribe to Seal Pro tier
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    await page.locator('label:has-text("Agree to")').click();
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    // Navigate to billing page and reload to ensure fresh draft invoice data
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Expand Next Scheduled Payment section (no longer gated by escrow)
    await page.locator('text=/Next Scheduled (Payment|Refund)/').click();
    await expect(page.locator('text=No upcoming charges')).not.toBeVisible();
    await expect(page.locator('text=Seal Pro tier')).toBeVisible();

    const creditLocator = page.locator('text=/Seal partial month credit/i');
    const creditVisible = await creditLocator.isVisible().catch(() => false);
    if (creditVisible) {
      console.log('  → Partial month credit is visible');
    } else {
      console.log('  → No partial month credit (expected if subscribed near month end)');
    }

    await expect(page.locator('text=/Total (Charge|Refund):/')).toBeVisible();

    console.log('✅ Next scheduled payment shows correct amount after subscription');
  });
});
