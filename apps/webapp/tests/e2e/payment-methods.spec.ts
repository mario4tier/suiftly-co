/**
 * Payment Methods E2E Test
 * Tests payment method management UI: display, add, reorder, remove
 */

import { test, expect } from '@playwright/test';
import { resetCustomer, ensureTestBalance, addCryptoPayment, addCreditCardPayment } from '../helpers/db';
import { waitAfterMutation } from '../helpers/wait-utils';

const API_BASE = 'http://localhost:22700';

test.describe('Payment Methods', () => {
  test.beforeEach(async ({ page }) => {
    await resetCustomer(page.request);
    await page.context().clearCookies();

    // Authenticate
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await waitAfterMutation(page);
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Navigate to billing
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });
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
    await expect(page.locator('[data-testid="payment-method-row"]').filter({ hasText: 'Crypto' })).toBeVisible();

    // The "Add Crypto Payment" button should be hidden (already added)
    await expect(page.locator('[data-testid="add-crypto-payment"]')).not.toBeVisible();
  });

  test('should add stripe payment method via inline button', async ({ page }) => {
    await addCreditCardPayment(page);

    // Credit Card should appear in the list
    await expect(page.locator('[data-testid="payment-method-row"]').filter({ hasText: 'Credit Card' })).toBeVisible();

    // The "Add Credit Card" button should be hidden (already added)
    await expect(page.locator('[data-testid="add-credit-card"]')).not.toBeVisible();
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

    // Click remove button
    const removeButton = page.locator('button[aria-label="Remove"]');
    await removeButton.click();
    await waitAfterMutation(page);

    // Should show empty state again
    await expect(page.locator('text=No payment methods configured yet.')).toBeVisible();

    // Add Credit Card button should reappear
    await expect(page.locator('[data-testid="add-credit-card"]')).toBeVisible();
  });

  test('should not show remove button for escrow method', async ({ page }) => {
    await addCryptoPayment(page);
    await expect(page.locator('[data-testid="payment-method-row"]').filter({ hasText: 'Crypto' })).toBeVisible();

    // No remove button should be visible for escrow
    await expect(page.locator('button[aria-label="Remove"]')).not.toBeVisible();
  });

  test('should show escrow balance in payment method list', async ({ page }) => {
    // First add crypto payment (before depositing, so escrow card appears)
    await addCryptoPayment(page);

    // Deposit via the now-visible escrow card
    await ensureTestBalance(page.request, 250);
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Balance should appear in the payment method row
    await expect(page.locator('text=Balance: $250.00')).toBeVisible({ timeout: 5000 });
  });
});
