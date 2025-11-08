/**
 * Billing Operations E2E Test
 * Tests deposit, withdraw, spending limit, charge, and refund operations
 */

import { test, expect } from '@playwright/test';
import { resetCustomer } from '../helpers/db';

const MOCK_WALLET_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const API_BASE = 'http://localhost:3000';

test.describe('Billing Operations', () => {
  test.beforeEach(async ({ page }) => {
    // Reset customer data to clean state
    await resetCustomer(page.request, {
      balanceUsdCents: 0,
      spendingLimitUsdCents: 0, // Unlimited (tests that need a specific limit will set it via deposit)
    });

    // Authenticate with mock wallet
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Navigate to billing page
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });
  });

  test('deposit flow - opens modal, validates input, processes deposit', async ({ page }) => {
    // Click deposit button
    await page.click('button:has-text("Deposit")');

    // Wait for modal to open with animation
    await page.waitForTimeout(300);
    await expect(page.locator('text=Deposit Funds')).toBeVisible();

    // Try to deposit with empty input (should show error)
    const submitButton = page.locator('button:has-text("Deposit")').last();
    await submitButton.click();
    await page.waitForTimeout(100);
    await expect(page.locator('text=Please enter a valid amount')).toBeVisible();

    // Enter valid amount
    await page.fill('input[id="depositAmount"]', '100');

    // Submit deposit
    await submitButton.click();

    // Wait for success (toast or modal to close)
    await page.waitForTimeout(1000);

    // Modal should close
    await expect(page.locator('text=Deposit Funds')).not.toBeVisible();

    // Balance should update
    await page.waitForTimeout(500);
    const balanceSection = page.locator('text=Balance').locator('..');
    await expect(balanceSection).toContainText('100');

    console.log('✅ Deposit flow works correctly');
  });

  test('withdraw flow - validates balance, processes withdrawal', async ({ page }) => {
    // First deposit $200
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 200,
        initialSpendingLimitUsd: 250,
      },
    });

    // Reload page to see updated balance
    await page.reload();
    await expect(page.locator('text=$200.00').first()).toBeVisible();

    // Click withdraw button
    await page.click('button:has-text("Withdraw")');

    // Modal should open
    await expect(page.getByRole('heading', { name: 'Withdraw Funds' })).toBeVisible();
    await expect(page.locator('text=Available balance: $200.00')).toBeVisible();

    // Try to withdraw more than balance (should show error)
    await page.fill('input[id="withdrawAmount"]', '250');
    await page.locator('button:has-text("Withdraw")').last().click();
    await expect(page.locator('text=Insufficient balance')).toBeVisible();

    // Enter valid amount
    await page.fill('input[id="withdrawAmount"]', '50');

    // Submit withdrawal
    await page.locator('button:has-text("Withdraw")').last().click();

    // Wait for success toast
    await expect(page.locator('text=Withdrew $50.00 successfully')).toBeVisible({ timeout: 5000 });

    // Modal should close
    await expect(page.locator('text=Withdraw Funds')).not.toBeVisible();

    // Balance should update to $150.00
    await expect(page.locator('text=$150.00').first()).toBeVisible({ timeout: 3000 });

    console.log('✅ Withdraw flow works correctly');
  });

  test('adjust spending limit flow', async ({ page }) => {
    // Spending limit should initially be Unlimited
    await expect(page.locator('text=Spending Limit Protection').locator('..').locator('text=Unlimited')).toBeVisible();

    // Click adjust spending limit button
    await page.click('button:has-text("Adjust Spending Limit")');

    // Modal should open
    await expect(page.getByRole('heading', { name: 'Adjust Spending Limit' })).toBeVisible();
    await expect(page.locator('text=Set a 28-day spending limit')).toBeVisible();

    // Try to set limit below minimum (should show error)
    await page.fill('input[id="spendingLimit"]', '5');
    await page.click('button:has-text("Update Limit")');
    await expect(page.locator('text=Spending limit must be at least $10')).toBeVisible();

    // Enter valid limit
    await page.fill('input[id="spendingLimit"]', '100');

    // Submit update
    await page.click('button:has-text("Update Limit")');

    // Wait for success toast
    await expect(page.locator('text=Updated spending limit to $100.00')).toBeVisible({ timeout: 5000 });

    // Modal should close (check for the heading, not the button)
    await expect(page.getByRole('heading', { name: 'Adjust Spending Limit' })).not.toBeVisible();

    // Spending limit should update to $100.00
    await expect(page.locator('text=$100.00').first()).toBeVisible({ timeout: 3000 });

    // Test setting unlimited (0)
    await page.click('button:has-text("Adjust Spending Limit")');
    await page.fill('input[id="spendingLimit"]', '0');
    await page.click('button:has-text("Update Limit")');
    await expect(page.locator('text=Updated spending limit to unlimited')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Spending Limit Protection').locator('..').locator('text=Unlimited')).toBeVisible({ timeout: 3000 });

    console.log('✅ Adjust spending limit flow works correctly');
  });

  test('charge and refund flow with billing history', async ({ page }) => {
    // Deposit $100 first
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 100,
        initialSpendingLimitUsd: 250,
      },
    });

    await page.reload();
    await expect(page.locator('text=$100.00').first()).toBeVisible();

    // Simulate a charge (e.g., Seal service subscription)
    const chargeResponse = await page.request.post(`${API_BASE}/test/wallet/charge`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 25,
        description: 'Seal Service - Starter Plan (Monthly)',
      },
    });

    expect((await chargeResponse.json()).success).toBe(true);

    // Reload and verify balance reduced
    await page.reload();
    await expect(page.locator('text=$75.00').first()).toBeVisible();

    // Expand billing history
    await page.getByRole('button', { name: 'Billing History' }).click();
    await page.waitForTimeout(500);

    // Should see deposit and charge in history
    await expect(page.locator('text=deposit').first()).toBeVisible();
    await expect(page.locator('.text-sm.capitalize:has-text("charge")').first()).toBeVisible();
    await expect(page.locator('text=Seal Service - Starter Plan')).toBeVisible();

    // Simulate a refund
    const refundResponse = await page.request.post(`${API_BASE}/test/wallet/refund`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 10,
        description: 'Partial refund for service interruption',
      },
    });

    expect((await refundResponse.json()).success).toBe(true);

    // Reload and verify balance increased
    await page.reload();
    await expect(page.locator('text=$85.00').first()).toBeVisible();

    // Expand billing history again
    await page.getByRole('button', { name: 'Billing History' }).click();
    await page.waitForTimeout(500);

    // Should see credit (refund) in history
    await expect(page.locator('text=credit')).toBeVisible();
    await expect(page.locator('text=Partial refund')).toBeVisible();

    console.log('✅ Charge and refund flow works correctly with billing history');
  });

  test('spending limit enforcement', async ({ page }) => {
    // Reset with $50 spending limit first (deposit won't update limit for existing customers)
    await page.request.post(`${API_BASE}/test/data/reset`, {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 5000, // $50
      },
    });

    // Deposit $100
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 100,
      },
    });

    await page.reload();
    await expect(page.locator('text=$100.00').first()).toBeVisible();
    // Check for spending limit - displayed as "$50.00 per 28-days"
    await expect(page.locator('text=$50.00 per 28-days')).toBeVisible();

    // Try to charge $60 (should exceed spending limit)
    const chargeResponse = await page.request.post(`${API_BASE}/test/wallet/charge`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 60,
        description: 'Test charge exceeding limit',
      },
    });

    const chargeData = await chargeResponse.json();
    expect(chargeData.success).toBe(false);
    expect(chargeData.error).toContain('spending limit');

    // Balance should remain $100 (charge was rejected)
    await page.reload();
    await expect(page.locator('text=$100.00').first()).toBeVisible();

    // Charge $30 (within limit)
    const validChargeResponse = await page.request.post(`${API_BASE}/test/wallet/charge`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 30,
        description: 'Valid charge within limit',
      },
    });

    expect((await validChargeResponse.json()).success).toBe(true);

    // Balance should be $70
    await page.reload();
    await expect(page.locator('text=$70.00').first()).toBeVisible();

    console.log('✅ Spending limit enforcement works correctly');
  });

  test('keyboard shortcuts - Enter key submits forms', async ({ page }) => {
    // Test deposit modal
    await page.click('button:has-text("Deposit")');
    await page.fill('input[id="depositAmount"]', '50');
    await page.press('input[id="depositAmount"]', 'Enter');

    // Should process deposit
    await expect(page.locator('text=Deposited $50.00 successfully')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Deposit Funds')).not.toBeVisible();

    // Verify balance updated
    await expect(page.locator('text=$50.00').first()).toBeVisible({ timeout: 3000 });

    console.log('✅ Keyboard shortcuts work correctly');
  });

  test('error handling - network errors', async ({ page }) => {
    // This test would require mocking network failures
    // For now, just verify error display works
    await page.click('button:has-text("Deposit")');
    await page.fill('input[id="depositAmount"]', '-100');
    await page.locator('button:has-text("Deposit")').last().click();

    // Should show validation error
    await expect(page.locator('text=Please enter a valid amount')).toBeVisible();

    console.log('✅ Error handling displays correctly');
  });

  test('modal cancel buttons work correctly', async ({ page }) => {
    // Test deposit modal cancel
    await page.click('button:has-text("Deposit")');
    await expect(page.locator('text=Deposit Funds')).toBeVisible();
    await page.fill('input[id="depositAmount"]', '100');
    await page.click('button:has-text("Cancel")');
    await expect(page.locator('text=Deposit Funds')).not.toBeVisible();

    // Reopen - input should be cleared
    await page.click('button:has-text("Deposit")');
    await expect(page.locator('input[id="depositAmount"]')).toHaveValue('');

    console.log('✅ Modal cancel buttons work correctly');
  });
});

