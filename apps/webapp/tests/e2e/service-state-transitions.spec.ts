/**
 * Service State Transitions E2E Test
 * Tests the service state machine under the platform-only subscription model.
 *
 * State machine:
 * - Platform not subscribed: billing page shows "Choose a Platform Plan"
 * - Platform subscribed → seal auto-provisioned in disabled state
 * - User enables seal via toggle → enabled state
 *
 * Note: There is no longer a per-service subscription form for Seal.
 */

import { test, expect } from '@playwright/test';
import { ensureTestBalance, subscribePlatformService } from '../helpers/db';
import { waitAfterMutation } from '../helpers/wait-utils';

test.describe('Service State Transitions', () => {
  test.beforeEach(async ({ page, request }) => {
    // Reset customer test data
    await request.post('http://localhost:22700/test/data/reset', {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 25000,
      },
    });

    // Create escrow account and deposit funds
    await request.post('http://localhost:22700/test/wallet/deposit', {
      data: {
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        amountUsd: 1000,
        initialSpendingLimitUsd: 250,
      },
    });

    // Authenticate
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.waitForLoadState('networkidle');
  });

  test.afterEach(async ({ page }) => {
    await page.request.post('http://localhost:22700/test/delays/clear');
  });

  test('billing page shows platform plan card before subscription', async ({ page }) => {
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Should show platform plan selection form
    await expect(page.locator('h3:has-text("Choose a Platform Plan")')).toBeVisible();

    // Subscribe button should be disabled until TOS accepted
    await expect(page.locator('button:has-text("Subscribe to")')).toBeDisabled();

    console.log('✅ Before subscription: billing page shows platform plan card');
  });

  test('after platform subscribe, seal is auto-provisioned in disabled state', async ({ page }) => {
    // Subscribe to platform (auto-provisions seal)
    await subscribePlatformService(page);

    // Navigate to seal overview
    await page.goto('/services/seal/overview');
    await page.waitForLoadState('networkidle');

    // Seal should be in disabled state
    const toggle = page.locator('#service-toggle');
    await expect(toggle).toBeVisible({ timeout: 5000 });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    // Should show service management UI (not platform plan card)
    await expect(page.locator('h3:has-text("Choose a Platform Plan")')).not.toBeVisible();

    console.log('✅ After platform subscribe: seal is disabled and service management UI shown');
  });

  test('enabling seal service transitions to enabled state', async ({ page }) => {
    await subscribePlatformService(page);

    await page.goto('/services/seal/overview');
    await page.waitForLoadState('networkidle');

    // Toggle seal ON
    const toggle = page.locator('#service-toggle');
    await toggle.click();
    await waitAfterMutation(page);

    // Should be enabled
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 5000 });

    console.log('✅ Seal transitions to enabled state via toggle');
  });

  test('service management tabs are visible after platform subscribe', async ({ page }) => {
    await subscribePlatformService(page);

    await page.goto('/services/seal/overview');
    await page.waitForLoadState('networkidle');

    // All management tabs should be visible
    await expect(page.locator('button[role="tab"]:has-text("Overview")')).toBeVisible();
    await expect(page.locator('button[role="tab"]:has-text("X-API-Key")')).toBeVisible();
    await expect(page.locator('button[role="tab"]:has-text("Seal Keys")')).toBeVisible();
    await expect(page.locator('button[role="tab"]:has-text("More Settings")')).toBeVisible();

    console.log('✅ All service management tabs visible after platform subscribe');
  });

  test('page refresh after platform subscribe maintains service state', async ({ page }) => {
    await subscribePlatformService(page);

    await page.goto('/services/seal/overview');
    await page.waitForLoadState('networkidle');

    // Verify disabled state
    await expect(page.locator('#service-toggle')).toHaveAttribute('aria-checked', 'false');

    // Refresh
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Should still show management UI
    await expect(page.locator('#service-toggle')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#service-toggle')).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('h3:has-text("Choose a Platform Plan")')).not.toBeVisible();

    console.log('✅ Service state persists across page refresh');
  });
});
