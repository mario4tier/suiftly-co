/**
 * Seal Service Configuration E2E Test
 * Tests the seal service management UI after platform subscription.
 *
 * After platform subscription, seal is auto-provisioned (disabled by default).
 * Tests verify the interactive management form (toggle + config) is shown,
 * and that enabling/disabling the service works.
 */

import { test, expect } from '@playwright/test';
import { waitAfterMutation } from '../helpers/wait-utils';
import { resetCustomer, ensureTestBalance, subscribePlatformService } from '../helpers/db';
import { waitForToastsToDisappear } from '../helpers/locators';

test.describe('Seal Service Management UI', () => {
  test.beforeEach(async ({ page, request }) => {
    // Reset and fund customer
    await resetCustomer(request);
    await ensureTestBalance(request, 50);

    // Authenticate
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.waitForLoadState('networkidle');

    // Subscribe to platform (auto-provisions seal as disabled)
    await subscribePlatformService(page);
    await waitForToastsToDisappear(page);

    // Navigate to seal overview
    await page.goto('/services/seal/overview');
    await page.waitForLoadState('networkidle');
  });

  test('seal page shows service toggle after platform subscribe', async ({ page }) => {
    // Service toggle should be visible (service management UI)
    await expect(page.locator('#service-toggle')).toBeVisible({ timeout: 5000 });

    // Service should start as disabled (auto-provisioned but not enabled)
    await expect(page.locator('#service-toggle')).toHaveAttribute('aria-checked', 'false');

    // Should NOT show the old onboarding form heading
    await expect(page.locator('h3:has-text("Guaranteed Bandwidth")')).not.toBeVisible();

    console.log('✅ Seal page shows service toggle in disabled state after platform subscribe');
  });

  test('enabling seal service transitions to enabled state', async ({ page }) => {
    // Toggle service ON
    await page.locator('#service-toggle').click();
    await waitAfterMutation(page);

    // Service should now be enabled
    await expect(page.locator('#service-toggle')).toHaveAttribute('aria-checked', 'true', { timeout: 5000 });

    console.log('✅ Seal service enabled successfully via toggle');
  });

  test('disabling seal service transitions back to disabled state', async ({ page }) => {
    // Enable first
    await page.locator('#service-toggle').click();
    await waitAfterMutation(page);
    await expect(page.locator('#service-toggle')).toHaveAttribute('aria-checked', 'true', { timeout: 5000 });

    // Disable
    await page.locator('#service-toggle').click();
    await waitAfterMutation(page);
    await expect(page.locator('#service-toggle')).toHaveAttribute('aria-checked', 'false', { timeout: 5000 });

    console.log('✅ Seal service disabled successfully via toggle');
  });

  test('seal tabs are visible after platform subscribe', async ({ page }) => {
    // Service management tabs should be visible
    await expect(page.locator('button[role="tab"]:has-text("Overview")')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button[role="tab"]:has-text("X-API-Key")')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button[role="tab"]:has-text("Seal Keys")')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button[role="tab"]:has-text("More Settings")')).toBeVisible({ timeout: 5000 });

    console.log('✅ All seal management tabs are visible');
  });

  test('config-needed banner points to Seal Keys tab when no seal keys registered', async ({ page }) => {
    // Enable the service — API key exists (auto-provisioned) but no seal keys → config_needed
    await page.locator('#service-toggle').click();
    await waitAfterMutation(page);

    // Banner should appear with the seal key message
    const banner = page.locator('[data-testid="config-needed-banner"]');
    await expect(banner).toBeVisible({ timeout: 5000 });
    await expect(banner).toContainText('No seal keys registered');

    // Link must point to the Seal Keys tab, not the API Key tab
    await expect(banner.locator('a, [href]')).toContainText('Seal Keys tab');
    await expect(banner).not.toContainText('API Key tab');
  });

  test('config-needed banner points to API Key tab (and takes priority) when API key is disabled', async ({ page }) => {
    // Enable the service first
    await page.locator('#service-toggle').click();
    await waitAfterMutation(page);

    // Navigate to X-API-Key tab and disable the auto-created key
    await page.locator('[role="tab"]:has-text("X-API-Key")').click();
    await expect(page.locator('button:has-text("Disable")')).toBeVisible({ timeout: 5000 });
    await page.locator('button:has-text("Disable")').click();

    // Confirm the disable dialog
    await expect(page.locator('[role="alertdialog"]')).toBeVisible({ timeout: 3000 });
    await page.locator('[role="alertdialog"] button:has-text("Disable Key")').click();
    await waitAfterMutation(page);

    // Navigate back to Overview tab
    await page.locator('[role="tab"]:has-text("Overview")').click();

    // Banner must show API key error — takes priority over the seal key error
    const banner = page.locator('[data-testid="config-needed-banner"]');
    await expect(banner).toBeVisible({ timeout: 5000 });
    await expect(banner).toContainText('No active API key');

    // Link must point to the API Key tab, not Seal Keys tab
    await expect(banner.locator('a, [href]')).toContainText('API Key tab');
    await expect(banner).not.toContainText('Seal Keys tab');
  });

  test('page refresh after platform subscribe maintains service state', async ({ page }) => {
    // Service should be in disabled state
    await expect(page.locator('#service-toggle')).toHaveAttribute('aria-checked', 'false');

    // Refresh page
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Should still show management UI (not redirect to billing or show old form)
    await expect(page.locator('#service-toggle')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#service-toggle')).toHaveAttribute('aria-checked', 'false');

    // Old onboarding form should not reappear
    await expect(page.locator('h3:has-text("Guaranteed Bandwidth")')).not.toBeVisible();

    console.log('✅ Service state persists across page refresh');
  });
});

test.describe('Seal Burst Setting - Overview reflects More Settings', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetCustomer(request);
    await ensureTestBalance(request, 50);

    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.waitForLoadState('networkidle');

    // Subscribe to PRO tier (burst requires Pro)
    await subscribePlatformService(page, 'PRO');
    await waitForToastsToDisappear(page);

    await page.goto('/services/seal/overview');
    await page.waitForLoadState('networkidle');
  });

  test('overview shows burst enabled by default for Pro tier', async ({ page }) => {
    const burstRow = page.locator('tr', { has: page.locator('td:has-text("Burst")') });
    await expect(burstRow).toBeVisible({ timeout: 5000 });
    await expect(burstRow.locator('td').nth(1)).toHaveText('Enabled');
  });

  test('disabling burst in More Settings updates overview', async ({ page }) => {
    // Verify overview shows Enabled initially (Pro default)
    const burstRow = page.locator('tr', { has: page.locator('td:has-text("Burst")') });
    await expect(burstRow.locator('td').nth(1)).toHaveText('Enabled', { timeout: 5000 });

    // Go to More Settings and disable burst
    await page.click('button[role="tab"]:has-text("More Settings")');
    await expect(page.locator('#burst-toggle')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#burst-toggle')).toHaveAttribute('aria-checked', 'true');
    await page.locator('#burst-toggle').click();
    await waitAfterMutation(page);
    await expect(page.locator('#burst-toggle')).toHaveAttribute('aria-checked', 'false', { timeout: 5000 });

    // Go back to Overview — burst should now show Disabled
    await page.click('button[role="tab"]:has-text("Overview")');
    await expect(burstRow.locator('td').nth(1)).toHaveText('Disabled', { timeout: 5000 });
  });

  test('enabling burst in More Settings updates overview', async ({ page }) => {
    // First disable burst
    await page.click('button[role="tab"]:has-text("More Settings")');
    await expect(page.locator('#burst-toggle')).toBeVisible({ timeout: 5000 });
    await page.locator('#burst-toggle').click();
    await waitAfterMutation(page);
    await expect(page.locator('#burst-toggle')).toHaveAttribute('aria-checked', 'false', { timeout: 5000 });

    // Re-enable burst
    await page.locator('#burst-toggle').click();
    await waitAfterMutation(page);
    await expect(page.locator('#burst-toggle')).toHaveAttribute('aria-checked', 'true', { timeout: 5000 });

    // Go back to Overview — burst should show Enabled
    await page.click('button[role="tab"]:has-text("Overview")');
    const burstRow = page.locator('tr', { has: page.locator('td:has-text("Burst")') });
    await expect(burstRow.locator('td').nth(1)).toHaveText('Enabled', { timeout: 5000 });
  });
});
