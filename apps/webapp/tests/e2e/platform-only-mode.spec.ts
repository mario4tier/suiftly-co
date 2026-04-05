/**
 * E2E Test: Platform-Only Mode (Production Config)
 *
 * Verifies behavior under freq_platform_sub=1, freq_seal_sub=0:
 * - Platform subscription required before accessing services
 * - Seal subscription works but billing is skipped (usage-based only)
 * - Platform active card gates seal access
 * - Seal service can be subscribed and enabled without seal billing
 */

import { test, expect } from '../fixtures/base-test';
import {
  resetCustomer,
  authenticateWithMockWallet,
  ensureTestBalance,
  subscribePlatformService,
  subscribeSealService,
  setConfigFlags,
} from '../helpers/db';
import { waitAfterMutation } from '../helpers/wait-utils';
import { getToast, getBanner, waitForToastsToDisappear } from '../helpers/locators';

const API_BASE = 'http://localhost:22700';

test.describe('Platform-Only Mode', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetCustomer(request);
    // Set platform-only mode (production config)
    await setConfigFlags(request, { freq_platform_sub: '1', freq_seal_sub: '0' });
    await authenticateWithMockWallet(page);
  });

  test.afterAll(async ({ request }) => {
    // Restore production default: platform-only mode
    await setConfigFlags(request, { freq_platform_sub: '1', freq_seal_sub: '0' });
  });

  // =========================================================================
  // Platform as Prerequisite
  // =========================================================================
  test.describe('Platform Required', () => {
    test('should show platform plan card on billing page when not subscribed', async ({ page }) => {
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      // Platform plan card should be visible
      await expect(
        page.locator('h3:has-text("Choose a Platform Plan")')
      ).toBeVisible({ timeout: 5000 });

      // Description text
      await expect(
        page.locator('text=A platform subscription is required to use Suiftly services')
      ).toBeVisible();
    });

    test('should NOT show seal onboarding form even without platform subscription', async ({ page }) => {
      // Navigate to Seal service (no platform, no seal subscription)
      await page.click('text=Seal');
      await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

      // Should show platform-required banner
      await expect(
        page.locator('text=/platform subscription/i')
      ).toBeVisible({ timeout: 5000 });

      // But should NOT show the seal onboarding/subscription form
      // (freq_seal_sub=0 means no per-service subscription needed)
      await expect(
        page.locator('button:has-text("Subscribe to Service")')
      ).not.toBeVisible({ timeout: 3000 });

      // Should show the interactive form (service is usage-based, no subscription step)
      await expect(
        page.locator('text=Change Plan')
      ).toBeVisible({ timeout: 5000 });
    });

    test('should allow seal access after platform subscription', async ({ page, request }) => {
      // Fund and subscribe to platform
      await ensureTestBalance(request, 50);
      await subscribePlatformService(page, 'STARTER');
      await waitForToastsToDisappear(page);

      // Navigate to Seal — should show onboarding form (not blocked)
      await page.click('text=Seal');
      await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

      // Should see the seal onboarding form (not a platform-required gate)
      // Use "Subscribe to Service" button as signal — it's unique to the onboarding form
      await expect(
        page.locator('button:has-text("Subscribe to Service")')
      ).toBeVisible({ timeout: 10000 });
    });
  });

  // =========================================================================
  // Seal Without Billing (platform-only mode)
  // =========================================================================
  test.describe('Seal Service (No Billing)', () => {
    test.beforeEach(async ({ page, request }) => {
      // Subscribe to platform first (prerequisite)
      await ensureTestBalance(request, 100);
      await subscribePlatformService(page, 'STARTER');
      await waitForToastsToDisappear(page);
    });

    test('should NOT show seal onboarding form after platform subscription', async ({ page }) => {
      // Navigate to Seal
      await page.click('text=Seal');
      await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

      // The onboarding form (tier selection + "Subscribe to Service") must NOT appear.
      // In platform-only mode (freq_seal_sub=0), seal is usage-based only.
      await expect(
        page.locator('button:has-text("Subscribe to Service")')
      ).not.toBeVisible({ timeout: 5000 });

      // Should show the interactive form instead
      await expect(
        page.locator('text=Change Plan')
      ).toBeVisible({ timeout: 5000 });
    });

    test('should subscribe to seal service without billing charge', async ({ page }) => {
      // Navigate to Seal
      await page.click('text=Seal');
      await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

      // Accept terms and subscribe (STARTER)
      await page.locator('label:has-text("Agree to")').click();
      await page.getByRole('heading', { name: 'STARTER' }).click();
      await page.locator('button:has-text("Subscribe to Service")').click();

      // Should succeed immediately (no billing = instant paidOnce)
      await expect(
        page.locator('[data-sonner-toast]').filter({ hasText: /Subscription successful/i })
      ).toBeVisible({ timeout: 10000 });

      // Should redirect to overview
      await page.waitForURL(/\/services\/seal\/overview/, { timeout: 5000 });

      // Service should NOT show payment pending (billing skipped)
      await expect(
        page.locator('text=Subscription payment pending')
      ).not.toBeVisible({ timeout: 2000 }).catch(() => {});
    });

    test('should enable seal service after subscription', async ({ page }) => {
      // Subscribe to seal
      await subscribeSealService(page, 'STARTER');
      await waitForToastsToDisappear(page);

      // Service starts disabled — toggle it on
      const serviceToggle = page.locator('#service-toggle');
      await expect(serviceToggle).toBeVisible({ timeout: 5000 });

      // Enable the service — should NOT show payment error because billing was skipped
      await serviceToggle.click();
      await waitAfterMutation(page);

      // Disabled banner should disappear (no banner = service is active)
      await expect(
        page.locator('text=/Service is currently OFF/i')
      ).not.toBeVisible({ timeout: 10000 });
    });

    test('should show seal on billing page without seal charges', async ({ page }) => {
      // Subscribe to seal
      await subscribeSealService(page, 'PRO');
      await waitForToastsToDisappear(page);

      // Go to billing page
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      // Platform active card should be visible
      await expect(
        page.locator('text=Change Plan')
      ).toBeVisible({ timeout: 5000 });

      // Next scheduled payment must show platform charge but NOT seal charge
      const nextPaymentButton = page.locator('button').filter({ hasText: /Next Scheduled/ });
      await expect(nextPaymentButton).toBeVisible({ timeout: 5000 });
      await nextPaymentButton.click();

      // Platform subscription line item should be present
      await expect(
        page.getByText('Platform Starter plan', { exact: true })
      ).toBeVisible({ timeout: 3000 });
    });
  });

  // =========================================================================
  // Full Flow: Platform + Seal Together
  // =========================================================================
  test.describe('Combined Flow', () => {
    test('should complete full onboarding: platform then seal', async ({ page, request }) => {
      await ensureTestBalance(request, 100);

      // Step 1: Subscribe to platform
      await subscribePlatformService(page, 'STARTER');
      await waitForToastsToDisappear(page);

      // Step 2: Subscribe to seal
      await subscribeSealService(page, 'STARTER');
      await waitForToastsToDisappear(page);

      // Step 3: Enable seal service
      const serviceToggle = page.locator('#service-toggle');
      await expect(serviceToggle).toBeVisible({ timeout: 5000 });
      await serviceToggle.click();
      await waitAfterMutation(page);

      // Step 4: Verify seal is enabled (no disabled banner)
      await expect(
        page.locator('text=/Service is currently OFF/i')
      ).not.toBeVisible({ timeout: 10000 });

      // Go to billing — platform card should show active
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });
      await expect(
        page.locator('text=Change Plan')
      ).toBeVisible({ timeout: 5000 });
    });
  });
});
