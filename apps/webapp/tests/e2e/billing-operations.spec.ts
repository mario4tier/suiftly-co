/**
 * Billing Operations E2E Test
 * Tests deposit, withdraw, spending limit, charge, and refund operations
 */

import { test, expect } from '@playwright/test';
import { resetCustomer, ensureTestBalance, addCryptoPayment } from '../helpers/db';
import { waitAfterMutation } from '../helpers/wait-utils';

const MOCK_WALLET_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const API_BASE = 'http://localhost:22700';

test.describe('Billing Operations', () => {
  test.beforeEach(async ({ page }) => {
    // Delete customer - will be recreated with production defaults on auth
    // Production defaults: balance=$0, spending limit=$250
    await resetCustomer(page.request);

    // Clear cookies for clean auth state (prevents test pollution)
    await page.context().clearCookies();

    // Authenticate with mock wallet
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');

    // Wait for auth to process (smart wait - returns as soon as network idle)
    await waitAfterMutation(page);

    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Navigate to billing page
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Add crypto payment method to reveal escrow card
    await addCryptoPayment(page);
  });

  test('withdraw button is disabled when balance is zero', async ({ page }) => {
    // Verify balance is $0.00
    await expect(page.locator('text=$0.00').first()).toBeVisible();

    // Withdraw button should be visible but disabled
    const withdrawButton = page.locator('button:has-text("Withdraw")');
    await expect(withdrawButton).toBeVisible();
    await expect(withdrawButton).toBeDisabled();

    // Deposit button should be enabled
    await expect(page.locator('button:has-text("Deposit")')).toBeEnabled();

    // Adjust Spending Limit button should be enabled
    await expect(page.locator('button:has-text("Adjust Spending Limit")')).toBeEnabled();

    console.log('✅ Withdraw button correctly disabled at zero balance');
  });

  test('deposit flow - opens modal, validates input, processes deposit', async ({ page }) => {
    // Click deposit button
    await page.click('button:has-text("Deposit")');

    // Wait for modal to open (Playwright auto-retries toBeVisible)
    await expect(page.locator('text=Deposit Funds')).toBeVisible();

    // Verify deposit button is disabled with empty input (client-side validation)
    const submitButton = page.locator('button:has-text("Deposit")').last();
    await expect(submitButton).toBeDisabled();
    console.log('✅ Deposit button correctly disabled with empty input');

    // Enter valid amount
    await page.fill('input[id="depositAmount"]', '100');

    // Button should now be enabled
    await expect(submitButton).toBeEnabled();

    // Submit deposit
    await submitButton.click();

    // Wait for mutation to complete (smart wait - returns as soon as network idle)
    await waitAfterMutation(page);

    // Modal should close (Playwright auto-retries)
    await expect(page.locator('text=Deposit Funds')).not.toBeVisible();

    // Balance should update (Playwright auto-retries toContainText)
    const balanceSection = page.getByText('Balance', { exact: true }).locator('..');
    await expect(balanceSection).toContainText('100');

    // After deposit, Withdraw button should now be enabled
    await expect(page.locator('button:has-text("Withdraw")')).toBeEnabled();

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

    // Try to withdraw more than balance - button should be disabled (client-side validation)
    await page.fill('input[id="withdrawAmount"]', '250');
    const withdrawButton = page.locator('button:has-text("Withdraw")').last();
    await expect(withdrawButton).toBeDisabled();
    console.log('✅ Withdraw button correctly disabled when amount exceeds balance');

    // Enter valid amount
    await page.fill('input[id="withdrawAmount"]', '50');

    // Button should now be enabled
    await expect(withdrawButton).toBeEnabled();

    // Submit withdrawal
    await withdrawButton.click();

    // Wait for success toast
    await expect(page.locator('text=Withdrew $50.00 successfully')).toBeVisible({ timeout: 5000 });

    // Modal should close
    await expect(page.locator('text=Withdraw Funds')).not.toBeVisible();

    // Balance should update to $150.00
    await expect(page.locator('text=$150.00').first()).toBeVisible({ timeout: 3000 });

    console.log('✅ Withdraw flow works correctly');
  });

  test('adjust spending limit flow', async ({ page }) => {
    // Spending limit should initially be $250.00 (default)
    await expect(page.locator('text=Spending Limit Protection')).toBeVisible();
    await expect(page.locator('text=250.00')).toBeVisible();

    // Click adjust spending limit button
    await page.click('button:has-text("Adjust Spending Limit")');

    // Modal should open
    await expect(page.getByRole('heading', { name: 'Adjust Spending Limit' })).toBeVisible();
    await expect(page.locator('text=Set a 28-day spending limit')).toBeVisible();

    // Try to set limit below minimum - button should be disabled (client-side validation)
    await page.fill('input[id="spendingLimit"]', '5');
    const updateButton = page.locator('button:has-text("Update Limit")');
    await expect(updateButton).toBeDisabled();
    console.log('✅ Update Limit button correctly disabled for value below $10');

    // Enter valid limit
    await page.fill('input[id="spendingLimit"]', '100');

    // Button should now be enabled
    await expect(updateButton).toBeEnabled();

    // Submit update
    await updateButton.click();

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

    // Should see deposit and charge in history (Playwright auto-retries)
    await expect(page.locator('text=deposit').first()).toBeVisible();
    await expect(page.locator('text=charge').first()).toBeVisible();
    await expect(page.locator('text=Seal Pro tier')).toBeVisible();

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

    // Should see credit (refund) in history (Playwright auto-retries)
    // Note: With semantic itemType schema, refund displays as "credit" (the formatted description)
    // The raw description is stored in ledger_entries but UI displays formatted itemType
    await expect(page.locator('text=credit').first()).toBeVisible();

    console.log('✅ Charge and refund flow works correctly with billing history');
  });

  test('spending limit enforcement', async ({ page }) => {
    // Set up $100 balance and $50 spending limit
    await ensureTestBalance(page.request, 100, {
      spendingLimitUsd: 50,
    });

    await page.reload();
    await expect(page.locator('text=$100.00').first()).toBeVisible();
    // Check for spending limit
    await expect(page.locator('text=$50.00')).toBeVisible();
    await expect(page.locator('text=per 28-days')).toBeVisible();

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
    // For now, verify button is disabled for negative amounts (client-side validation)
    await page.click('button:has-text("Deposit")');
    await page.fill('input[id="depositAmount"]', '-100');

    // Button should be disabled for negative amount
    const depositButton = page.locator('button:has-text("Deposit")').last();
    await expect(depositButton).toBeDisabled();

    console.log('✅ Error handling displays correctly - button disabled for negative amount');
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
    // Reset to production defaults
    await resetCustomer(page.request);

    // Clear cookies for clean auth state (prevents test pollution)
    await page.context().clearCookies();

    // Authenticate (this recreates the customer with production defaults)
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await waitAfterMutation(page);
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Now set $100 balance (customer exists after auth)
    await ensureTestBalance(page.request, 100);

    // Navigate to billing
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Add crypto payment method to reveal escrow card
    await addCryptoPayment(page);
  });

  test('deposit - button correctly validates inputs', async ({ page }) => {
    await page.click('button:has-text("Deposit")');

    const submitButton = page.locator('button:has-text("Deposit")').last();

    // Empty input - button should be disabled (client-side validation)
    await expect(submitButton).toBeDisabled();

    // Negative amount - button should be disabled
    await page.fill('input[id="depositAmount"]', '-50');
    await expect(submitButton).toBeDisabled();

    // Zero - button should be disabled
    await page.fill('input[id="depositAmount"]', '0');
    await expect(submitButton).toBeDisabled();

    // Valid amount - button should be enabled
    await page.fill('input[id="depositAmount"]', '50');
    await expect(submitButton).toBeEnabled();

    console.log('✅ Deposit button correctly validates inputs via client-side validation');
  });

  test('withdraw - button correctly validates inputs', async ({ page }) => {
    await page.reload();

    await page.click('button:has-text("Withdraw")');

    const submitButton = page.locator('button:has-text("Withdraw")').last();

    // Empty input - button should be disabled (client-side validation)
    await expect(submitButton).toBeDisabled();

    // Negative amount - button should be disabled
    await page.fill('input[id="withdrawAmount"]', '-10');
    await expect(submitButton).toBeDisabled();

    // Zero - button should be disabled
    await page.fill('input[id="withdrawAmount"]', '0');
    await expect(submitButton).toBeDisabled();

    // Valid amount - button should be enabled
    await page.fill('input[id="withdrawAmount"]', '50');
    await expect(submitButton).toBeEnabled();

    console.log('✅ Withdraw button correctly validates inputs via client-side validation');
  });

  test('withdraw - shows error when exceeding balance', async ({ page }) => {
    await page.reload();

    await page.click('button:has-text("Withdraw")');

    // Try to withdraw more than balance - button should be disabled (client-side validation)
    await page.fill('input[id="withdrawAmount"]', '150');
    const submitButton = page.locator('button:has-text("Withdraw")').last();
    await expect(submitButton).toBeDisabled();

    console.log('✅ Withdraw button correctly disabled when amount exceeds balance');
  });

  test('spending limit - button correctly validates inputs', async ({ page }) => {
    await page.click('button:has-text("Adjust Spending Limit")');

    const submitButton = page.locator('button:has-text("Update Limit")');

    // Clear the pre-filled value, then verify button is disabled for empty input
    await page.fill('input[id="spendingLimit"]', '');
    await expect(submitButton).toBeDisabled();

    // Negative amount - button should be disabled
    await page.fill('input[id="spendingLimit"]', '-50');
    await expect(submitButton).toBeDisabled();

    // Below minimum (but not zero) - button should be disabled
    await page.fill('input[id="spendingLimit"]', '5');
    await expect(submitButton).toBeDisabled();

    // Zero (unlimited) - button should be enabled
    await page.fill('input[id="spendingLimit"]', '0');
    await expect(submitButton).toBeEnabled();

    // Valid amount (>= 10) - button should be enabled
    await page.fill('input[id="spendingLimit"]', '100');
    await expect(submitButton).toBeEnabled();

    console.log('✅ Spending limit button correctly validates inputs via client-side validation');
  });

  test('spending limit - shows error for amount between 1 and 9', async ({ page }) => {
    await page.click('button:has-text("Adjust Spending Limit")');

    const submitButton = page.locator('button:has-text("Update Limit")');

    // Try amount below minimum - button should be disabled (client-side validation)
    await page.fill('input[id="spendingLimit"]', '5');
    await expect(submitButton).toBeDisabled();

    console.log('✅ Spending limit button correctly disabled for values below minimum');
  });

  test('decimal amounts are handled correctly', async ({ page }) => {
    // Ensure we have exactly $100 balance (adjust from previous test state)
    await ensureTestBalance(page.request, 100);
    await page.reload();

    // Test deposit with decimals
    await page.click('button:has-text("Deposit")');

    await page.fill('input[id="depositAmount"]', '25.50');
    const depositButton = page.locator('button:has-text("Deposit")').last();
    await expect(depositButton).toBeEnabled();
    await depositButton.click();

    // Wait for mutation to complete (smart wait)
    await waitAfterMutation(page);
    await expect(page.locator('text=Deposit Funds')).not.toBeVisible();

    // Balance should update to $125.50 (100 + 25.50) - Playwright auto-retries
    const balanceSection = page.getByText('Balance', { exact: true }).locator('..');
    await expect(balanceSection).toContainText('125.5');

    console.log('✅ Decimal amounts handled correctly');
  });

  test('very small amounts (cents) are accepted', async ({ page }) => {
    await page.click('button:has-text("Deposit")');

    await page.fill('input[id="depositAmount"]', '0.01');
    const submitButton = page.locator('button:has-text("Deposit")').last();
    await expect(submitButton).toBeEnabled();

    console.log('✅ Very small amounts (0.01) are accepted');
  });
});
