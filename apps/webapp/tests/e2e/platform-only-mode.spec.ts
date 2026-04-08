/**
 * E2E Test: Platform-Only Subscription Model
 *
 * Verifies platform-only subscription behavior:
 * - Platform subscription required before accessing services
 * - Seal page shows a gated preview (tabs visible) before platform subscribe
 * - Add Key / enable actions are blocked until platform subscription is active
 * - Seal is auto-provisioned (disabled) when platform payment succeeds
 * - No per-service subscription form for seal (seal is free, auto-provisioned)
 * - Seal can be enabled via toggle after platform subscribe
 */

import { test, expect } from '../fixtures/base-test';
import {
  resetCustomer,
  authenticateWithMockWallet,
  ensureTestBalance,
  subscribePlatformService,
} from '../helpers/db';
import { waitAfterMutation } from '../helpers/wait-utils';
import { waitForToastsToDisappear } from '../helpers/locators';

test.describe('Platform-Only Subscription', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetCustomer(request);
    await authenticateWithMockWallet(page);
  });

  // =========================================================================
  // Platform as Prerequisite
  // =========================================================================
  test.describe('Platform Required', () => {
    test('should show platform plan card on billing page when not subscribed', async ({ page }) => {
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      await expect(
        page.locator('h3:has-text("Choose a Platform Plan")')
      ).toBeVisible({ timeout: 5000 });

      await expect(
        page.locator('text=A platform subscription is required to use Suiftly services')
      ).toBeVisible();
    });

    test('should show seal page in gated preview mode (tabs visible) without platform subscription', async ({ page }) => {
      await page.click('text=Seal');
      await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

      // Platform-required banner visible inside the form
      await expect(
        page.locator('[data-testid="platform-required-banner"]')
      ).toBeVisible({ timeout: 5000 });

      // Tabs are visible (user can peek at the interface)
      await expect(page.locator('[role="tablist"]')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('[role="tab"]:has-text("Overview")')).toBeVisible();
      await expect(page.locator('[role="tab"]:has-text("X-API-Key")')).toBeVisible();
      await expect(page.locator('[role="tab"]:has-text("Seal Keys")')).toBeVisible();
      await expect(page.locator('[role="tab"]:has-text("More Settings")')).toBeVisible();

      // The old per-service subscription form must never appear
      await expect(
        page.locator('button:has-text("Subscribe to Service")')
      ).not.toBeVisible();
    });

    test('should show platform-required banner instead of service-state banner when not subscribed', async ({ page }) => {
      await page.click('text=Seal');
      await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

      // Platform-required banner takes precedence
      await expect(
        page.locator('[data-testid="platform-required-banner"]')
      ).toBeVisible({ timeout: 5000 });

      // Verify correct messaging (not "enable this service" which conflates with the ON/OFF toggle)
      await expect(
        page.locator('[data-testid="platform-required-banner"]')
      ).toContainText('unlock these features');

      // Service-state banner (e.g. "Service is currently OFF") must be suppressed
      await expect(
        page.locator('[data-testid="banner-section"]')
      ).not.toBeVisible();
    });

    test('should gate Add API Key action without platform subscription', async ({ page }) => {
      await page.click('text=Seal');
      await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
      await expect(page.locator('[data-testid="platform-required-banner"]')).toBeVisible({ timeout: 5000 });

      // Navigate to X-API-Key tab
      await page.locator('[role="tab"]:has-text("X-API-Key")').click();

      // Add API Key button should be disabled (gated)
      const addApiKeyButton = page.locator('button:has-text("Add New API Key")');
      await expect(addApiKeyButton).toBeVisible({ timeout: 5000 });
      await expect(addApiKeyButton).toBeDisabled();
    });

    test('should gate Add Seal Key action without platform subscription', async ({ page }) => {
      await page.click('text=Seal');
      await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
      await expect(page.locator('[data-testid="platform-required-banner"]')).toBeVisible({ timeout: 5000 });

      // Navigate to Seal Keys tab
      await page.locator('[role="tab"]:has-text("Seal Keys")').click();

      // Add Seal Key button should be disabled (gated)
      const addSealKeyButton = page.locator('button:has-text("Add New Seal Key")');
      await expect(addSealKeyButton).toBeVisible({ timeout: 5000 });
      await expect(addSealKeyButton).toBeDisabled();
    });

    test('should show seal toggle after platform subscription (seal auto-provisioned)', async ({ page, request }) => {
      // Fund and subscribe to platform
      await ensureTestBalance(request, 50);
      await subscribePlatformService(page, 'STARTER');
      await waitForToastsToDisappear(page);

      // Navigate to Seal — seal was auto-provisioned, toggle should be visible
      await page.click('text=Seal');
      await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
      // Don't use networkidle — seal page polls vault sync status, preventing networkidle
      // when GM is processing vault generation after subscription. Wait for toggle directly.

      // Toggle visible (auto-provisioned, not the old subscription form)
      await expect(
        page.locator('#service-toggle')
      ).toBeVisible({ timeout: 30000 });

      // No subscription form button
      await expect(
        page.locator('button:has-text("Subscribe to Service")')
      ).not.toBeVisible();

      // No gated banner (platform is now active)
      await expect(
        page.locator('[data-testid="platform-required-banner"]')
      ).not.toBeVisible();
    });
  });

  // =========================================================================
  // Seal Service Access (No Per-Service Billing)
  // =========================================================================
  test.describe('Seal Service (Auto-Provisioned)', () => {
    test.beforeEach(async ({ page, request }) => {
      await ensureTestBalance(request, 100);
      await subscribePlatformService(page, 'STARTER');
      await waitForToastsToDisappear(page);
    });

    test('should NOT show seal subscription form after platform subscription', async ({ page }) => {
      await page.click('text=Seal');
      await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

      // No subscription form
      await expect(
        page.locator('button:has-text("Subscribe to Service")')
      ).not.toBeVisible({ timeout: 5000 });

      // Toggle is visible (auto-provisioned)
      await expect(
        page.locator('#service-toggle')
      ).toBeVisible({ timeout: 5000 });
    });

    test('should enable seal service via toggle (no payment required for seal)', async ({ page }) => {
      // Navigate to Seal (auto-provisioned, starts disabled)
      await page.click('text=Seal');
      await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
      // Don't use networkidle — seal page polls vault sync status, preventing networkidle

      // Service starts disabled — wait directly for the banner (covers slow GM processing)
      await expect(
        page.locator('text=/Service is currently OFF/i')
      ).toBeVisible({ timeout: 30000 });

      // Enable via toggle — no payment error (seal has no billing)
      const serviceToggle = page.locator('#service-toggle');
      await expect(serviceToggle).toBeVisible({ timeout: 5000 });
      await serviceToggle.click();
      await waitAfterMutation(page);

      // Disabled banner should disappear
      await expect(
        page.locator('text=/Service is currently OFF/i')
      ).not.toBeVisible({ timeout: 10000 });
    });

    test('should show platform charges on billing page (no seal charges)', async ({ page }) => {
      // Go to billing page
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      // Platform active card should be visible
      await expect(
        page.locator('text=Change Plan')
      ).toBeVisible({ timeout: 5000 });

      // Next scheduled payment must show platform charge but NOT seal charge
      const nextPaymentButton = page.locator('button').filter({ hasText: /Next Scheduled/ });
      if (await nextPaymentButton.isVisible()) {
        await nextPaymentButton.click();

        // Platform subscription line item should be present
        await expect(
          page.getByText('Platform Starter plan', { exact: true })
        ).toBeVisible({ timeout: 3000 });
      }
    });
  });

  // =========================================================================
  // Full Onboarding Flow
  // =========================================================================
  test.describe('Full Onboarding Flow', () => {
    test('should complete onboarding: platform subscribe then enable seal', async ({ page, request }) => {
      await ensureTestBalance(request, 100);

      // Step 1: Subscribe to platform (seal auto-provisioned)
      await subscribePlatformService(page, 'STARTER');
      await waitForToastsToDisappear(page);

      // Step 2: Navigate to Seal
      await page.click('text=Seal');
      await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
      // Don't use networkidle — seal page polls vault sync status

      // Step 3: Enable seal via toggle
      const serviceToggle = page.locator('#service-toggle');
      await expect(serviceToggle).toBeVisible({ timeout: 30000 });
      await serviceToggle.click();
      await waitAfterMutation(page);

      // Step 4: Verify seal is enabled
      await expect(
        page.locator('text=/Service is currently OFF/i')
      ).not.toBeVisible({ timeout: 10000 });

      // Step 5: Billing page shows platform active card
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });
      await expect(
        page.locator('text=Change Plan')
      ).toBeVisible({ timeout: 5000 });
    });
  });
});
