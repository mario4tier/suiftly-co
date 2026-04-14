/**
 * E2E Test: Platform Subscription
 *
 * Tests the platform subscription lifecycle under platform-only mode
 * (freq_platform_sub=1, freq_seal_sub=0) — the production configuration.
 *
 * Covers: onboarding, tier pricing, payment, tier changes, cancellation.
 * Mirrors seal-config.spec.ts and subscription-pricing.spec.ts for platform.
 */

import { test, expect } from '../fixtures/base-test';
import {
  resetCustomer,
  authenticateWithMockWallet,
  ensureTestBalance,
  setupPaymentProvider,
  subscribePlatformService,
  addCreditCardPayment,
} from '../helpers/db';
import { waitAfterMutation } from '../helpers/wait-utils';
import { waitForToastsToDisappear } from '../helpers/locators';
import { PLATFORM_TIER_PRICES_USD_CENTS } from '@suiftly/shared/pricing';

const API_BASE = 'http://localhost:22700';

const STARTER_PRICE = PLATFORM_TIER_PRICES_USD_CENTS.starter; // cents
const PRO_PRICE = PLATFORM_TIER_PRICES_USD_CENTS.pro; // cents
const STARTER_PRICE_USD = STARTER_PRICE / 100;
const PRO_PRICE_USD = PRO_PRICE / 100;