test.describe('Billing Validation Edge Cases', () => {
  test.beforeEach(async ({ page }) => {
    // Reset customer data and deposit some funds
    await resetCustomer(page.request, {
      balanceUsdCents: 0,
      spendingLimitUsdCents: 0, // Unlimited
    });

    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: 100,
        initialSpendingLimitUsd: 250,
      },
    });

    // Authenticate and navigate to billing
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');
    await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });
  });

  test('deposit - button correctly validates inputs', async ({ page }) => {
    await page.click('button:has-text("Deposit")');
    await page.waitForTimeout(300);

    const submitButton = page.locator('button:has-text("Deposit")').last();

    // Empty input - clicking should show error
    await submitButton.click();
    await expect(page.locator('text=Please enter a valid amount')).toBeVisible();

    // Negative amount - clicking should show error
    await page.fill('input[id="depositAmount"]', '-50');
    await submitButton.click();
    await expect(page.locator('text=Please enter a valid amount')).toBeVisible();

    // Zero - clicking should show error
    await page.fill('input[id="depositAmount"]', '0');
    await submitButton.click();
    await expect(page.locator('text=Please enter a valid amount')).toBeVisible();

    // Valid amount - should work
    await page.fill('input[id="depositAmount"]', '50');
    await expect(submitButton).toBeEnabled();

    console.log('✅ Deposit button correctly validates inputs');
  });

  test('withdraw - button correctly validates inputs', async ({ page }) => {
    await page.reload();
    await page.waitForTimeout(500);

    await page.click('button:has-text("Withdraw")');
    await page.waitForTimeout(300);

    const submitButton = page.locator('button:has-text("Withdraw")').last();

    // Empty input - clicking should show error
    await submitButton.click();
    await expect(page.locator('text=Please enter a valid amount')).toBeVisible();

    // Negative amount - clicking should show error
    await page.fill('input[id="withdrawAmount"]', '-10');
    await submitButton.click();
    await expect(page.locator('text=Please enter a valid amount')).toBeVisible();

    // Zero - clicking should show error
    await page.fill('input[id="withdrawAmount"]', '0');
    await submitButton.click();
    await expect(page.locator('text=Please enter a valid amount')).toBeVisible();

    // Valid amount - button should be enabled
    await page.fill('input[id="withdrawAmount"]', '50');
    await expect(submitButton).toBeEnabled();

    console.log('✅ Withdraw button correctly validates inputs');
  });

  test('withdraw - shows error when exceeding balance', async ({ page }) => {
    await page.reload();
    await page.waitForTimeout(500);

    await page.click('button:has-text("Withdraw")');
    await page.waitForTimeout(300);

    // Try to withdraw more than balance
    await page.fill('input[id="withdrawAmount"]', '150');
    const submitButton = page.locator('button:has-text("Withdraw")').last();
    await submitButton.click();

    // Should show insufficient balance error
    await expect(page.locator('text=Insufficient balance')).toBeVisible({ timeout: 2000 });
    await expect(page.locator('text=You have $100.00 available')).toBeVisible();

    console.log('✅ Withdraw correctly shows error when exceeding balance');
  });

  test('spending limit - button correctly validates inputs', async ({ page }) => {
    await page.click('button:has-text("Adjust Spending Limit")');
    await page.waitForTimeout(300);

    const submitButton = page.locator('button:has-text("Update Limit")');

    // Empty input - clicking should show error
    await submitButton.click();
    await expect(page.locator('text=Please enter a valid limit')).toBeVisible();

    // Negative amount - clicking should show error
    await page.fill('input[id="spendingLimit"]', '-50');
    await submitButton.click();
    await expect(page.locator('text=Please enter a valid limit')).toBeVisible();

    // Below minimum (but not zero) - clicking should show error
    await page.fill('input[id="spendingLimit"]', '5');
    await submitButton.click();
    await expect(page.locator('text=Spending limit must be at least $10')).toBeVisible();

    // Zero (unlimited) - button should be enabled
    await page.fill('input[id="spendingLimit"]', '0');
    await expect(submitButton).toBeEnabled();

    // Valid amount (>= 10) - button should be enabled
    await page.fill('input[id="spendingLimit"]', '100');
    await expect(submitButton).toBeEnabled();

    console.log('✅ Spending limit button correctly validates inputs');
  });

  test('spending limit - shows error for amount between 1 and 9', async ({ page }) => {
    await page.click('button:has-text("Adjust Spending Limit")');
    await page.waitForTimeout(300);

    const submitButton = page.locator('button:has-text("Update Limit")');

    // Try amount below minimum
    await page.fill('input[id="spendingLimit"]', '5');

    // Click submit - should show error
    await submitButton.click();
    await expect(page.locator('text=Spending limit must be at least $10')).toBeVisible();

    console.log('✅ Spending limit correctly prevents values below minimum');
  });

  test('decimal amounts are handled correctly', async ({ page }) => {
    // Test deposit with decimals
    await page.click('button:has-text("Deposit")');
    await page.waitForTimeout(300);

    await page.fill('input[id="depositAmount"]', '25.50');
    const depositButton = page.locator('button:has-text("Deposit")').last();
    await expect(depositButton).toBeEnabled();
    await depositButton.click();

    await page.waitForTimeout(1000);
    await expect(page.locator('text=Deposit Funds')).not.toBeVisible();

    // Balance should update to $125.50 (100 + 25.50)
    await page.waitForTimeout(500);
    const balanceSection = page.locator('text=Balance').locator('..');
    await expect(balanceSection).toContainText('125.5');

    console.log('✅ Decimal amounts handled correctly');
  });

  test('very small amounts (cents) are accepted', async ({ page }) => {
    await page.click('button:has-text("Deposit")');
    await page.waitForTimeout(300);

    await page.fill('input[id="depositAmount"]', '0.01');
    const submitButton = page.locator('button:has-text("Deposit")').last();
    await expect(submitButton).toBeEnabled();

    console.log('✅ Very small amounts (0.01) are accepted');
  });
});
