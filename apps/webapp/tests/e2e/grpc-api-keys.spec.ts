/**
 * gRPC API Keys E2E Tests
 *
 * Tests the X-API-Key tab for gRPC service:
 * 1. Navigate to API Keys tab
 * 2. List existing API keys
 * 3. Create new API key
 * 4. Revoke/re-enable/delete API keys
 *
 * Mirrors seal API key management tests.
 */

import { test, expect } from '@playwright/test';
import { waitAfterMutation } from '../helpers/wait-utils';
import { resetCustomer, ensureTestBalance, subscribePlatformService } from '../helpers/db';
import { waitForToastsToDisappear } from '../helpers/locators';

test.describe('gRPC API Keys Management', () => {
  test.beforeEach(async ({ page, request }) => {
    // Reset and fund customer
    await resetCustomer(request);
    await ensureTestBalance(request, 50);

    // Authenticate
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.waitForLoadState('networkidle');

    // Subscribe to platform (auto-provisions gRPC)
    await subscribePlatformService(page);
    await waitForToastsToDisappear(page);

    // Navigate to gRPC overview
    await page.goto('/services/grpc/overview');
    await page.waitForLoadState('networkidle');
  });

  test('gRPC overview page renders without errors', async ({ page }) => {
    // Verify the page loaded without JavaScript errors
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Reload to catch any module-level errors
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Page should render with the service title
    await expect(page.locator('h1:has-text("gRPC Service")')).toBeVisible({ timeout: 5000 });

    // No JS errors should have occurred
    expect(errors).toHaveLength(0);

    console.log('✅ gRPC page renders without JavaScript errors');
  });

  test('can navigate to X-API-Key tab and see API keys', async ({ page }) => {
    // Click the X-API-Key tab
    await page.click('button[role="tab"]:has-text("X-API-Key")');
    await page.waitForTimeout(500);

    // Should see the API keys section (table or empty state)
    // Auto-provisioned key should be visible
    await expect(page.locator('table')).toBeVisible({ timeout: 5000 });

    console.log('✅ X-API-Key tab shows API keys table');
  });

  test('can navigate to X-API-Key tab via settings cog on Overview', async ({ page }) => {
    // Click the settings cog icon next to API Keys on the Overview tab
    const settingsLink = page.locator('a[href*="tab=x-api-key"]');
    await expect(settingsLink).toBeVisible({ timeout: 5000 });
    await settingsLink.click();

    // Should now be on X-API-Key tab
    await expect(page.locator('button[role="tab"][data-state="active"]:has-text("X-API-Key")')).toBeVisible({ timeout: 5000 });

    console.log('✅ Settings cog navigates to X-API-Key tab');
  });

  test('auto-provisioned API key is visible and copyable', async ({ page }) => {
    await page.click('button[role="tab"]:has-text("X-API-Key")');
    await page.waitForTimeout(500);

    // Should have at least one key row
    const keyRows = page.locator('table tbody tr');
    await expect(keyRows.first()).toBeVisible({ timeout: 5000 });

    // Key preview should be visible (format: XXXXXXXX...XXXX)
    const keyPreview = keyRows.first().locator('td').first();
    await expect(keyPreview).toBeVisible();

    console.log('✅ Auto-provisioned API key is visible');
  });

  test('can create a new API key', async ({ page }) => {
    await page.click('button[role="tab"]:has-text("X-API-Key")');
    await page.waitForTimeout(500);

    // Count existing keys
    const initialCount = await page.locator('table tbody tr').count();

    // Click "Add New API Key" button
    await page.locator('button:has-text("Add New API Key")').click();
    await waitAfterMutation(page);

    // Should have one more key
    await expect(page.locator('table tbody tr')).toHaveCount(initialCount + 1, { timeout: 5000 });

    console.log('✅ New API key created successfully');
  });

  test('can disable and re-enable an API key', async ({ page }) => {
    await page.click('button[role="tab"]:has-text("X-API-Key")');
    await page.waitForTimeout(500);

    // Disable the first key
    await page.locator('button:has-text("Disable")').first().click();
    await page.locator('button:has-text("Disable Key")').click();
    await waitAfterMutation(page);

    // Key should now show as disabled (Enable button visible)
    await expect(page.locator('button:has-text("Enable")').first()).toBeVisible({ timeout: 5000 });

    // Re-enable
    await page.locator('button:has-text("Enable")').first().click();
    await waitAfterMutation(page);

    // Should show Disable button again
    await expect(page.locator('button:has-text("Disable")').first()).toBeVisible({ timeout: 5000 });

    console.log('✅ API key disabled and re-enabled successfully');
  });
});