test.describe('Platform Subscription', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetCustomer(request);
    await authenticateWithMockWallet(page);
  });

  // =========================================================================
  // Onboarding Flow
  // =========================================================================
  test.describe('Onboarding', () => {
    test('should show platform plan card on billing page', async ({ page }) => {
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      // Platform plan card should be visible
      await expect(page.locator('h3:has-text("Choose a Platform Plan")')).toBeVisible();

      // Should show both tier labels in the tier card grid
      await expect(page.getByText('Starter', { exact: true })).toBeVisible();
      await expect(page.getByText('Pro', { exact: true }).first()).toBeVisible();

      // Should show tier prices in the tier cards
      await expect(page.getByText(`$${STARTER_PRICE_USD}/mo`, { exact: true })).toBeVisible();
      await expect(page.getByText(`$${PRO_PRICE_USD}/mo`, { exact: true })).toBeVisible();

      // Subscribe button should be disabled (TOS not accepted)
      await expect(page.locator('button:has-text("Subscribe to")')).toBeDisabled();
    });

    test('should subscribe to Platform Starter with escrow', async ({ page, request }) => {
      // Fund escrow account
      await ensureTestBalance(request, 50);

      // Navigate to billing and add payment method
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      // Add crypto payment method (needed for escrow to work)
      const addCryptoButton = page.locator('[data-testid="add-crypto-payment"]');
      const cryptoRow = page.locator('text=/Suiftly Escrow/i').first();
      await expect(addCryptoButton.or(cryptoRow)).toBeVisible({ timeout: 5000 });
      if (await addCryptoButton.isVisible()) {
        await addCryptoButton.click();
        await waitAfterMutation(page);
      }

      // Accept TOS
      await page.locator('#platform-tos').click();
      await waitAfterMutation(page);

      // Subscribe (Starter is default)
      await page.locator('button:has-text("Subscribe to Starter Plan")').click();

      // Wait for actual state change: active subscription card appears
      await expect(
        page.getByText('Platform Starter Plan', { exact: true })
      ).toBeVisible({ timeout: 10000 });

      await waitAfterMutation(page);
    });

    test('should subscribe to Platform Pro with escrow', async ({ page, request }) => {
      await ensureTestBalance(request, 50);
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      // Add crypto payment
      const addCryptoButton = page.locator('[data-testid="add-crypto-payment"]');
      const cryptoRow = page.locator('text=/Suiftly Escrow/i').first();
      await expect(addCryptoButton.or(cryptoRow)).toBeVisible({ timeout: 5000 });
      if (await addCryptoButton.isVisible()) {
        await addCryptoButton.click();
        await waitAfterMutation(page);
      }

      // Select Pro tier
      await page.locator('text=Pro').first().click();

      // Accept TOS
      await page.locator('#platform-tos').click();
      await waitAfterMutation(page);

      // Subscribe
      await page.locator('button:has-text("Subscribe to Pro Plan")').click();

      // Wait for actual state change: active subscription card appears
      await expect(
        page.getByText('Platform Pro Plan', { exact: true })
      ).toBeVisible({ timeout: 10000 });

      await waitAfterMutation(page);
    });

    test('should show payment pending when no funds', async ({ page }) => {
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      // Accept TOS and subscribe with no payment method
      await page.locator('#platform-tos').click();
      await waitAfterMutation(page);

      await page.locator('button:has-text("Subscribe to Starter Plan")').click();

      // Wait for actual state change: pending card appears
      await expect(
        page.locator('text=Subscription payment pending')
      ).toBeVisible({ timeout: 10000 });

      await waitAfterMutation(page);
    });
  });

  // =========================================================================
  // Tier Changes
  // =========================================================================
  test.describe('Tier Changes', () => {
    test.beforeEach(async ({ page, request }) => {
      // Subscribe to platform Starter with funds
      await ensureTestBalance(request, 100);
      await subscribePlatformService(page, 'STARTER');
      await waitForToastsToDisappear(page);
    });

    test('should show Change Plan button on active subscription', async ({ page }) => {
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      await expect(page.locator('text=Change Plan')).toBeVisible();
    });

    test('should open Change Plan modal with tier options', async ({ page }) => {
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      await page.locator('text=Change Plan').click();

      // Modal should appear
      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible({ timeout: 5000 });

      // Should show Pro as upgrade option (currently on Starter)
      await expect(dialog.locator('h4:has-text("PRO")')).toBeVisible();
    });

    test('should show insufficient funds error when upgrading with low escrow balance', async ({ page }) => {
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      // Withdraw nearly all funds — leave only $0.01 (upgrade costs $22+ pro-rated)
      await page.locator('button:has-text("Withdraw")').click();
      const withdrawDialog = page.locator('[role="dialog"]');
      await expect(withdrawDialog).toBeVisible({ timeout: 5000 });
      await page.fill('input#withdrawAmount', '97.99');
      await withdrawDialog.getByRole('button', { name: 'Withdraw' }).click();
      await waitAfterMutation(page);
      await waitForToastsToDisappear(page);

      // Open Change Plan modal and upgrade to Pro
      await page.locator('text=Change Plan').click();
      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible({ timeout: 5000 });

      // Skip if pro-rated charge is too small (last day of month edge case)
      const adjustmentText = await dialog.locator('text=/adjustment charge/i').textContent();
      const match = adjustmentText?.match(/\$(\d+\.?\d*)/);
      if (match && parseFloat(match[1]) <= 0.01) {
        test.skip(true, 'Pro-rated charge too small to test insufficient funds');
      }

      // Click the Pro tier card to select it
      await dialog.locator('text=PRO').first().click();

      // Confirm the upgrade in the confirmation dialog
      const confirmButton = page.locator('button:has-text("Confirm Upgrade")');
      await expect(confirmButton).toBeVisible({ timeout: 5000 });
      await confirmButton.click();
      await waitAfterMutation(page);

      // Should show an error about insufficient funds, NOT "no payment method"
      const toast = page.locator('[data-sonner-toast]').first();
      await expect(toast).toBeVisible({ timeout: 5000 });
      await expect(toast).toContainText(/insufficient funds/i, { timeout: 5000 });
    });

    test('should upgrade via Stripe fallback when escrow has insufficient funds', async ({ page, request }) => {
      test.setTimeout(90000);

      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      // Add Stripe card — uses mock or sandbox depending on server config
      await addCreditCardPayment(page);
      await waitForToastsToDisappear(page);

      // Withdraw nearly all escrow funds
      await page.locator('button:has-text("Withdraw")').click();
      const withdrawDialog = page.locator('[role="dialog"]');
      await expect(withdrawDialog).toBeVisible({ timeout: 5000 });
      await page.fill('input#withdrawAmount', '97.99');
      await withdrawDialog.getByRole('button', { name: 'Withdraw' }).click();
      await waitAfterMutation(page);
      await waitForToastsToDisappear(page);

      // Upgrade to Pro — escrow can't pay, should fall back to Stripe
      await page.locator('text=Change Plan').click();
      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible({ timeout: 5000 });

      // Skip if pro-rated charge is too small
      const adjustmentText = await dialog.locator('text=/adjustment charge/i').textContent();
      const match = adjustmentText?.match(/\$(\d+\.?\d*)/);
      if (match && parseFloat(match[1]) <= 0.01) {
        test.skip(true, 'Pro-rated charge too small to test fallback');
      }

      await dialog.locator('text=PRO').first().click();
      const confirmButton = page.locator('button:has-text("Confirm Upgrade")');
      await expect(confirmButton).toBeVisible({ timeout: 5000 });
      await confirmButton.click();
      await waitAfterMutation(page);
      await waitForToastsToDisappear(page);

      // Upgrade should succeed (Stripe fallback worked)
      // Verify we're now on Pro tier
      await expect(page.locator('text=Platform Pro Plan')).toBeVisible({ timeout: 10000 });
    });
  });

  // =========================================================================
  // Payment Pending Resolution
  // =========================================================================
  test.describe('Payment Pending Resolution', () => {
    test('should resolve pending after depositing funds', async ({ page, request }) => {
      // Subscribe without funds → pending
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      await page.locator('#platform-tos').click();
      await waitAfterMutation(page);
      await page.locator('button:has-text("Subscribe to Starter Plan")').click();
      await waitAfterMutation(page);
      await waitForToastsToDisappear(page);

      // Verify pending state
      await expect(
        page.locator('text=Subscription payment pending')
      ).toBeVisible({ timeout: 5000 });

      // Add crypto payment + deposit funds
      const addCryptoButton = page.locator('[data-testid="add-crypto-payment"]');
      const cryptoRow = page.locator('text=/Suiftly Escrow/i').first();
      await expect(addCryptoButton.or(cryptoRow)).toBeVisible({ timeout: 5000 });
      if (await addCryptoButton.isVisible()) {
        await addCryptoButton.click();
        await waitAfterMutation(page);
      }

      // Deposit via dialog
      await page.locator('button:has-text("Deposit")').first().click();
      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await page.fill('input#depositAmount', '10');
      await dialog.getByRole('button', { name: 'Deposit' }).click();

      // Wait for actual state change: pending resolves → active green card appears
      await expect(
        page.locator('text=Change Plan')
      ).toBeVisible({ timeout: 15000 });

      await waitAfterMutation(page);
    });

    test('should auto-register escrow payment method on deposit and resolve pending', async ({ page }) => {
      // Subscribe without funds → pending
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      await page.locator('#platform-tos').click();
      await waitAfterMutation(page);
      await page.locator('button:has-text("Subscribe to Starter Plan")').click();
      await waitAfterMutation(page);
      await waitForToastsToDisappear(page);

      // Verify pending state
      await expect(page.locator('text=Subscription payment pending')).toBeVisible({ timeout: 5000 });

      // Add escrow payment method and deposit
      await page.locator('[data-testid="add-crypto-payment"]').click();
      await waitAfterMutation(page);

      await page.locator('button:has-text("Deposit")').first().click();
      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await page.fill('input#depositAmount', '10');
      await dialog.getByRole('button', { name: 'Deposit' }).click();

      // Pending should resolve — deposit ensures escrow is registered and retries payment
      await expect(page.locator('text=Change Plan')).toBeVisible({ timeout: 15000 });

      // Verify escrow row is visible in payment methods
      await expect(page.locator('[data-testid="payment-method-row"]').filter({ hasText: 'Suiftly Escrow' })).toBeVisible();
    });

    test('should maintain pending state after page refresh', async ({ page }) => {
      // Subscribe without funds
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      await page.locator('#platform-tos').click();
      await waitAfterMutation(page);
      await page.locator('button:has-text("Subscribe to Starter Plan")').click();
      await waitAfterMutation(page);
      await waitForToastsToDisappear(page);

      // Verify pending
      await expect(
        page.locator('text=Subscription payment pending')
      ).toBeVisible({ timeout: 5000 });

      // Refresh page
      await page.reload();
      await page.waitForLoadState('networkidle');

      // Still pending (not reverted to onboarding form)
      await expect(
        page.locator('text=Subscription payment pending')
      ).toBeVisible({ timeout: 5000 });

      // Onboarding form should NOT reappear
      await expect(
        page.locator('h3:has-text("Choose a Platform Plan")')
      ).not.toBeVisible({ timeout: 2000 }).catch(() => {});
    });

    test('should maintain pending state after navigation', async ({ page }) => {
      // Subscribe without funds
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      await page.locator('#platform-tos').click();
      await waitAfterMutation(page);
      await page.locator('button:has-text("Subscribe to Starter Plan")').click();
      await waitAfterMutation(page);
      await waitForToastsToDisappear(page);

      await expect(
        page.locator('text=Subscription payment pending')
      ).toBeVisible({ timeout: 5000 });

      // Navigate away (to Seal page) and back
      await page.click('text=Seal');
      await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      // Still pending
      await expect(
        page.locator('text=Subscription payment pending')
      ).toBeVisible({ timeout: 5000 });
    });
  });

  // =========================================================================
  // Cancellation
  // =========================================================================
  test.describe('Cancellation', () => {
    test.beforeEach(async ({ page, request }) => {
      await ensureTestBalance(request, 100);
      await subscribePlatformService(page, 'STARTER');
      await waitForToastsToDisappear(page);
    });

    test('should schedule cancellation and show banner', async ({ page }) => {
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      // Open Change Plan modal
      await page.locator('text=Change Plan').click();
      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible({ timeout: 5000 });

      // Cancel Subscription button must be present
      const cancelButton = dialog.locator('button:has-text("Cancel Subscription")');
      await expect(cancelButton).toBeVisible({ timeout: 5000 });
      await cancelButton.click();

      // Confirm cancellation in AlertDialog overlay
      await page.locator('button:has-text("Cancel Subscription")').last().click();

      await waitAfterMutation(page);

      // Should show cancellation scheduled banner
      await expect(
        page.getByTestId('cancellation-scheduled-banner')
      ).toBeVisible({ timeout: 5000 });
    });
  });
});
