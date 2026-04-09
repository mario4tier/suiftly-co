/**
 * E2E Test: Platform Subscription via Stripe
 *
 * Tests the full Stripe payment UX for platform subscriptions using
 * real Stripe sandbox (test keys). These tests interact with actual
 * Stripe Elements iframes — no mocks.
 *
 * Requires: STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY configured.
 * Skipped automatically when Stripe is not available.
 */

import { test, expect } from '../fixtures/base-test';
import {
  resetCustomer,
  authenticateWithMockWallet,
  getCustomerData,
} from '../helpers/db';
import {
  getStripePublishableKey,
  fillStripeCard,
  addSandboxCreditCard,
} from '../helpers/stripe';
import { waitAfterMutation } from '../helpers/wait-utils';
import { waitForToastsToDisappear } from '../helpers/locators';

const API_BASE = 'http://localhost:22700';

test.describe('Platform Stripe Payment', () => {
  let stripeAvailable = false;

  test.beforeEach(async ({ page, request }) => {
    await resetCustomer(request);

    // Disable force-mock BEFORE checking key (force-mock hides the publishable key)
    await request.post(`${API_BASE}/test/stripe/force-mock`, { data: { enabled: false } });

    const stripeKey = await getStripePublishableKey(request);
    stripeAvailable = !!stripeKey;

    await authenticateWithMockWallet(page);
  });

  test.afterEach(async ({ request }) => {
    // Re-enable mock for other tests
    await request.post(`${API_BASE}/test/stripe/force-mock`, { data: { enabled: true } });
  });

  test.afterAll(async ({ request }) => {
    await request.post(`${API_BASE}/test/stripe/force-mock`, { data: { enabled: true } });
  });

  // =========================================================================
  // Full Stripe Card UX — enter card number, subscribe, payment completes
  // =========================================================================
  test('full UX: enter credit card via Stripe Elements then subscribe to platform', async ({ page, request }) => {
    test.skip(!stripeAvailable, 'Real Stripe not configured');
    test.setTimeout(120_000);

    // Navigate to billing
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Step 1: Add credit card via real Stripe Elements
    const addCardButton = page.locator('[data-testid="add-credit-card"]');
    await expect(addCardButton).toBeVisible({ timeout: 5000 });
    await addCardButton.click();

    // Wait for dialog with Stripe iframe
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Fill card details in the Stripe iframe (test card 4242)
    await fillStripeCard(page, {
      number: '4242424242424242',
      expiry: '1230',
      cvc: '123',
    });

    // Submit the card
    const addCardSubmit = dialog.locator('button:has-text("Add Card")');
    await expect(addCardSubmit).toBeEnabled({ timeout: 5000 });
    await addCardSubmit.click();

    // Wait for Stripe confirmSetup to complete (can take 10-30s)
    await expect(dialog).not.toBeVisible({ timeout: 30000 });

    // Verify card appears in payment methods
    const cardRow = page.locator('[data-testid="payment-method-row"]').filter({ hasText: 'Credit Card' });
    await expect(cardRow).toBeVisible({ timeout: 15000 });
    await expect(cardRow).toContainText('Visa', { timeout: 15000 });
    await expect(cardRow).toContainText('4242', { timeout: 15000 });

    // Step 2: Accept TOS and subscribe to platform
    await page.locator('#platform-tos').click();
    const subscribeButton = page.locator('button:has-text("Subscribe to")');
    await expect(subscribeButton).toBeEnabled({ timeout: 10000 });
    await subscribeButton.click();

    // Step 3: Verify payment completes within 1 minute
    // Stripe charges the card → webhook fires → GM processes → UI updates
    await expect(
      page.locator('text=Change Plan')
    ).toBeVisible({ timeout: 60000 });

    // Verify via API that payment actually went through
    const customerData = await getCustomerData(request);
    expect(customerData.customer.subscriptionChargePending).toBe(false);
  });

  // =========================================================================
  // Subscribe first (pending), then add card — payment resolves
  // =========================================================================
  test('subscribe without card then add Stripe card — payment resolves', async ({ page, request }) => {
    test.skip(!stripeAvailable, 'Real Stripe not configured');
    test.setTimeout(120_000);

    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Step 1: Accept TOS and subscribe without any payment method → pending
    await page.locator('#platform-tos').click();
    const subscribeButton = page.locator('button:has-text("Subscribe to")');
    await expect(subscribeButton).toBeEnabled({ timeout: 10000 });
    await subscribeButton.click();
    await waitAfterMutation(page);
    await waitForToastsToDisappear(page);

    // Verify pending state
    await expect(
      page.locator('text=Subscription payment pending')
    ).toBeVisible({ timeout: 5000 });

    // Step 2: Add credit card via real Stripe Elements
    await addSandboxCreditCard(page);

    // Step 3: Payment should resolve within 1 minute
    // Adding a card triggers GM sync-customer webhook → retries pending invoice
    // Wait for "Subscription payment pending" to disappear — this is the definitive
    // indicator that payment resolved. "Change Plan" appears even with pending payments.
    await expect(
      page.locator('text=Subscription payment pending')
    ).not.toBeVisible({ timeout: 60000 });

    // Verify via API that payment actually went through (not just a UI state change)
    const customerData = await getCustomerData(request);
    expect(customerData.customer.subscriptionChargePending).toBe(false);
  });

  // =========================================================================
  // Pre-configured card — subscribe and pay immediately
  // =========================================================================
  test('subscribe with pre-configured Stripe card — immediate payment', async ({ page, request }) => {
    test.skip(!stripeAvailable, 'Real Stripe not configured');
    test.setTimeout(120_000);

    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Add card first (before subscribing)
    await addSandboxCreditCard(page);

    // Now subscribe — should pay immediately via card
    await page.locator('#platform-tos').click();
    const subscribeButton = page.locator('button:has-text("Subscribe to")');
    await expect(subscribeButton).toBeEnabled({ timeout: 10000 });
    await subscribeButton.click();

    // Payment should complete quickly (card already on file)
    await expect(
      page.locator('text=Change Plan')
    ).toBeVisible({ timeout: 60000 });

    // No pending notification
    await expect(
      page.locator('text=Subscription payment pending')
    ).not.toBeVisible({ timeout: 5000 });
  });

  // =========================================================================
  // Declined card handling
  // =========================================================================
  test('declined card shows error in Stripe dialog', async ({ page }) => {
    test.skip(!stripeAvailable, 'Real Stripe not configured');
    test.setTimeout(60_000);

    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    const addCardButton = page.locator('[data-testid="add-credit-card"]');
    await expect(addCardButton).toBeVisible({ timeout: 5000 });
    await addCardButton.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Use Stripe's test declined card number
    await fillStripeCard(page, { number: '4000000000000002' });

    const addCardSubmit = dialog.locator('button:has-text("Add Card")');
    await expect(addCardSubmit).toBeEnabled({ timeout: 5000 });
    await addCardSubmit.click();

    // Should show error — card declined
    await expect(
      dialog.locator('text=/declined|failed|error/i')
    ).toBeVisible({ timeout: 15000 });

    // Dialog should stay open (user can retry with different card)
    await expect(dialog).toBeVisible();
  });
});
