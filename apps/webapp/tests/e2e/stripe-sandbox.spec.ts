/**
 * Stripe Sandbox E2E Tests
 *
 * Tests the real Stripe Elements card flow using Stripe test keys (pk_test_* / sk_test_*).
 * Requires STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY configured in ~/.suiftly.env
 * and Stripe CLI running (started automatically by start-dev.sh).
 *
 * These tests are SKIPPED when Stripe keys are not configured (falls back to mock tests).
 */

import { test, expect } from '@playwright/test';
import { resetCustomer, getCustomerData, subscribeSealService } from '../helpers/db';
import { waitAfterMutation } from '../helpers/wait-utils';
import { getStripePublishableKey, findStripeFrame, fillStripeCard } from '../helpers/stripe';

const API_BASE = 'http://localhost:22700';

test.describe('Stripe Sandbox', () => {
  let stripeKey: string | undefined;
  /** Original force-mock state before this suite, restored in afterAll */
  let originalForceMock = false;

  test.beforeAll(async ({ request }) => {
    // Capture original force-mock state BEFORE disabling, so afterAll can
    // restore it even if this function throws.
    const keyBeforeDisable = await getStripePublishableKey(request);
    originalForceMock = !keyBeforeDisable; // no key → force-mock was active

    // Disable force-mock — previous test suites may have left it active,
    // which causes the config endpoint to return empty stripePublishableKey
    await request.post(`${API_BASE}/test/stripe/force-mock`, {
      data: { enabled: false },
    });

    stripeKey = await getStripePublishableKey(request) || undefined;
    if (!stripeKey) {
      // Restore force-mock before throwing — afterAll won't run if beforeAll throws
      await request.post(`${API_BASE}/test/stripe/force-mock`, {
        data: { enabled: originalForceMock },
      });
      throw new Error(
        'STRIPE_PUBLISHABLE_KEY not returned by config endpoint. ' +
        'Ensure STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY are set in ~/.suiftly.env ' +
        'and the API server is running with those env vars loaded.'
      );
    }
  });

  test.beforeEach(async ({ page }) => {
    // Ensure force-mock is disabled for real Stripe tests
    await page.request.post(`${API_BASE}/test/stripe/force-mock`, {
      data: { enabled: false },
    });

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

  test.afterEach(async ({ page }) => {
    // Re-enable force-mock between tests so a failing test doesn't leave
    // real Stripe active for subsequent suites in this run.
    await page.request.post(`${API_BASE}/test/stripe/force-mock`, {
      data: { enabled: true },
    });
  });

  test.afterAll(async ({ request }) => {
    // Restore the original force-mock state captured in beforeAll.
    // If the dev session was intentionally using real Stripe (force-mock false),
    // we don't want to leave it stuck as true after the suite finishes.
    await request.post(`${API_BASE}/test/stripe/force-mock`, {
      data: { enabled: originalForceMock },
    });
  });

  test('should open Stripe Elements dialog when adding credit card', async ({ page }) => {
    const addButton = page.locator('[data-testid="add-credit-card"]');
    await expect(addButton).toBeVisible();
    await addButton.click();

    // Dialog should open
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog.locator('text=Add Credit Card')).toBeVisible();

    // Stripe PaymentElement should load — look for "Card" tab in a Stripe frame
    await findStripeFrame(page, 'Card', 15000);

    // Should NOT show mock card details
    await expect(dialog.locator('text=4242 4242 4242 4242')).not.toBeVisible();

    // Cancel should close dialog
    await dialog.locator('button:has-text("Cancel")').click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
  });

  test('should add credit card via Stripe Elements and show it in list', async ({ page }) => {
    // Click "Add Credit Card"
    const addButton = page.locator('[data-testid="add-credit-card"]');
    await expect(addButton).toBeVisible();
    await addButton.click();

    // Wait for dialog
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Fill in the Stripe card form
    await fillStripeCard(page);

    // Click "Add Card"
    const addCardButton = dialog.locator('button:has-text("Add Card")');
    await expect(addCardButton).toBeEnabled({ timeout: 5000 });
    await addCardButton.click();

    // Wait for dialog to close (confirmSetup succeeded)
    await expect(dialog).not.toBeVisible({ timeout: 30000 });

    // The frontend polls for the webhook-created payment method row.
    // Just wait for the card to appear (polling handles the retry).
    const creditCardRow = page.locator('[data-testid="payment-method-row"]').filter({ hasText: 'Credit Card' });
    await expect(creditCardRow).toBeVisible({ timeout: 15000 });

    // Verify card details from the webhook (Visa 4242)
    // Row appears immediately (addPaymentMethod inserts it), but card details
    // arrive later when the Stripe webhook fires and updates the row.
    await expect(creditCardRow).toContainText('Visa', { timeout: 15000 });
    await expect(creditCardRow).toContainText('4242', { timeout: 15000 });

    // "Add Credit Card" button should be gone
    await expect(addButton).not.toBeVisible();
  });

  test('should handle declined card gracefully', async ({ page }) => {
    const addButton = page.locator('[data-testid="add-credit-card"]');
    await addButton.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Use Stripe's test declined card number
    await fillStripeCard(page, { number: '4000000000000002' });

    const addCardButton = dialog.locator('button:has-text("Add Card")');
    await expect(addCardButton).toBeEnabled({ timeout: 5000 });
    await addCardButton.click();

    // Should show an error message in the dialog (not close it)
    // Stripe returns "Your card was declined" for this test card
    const errorBox = dialog.locator('text=/declined|failed|error/i');
    await expect(errorBox).toBeVisible({ timeout: 15000 });

    // Dialog should still be open
    await expect(dialog).toBeVisible();

    // Close dialog — scroll to Cancel button (dialog is scrollable)
    const cancelButton = dialog.locator('button:has-text("Cancel")');
    await cancelButton.scrollIntoViewIfNeeded();
    await cancelButton.click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
  });

  test('should clear payment pending after adding credit card', async ({ page }) => {
    // Extended timeout: Stripe webhook → API handler → GM sync → charge → UI update
    test.setTimeout(120000);

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

    // Step 3: Add credit card via real Stripe Elements
    const addButton = page.locator('[data-testid="add-credit-card"]');
    await expect(addButton).toBeVisible();
    await addButton.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    await fillStripeCard(page);

    const addCardButton = dialog.locator('button:has-text("Add Card")');
    await expect(addCardButton).toBeEnabled({ timeout: 5000 });
    await addCardButton.click();

    // Wait for dialog to close (confirmSetup succeeded)
    await expect(dialog).not.toBeVisible({ timeout: 30000 });

    // Wait for card to appear in payment methods list
    const creditCardRow = page.locator('[data-testid="payment-method-row"]').filter({ hasText: 'Credit Card' });
    await expect(creditCardRow).toBeVisible({ timeout: 15000 });

    // Step 4: Wait for GM to process the payment via Stripe.
    // The webhook fires setup_intent.succeeded → saves payment method → triggers GM sync-customer.
    // GM calls retryUnpaidInvoices → StripePaymentProvider charges the card → clears subPendingInvoiceId.
    // The frontend polls services.list after card setup (added in handleCardDialogSuccess).
    // Poll until the pending banner disappears.
    // Generous timeout: real Stripe webhook delivery + GM retry + charge can take 30-60s.
    const pendingBanner = page.locator('text=Subscription payment pending');
    await expect(pendingBanner).not.toBeVisible({ timeout: 90000 });

    // Step 5: Verify via test endpoint that payment is no longer pending
    const customerData = await getCustomerData(page.request);
    const sealService = customerData.services.find((s: any) => s.serviceType === 'seal');
    expect(sealService).toBeDefined();
    expect(sealService.subscriptionChargePending).toBe(false);
  });

  test('should subscribe with pre-configured card and pay immediately', async ({ page }) => {
    // Extended timeout: Stripe webhook delivery + charge
    test.setTimeout(120000);

    // Step 1: Add credit card first (before subscribing)
    const addButton = page.locator('[data-testid="add-credit-card"]');
    await expect(addButton).toBeVisible();
    await addButton.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    await fillStripeCard(page);

    const addCardButton = dialog.locator('button:has-text("Add Card")');
    await expect(addCardButton).toBeEnabled({ timeout: 5000 });
    await addCardButton.click();

    // Wait for dialog to close (confirmSetup succeeded)
    await expect(dialog).not.toBeVisible({ timeout: 30000 });

    // Wait for card to appear in payment methods list
    const creditCardRow = page.locator('[data-testid="payment-method-row"]').filter({ hasText: 'Credit Card' });
    await expect(creditCardRow).toBeVisible({ timeout: 15000 });

    // Wait for webhook to update card details (Visa 4242)
    await expect(creditCardRow).toContainText('Visa', { timeout: 15000 });

    // Step 2: Subscribe to Seal service (card already configured → payment succeeds)
    await subscribeSealService(page, 'STARTER', { successTimeout: 30000 });

    // Should show service disabled banner (not payment pending)
    await expect(page.locator('text=/Service is currently OFF/i')).toBeVisible({ timeout: 5000 });

    // Step 3: Verify via test endpoint that payment is not pending
    const customerData = await getCustomerData(page.request);
    const sealService = customerData.services.find((s: any) => s.serviceType === 'seal');
    expect(sealService).toBeDefined();
    expect(sealService.subscriptionChargePending).toBe(false);
  });
});
