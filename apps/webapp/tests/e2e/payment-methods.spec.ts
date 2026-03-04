/**
 * Payment Methods E2E Test
 * Tests payment method management UI: display, add, reorder, remove
 */

import { test, expect } from '@playwright/test';
import { resetCustomer, ensureTestBalance, addCryptoPayment, addCreditCardPayment, getCustomerData } from '../helpers/db';
import { waitAfterMutation } from '../helpers/wait-utils';

const API_BASE = 'http://localhost:22700';

test.describe('Payment Methods', () => {
  test.beforeEach(async ({ page }) => {
    await resetCustomer(page.request);
    await page.context().clearCookies();

    // Force mock Stripe mode (ensures mock even when STRIPE_SECRET_KEY is set)
    await page.request.post(`${API_BASE}/test/stripe/force-mock`, {
      data: { enabled: true },
    });

    // Authenticate
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await waitAfterMutation(page);
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Navigate to billing
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });
  });

  test.afterEach(async ({ page }) => {
    // Clean up force-mock so it doesn't leak into manual testing
    await page.request.post(`${API_BASE}/test/stripe/force-mock`, {
      data: { enabled: false },
    });
  });

  test('should show empty state for new customer', async ({ page }) => {
    await expect(page.locator('text=No payment methods configured yet.')).toBeVisible();
    // Escrow card should NOT be visible (no crypto payment added)
    await expect(page.locator('h2:has-text("Suiftly Escrow Account")')).not.toBeVisible();
  });

  test('should show add buttons for all provider types', async ({ page }) => {
    // All three add buttons should be visible
    await expect(page.locator('[data-testid="add-crypto-payment"]')).toBeVisible();
    await expect(page.locator('[data-testid="add-credit-card"]')).toBeVisible();
    await expect(page.locator('[data-testid="add-paypal"]')).toBeVisible();

    // PayPal should be disabled
    await expect(page.locator('[data-testid="add-paypal"]')).toBeDisabled();
  });

  test('should add crypto payment method via inline button', async ({ page }) => {
    await addCryptoPayment(page);

    // Escrow card should now be visible
    await expect(page.locator('h2:has-text("Suiftly Escrow Account")')).toBeVisible();

    // Crypto method should appear in the list
    await expect(page.locator('[data-testid="payment-method-row"]').filter({ hasText: 'Suiftly Escrow' })).toBeVisible();

    // The "Add Crypto Payment" button should be hidden (already added)
    await expect(page.locator('[data-testid="add-crypto-payment"]')).not.toBeVisible();
  });

  test('should add stripe payment method via inline button', async ({ page }) => {
    await addCreditCardPayment(page);

    // Credit Card should appear in the list with card details
    const creditCardRow = page.locator('[data-testid="payment-method-row"]').filter({ hasText: 'Credit Card' });
    await expect(creditCardRow).toBeVisible();
    await expect(creditCardRow).toContainText('Visa');
    await expect(creditCardRow).toContainText('4242');

    // The "Add Credit Card" button should be hidden (already added)
    await expect(page.locator('[data-testid="add-credit-card"]')).not.toBeVisible();
  });

  test('should show card dialog when adding credit card', async ({ page }) => {
    // Click "Add Credit Card"
    const addButton = page.locator('[data-testid="add-credit-card"]');
    await addButton.click();

    // Dialog should open with test card details
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog.locator('text=Add Credit Card')).toBeVisible();
    await expect(dialog.locator('text=4242 4242 4242 4242')).toBeVisible();

    // Cancel should close dialog without adding card
    await dialog.locator('button:has-text("Cancel")').click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    // No card should appear in the list
    await expect(page.locator('[data-testid="payment-method-row"]').filter({ hasText: 'Credit Card' })).not.toBeVisible();

    // Add button should still be visible
    await expect(page.locator('[data-testid="add-credit-card"]')).toBeVisible();
  });

  test('should allow re-adding credit card after cancel (no orphan row)', async ({ page }) => {
    // This tests that cancelling the card dialog doesn't leave a dangling
    // payment method row that blocks future attempts.

    // Step 1: Open dialog and cancel
    const addButton = page.locator('[data-testid="add-credit-card"]');
    await addButton.click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await dialog.locator('button:has-text("Cancel")').click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    // Step 2: Reload page to fetch fresh data from server
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Step 3: "Add Credit Card" button should still be visible after reload
    // (If the orphan row bug existed, hasStripeMethod would be true and the button hidden)
    await expect(page.locator('[data-testid="add-credit-card"]')).toBeVisible({ timeout: 5000 });

    // Step 4: Now actually add the card — should succeed
    await addCreditCardPayment(page);
    const creditCardRow = page.locator('[data-testid="payment-method-row"]').filter({ hasText: 'Credit Card' });
    await expect(creditCardRow).toBeVisible();
    await expect(creditCardRow).toContainText('Visa');
    await expect(creditCardRow).toContainText('4242');
  });

  test('should reorder methods via up/down buttons', async ({ page }) => {
    // Add both crypto and stripe
    await addCryptoPayment(page);
    await addCreditCardPayment(page);

    // Click Move Down on the first method (crypto)
    const moveDownButton = page.locator('button[aria-label="Move down"]').first();
    await moveDownButton.click();
    await waitAfterMutation(page);

    // After reorder, the first payment method row should be Credit Card
    const methodRows = page.locator('[data-testid="payment-method-row"]');
    await expect(methodRows.first()).toContainText('Credit Card');
  });

  test('should remove credit card from list', async ({ page }) => {
    await addCreditCardPayment(page);
    await expect(page.locator('[data-testid="payment-method-row"]').filter({ hasText: 'Credit Card' })).toBeVisible();

    // Click remove button — opens confirmation dialog
    const removeButton = page.locator('button[aria-label="Remove"]');
    await removeButton.click();

    // Confirm removal in the dialog
    const confirmDialog = page.locator('[role="dialog"]').filter({ hasText: 'Remove Credit Card' });
    await expect(confirmDialog).toBeVisible({ timeout: 5000 });
    await confirmDialog.locator('button:has-text("Remove")').click();
    await waitAfterMutation(page);

    // Should show empty state again
    await expect(page.locator('text=No payment methods configured yet.')).toBeVisible();

    // Add Credit Card button should reappear
    await expect(page.locator('[data-testid="add-credit-card"]')).toBeVisible();
  });

  test('should not show remove button for escrow method', async ({ page }) => {
    await addCryptoPayment(page);
    await expect(page.locator('[data-testid="payment-method-row"]').filter({ hasText: 'Suiftly Escrow' })).toBeVisible();

    // No remove button should be visible for escrow
    await expect(page.locator('button[aria-label="Remove"]')).not.toBeVisible();
  });

  test('should show escrow balance in escrow account card', async ({ page }) => {
    // First add crypto payment (before depositing, so escrow card appears)
    await addCryptoPayment(page);

    // Deposit via the now-visible escrow card
    await ensureTestBalance(page.request, 250);
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Balance should appear in the Suiftly Escrow Account card (not the payment method row)
    await expect(page.locator('h2:has-text("Suiftly Escrow Account")')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('$250.00', { exact: true }).first()).toBeVisible({ timeout: 5000 });
  });

  test('should clear payment pending after escrow deposit and GM reconciliation', async ({ page }) => {
    // Step 1: Subscribe to Seal service without payment methods (payment will be pending)
    await page.goto('/services/seal/overview');
    await page.waitForLoadState('networkidle');

    // Select Starter tier (cheapest)
    await page.click('text=STARTER');

    // Accept terms of service
    await page.locator('#terms').click();

    // Subscribe — payment will fail (no payment methods configured)
    await page.click('button:has-text("Subscribe to Service")');
    await waitAfterMutation(page);

    // Step 2: Navigate to billing and verify pending banner
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });
    await expect(page.locator('text=Subscription payment pending')).toBeVisible({ timeout: 5000 });

    // Step 3: Add escrow payment method and deposit sufficient funds
    await addCryptoPayment(page);
    await ensureTestBalance(page.request, 50);

    // Step 4: Trigger GM reconciliation (synchronous — waits for completion).
    // GM's reconcilePayments charges via escrow (DB-backed mock) and clears subPendingInvoiceId.
    const customerData = await getCustomerData(page.request);
    const reconcileResp = await page.request.post(`${API_BASE}/test/billing/reconcile`, {
      data: { customerId: customerData.customer.customerId },
    });
    expect(reconcileResp.ok()).toBeTruthy();

    // Step 5: Reload and verify pending banner is gone
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('text=Subscription payment pending')).not.toBeVisible({ timeout: 5000 });

    // Verify the service payment is no longer pending via test endpoint
    const updatedData = await getCustomerData(page.request);
    const sealService = updatedData.services.find((s: any) => s.serviceType === 'seal');
    expect(sealService).toBeDefined();
    expect(sealService.subscriptionChargePending).toBe(false);
  });
});
