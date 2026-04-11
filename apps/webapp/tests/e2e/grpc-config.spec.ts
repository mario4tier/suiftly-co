/**
 * gRPC Service Configuration E2E Test
 * Tests the gRPC service management UI after platform subscription.
 *
 * After platform subscription, gRPC is auto-provisioned (disabled by default).
 * Tests verify the interactive management form (toggle + config) is shown,
 * and that enabling/disabling the service works.
 */

import { test, expect } from '@playwright/test';
import { waitAfterMutation } from '../helpers/wait-utils';
import { resetCustomer, ensureTestBalance, subscribePlatformService } from '../helpers/db';
import { waitForToastsToDisappear } from '../helpers/locators';

test.describe('gRPC Service Management UI', () => {
  test.beforeEach(async ({ page, request }) => {
    // Reset and fund customer
    await resetCustomer(request);
    await ensureTestBalance(request, 50);

    // Authenticate
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.waitForLoadState('networkidle');

    // Subscribe to platform (auto-provisions gRPC as disabled)
    await subscribePlatformService(page);
    await waitForToastsToDisappear(page);

    // Navigate to gRPC overview
    await page.goto('/services/grpc/overview');
    await page.waitForLoadState('networkidle');
  });

  test('gRPC page shows service toggle after platform subscribe', async ({ page }) => {
    await expect(page.locator('#service-toggle')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#service-toggle')).toHaveAttribute('aria-checked', 'false');
    console.log('✅ gRPC page shows service toggle in disabled state');
  });

  test('enabling gRPC service transitions to enabled state', async ({ page }) => {
    await page.locator('#service-toggle').click();
    await waitAfterMutation(page);
    await expect(page.locator('#service-toggle')).toHaveAttribute('aria-checked', 'true', { timeout: 5000 });
    console.log('✅ gRPC service enabled successfully via toggle');
  });

  test('disabling gRPC service transitions back to disabled state', async ({ page }) => {
    // Enable first
    await page.locator('#service-toggle').click();
    await waitAfterMutation(page);
    await expect(page.locator('#service-toggle')).toHaveAttribute('aria-checked', 'true', { timeout: 5000 });

    // Disable
    await page.locator('#service-toggle').click();
    await waitAfterMutation(page);
    await expect(page.locator('#service-toggle')).toHaveAttribute('aria-checked', 'false', { timeout: 5000 });
    console.log('✅ gRPC service disabled successfully via toggle');
  });

  test('gRPC tabs are visible after platform subscribe', async ({ page }) => {
    await expect(page.locator('button[role="tab"]:has-text("Overview")')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button[role="tab"]:has-text("X-API-Key")')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button[role="tab"]:has-text("More Settings")')).toBeVisible({ timeout: 5000 });

    // gRPC does NOT have Seal Keys tab (simplified version)
    await expect(page.locator('button[role="tab"]:has-text("Seal Keys")')).not.toBeVisible();
    console.log('✅ gRPC tabs visible (Overview, X-API-Key, More Settings) - no Seal Keys');
  });

  test('config-needed banner shows when all API keys revoked', async ({ page }) => {
    // Enable gRPC service
    await page.locator('#service-toggle').click();
    await waitAfterMutation(page);

    // Go to API Key tab and revoke the auto-provisioned key
    await page.click('button[role="tab"]:has-text("X-API-Key")');
    await page.waitForTimeout(500);

    // Click "Disable" button on the API key row
    await page.locator('button:has-text("Disable")').first().click();
    // Confirm the disable dialog
    await page.locator('button:has-text("Disable Key")').click();
    await waitAfterMutation(page);

    // Go back to Overview tab
    await page.click('button[role="tab"]:has-text("Overview")');
    await page.waitForTimeout(500);

    // Should show config-needed banner
    await expect(page.locator('[data-testid="config-needed-banner"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="config-needed-banner"]')).toContainText('No active API key');
    console.log('✅ Config-needed banner shows "No active API key" after revoking all keys');
  });

  test('page refresh maintains service state', async ({ page }) => {
    // Enable
    await page.locator('#service-toggle').click();
    await waitAfterMutation(page);
    await expect(page.locator('#service-toggle')).toHaveAttribute('aria-checked', 'true', { timeout: 5000 });

    // Refresh
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Should still be enabled
    await expect(page.locator('#service-toggle')).toHaveAttribute('aria-checked', 'true', { timeout: 5000 });
    console.log('✅ Service state persists across page refresh');
  });
});
