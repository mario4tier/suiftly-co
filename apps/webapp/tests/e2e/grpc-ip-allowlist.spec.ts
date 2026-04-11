/**
 * gRPC IP Allowlist E2E Tests
 *
 * Tests comprehensive IP validation with Save/Cancel workflow:
 * 1. IPv4-only validation (no IPv6)
 * 2. CIDR validation (only /32 or none allowed)
 * 3. Real-time validation feedback
 * 4. Save/Cancel button behavior (buttons disappear after save)
 * 5. Formatting (comma+space separated)
 * 6. Database persistence
 * 7. No placeholder text when empty (regression test)
 *
 * Mirrors seal-ip-allowlist.spec.ts for consistent behavior.
 */

import { test, expect, type Page } from '@playwright/test';
import { waitForToastsToDisappear } from '../helpers/locators';
import { subscribePlatformService } from '../helpers/db';

/** Click "Save Changes" and wait for the API mutation response + UI to settle */
async function saveAndWaitForCompletion(page: Page) {
  const saveResponse = page.waitForResponse(
    (resp) => resp.url().includes('/i/api') && resp.request().method() === 'POST' && resp.ok()
  );
  await page.locator('button:has-text("Save Changes")').click();
  await saveResponse;
  await expect(page.locator('button:has-text("Save Changes")')).not.toBeVisible({ timeout: 10000 });
}

test.describe('gRPC IP Allowlist - Validation & Save/Cancel', () => {
  test.beforeEach(async ({ page, request }) => {
    // Setup test environment
    await request.post('http://localhost:22700/test/delays/clear');
    await request.post('http://localhost:22700/test/data/reset', {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 50000,
      },
    });

    await request.post('http://localhost:22700/test/wallet/deposit', {
      data: {
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        amountUsd: 50,
        initialSpendingLimitUsd: 500,
      },
    });

    await page.context().clearCookies();
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForTimeout(500);
    await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.waitForLoadState('networkidle');

    // Subscribe to platform PRO (IP allowlist requires Pro tier)
    await subscribePlatformService(page, 'PRO');

    // Navigate to gRPC overview
    await page.goto('/services/grpc/overview');
    await page.waitForLoadState('networkidle');
    await waitForToastsToDisappear(page);

    // Navigate to More Settings tab
    await page.click('button[role="tab"]:has-text("More Settings")');
    await expect(page.locator('#ip-allowlist-toggle')).toBeVisible({ timeout: 5000 });

    // Enable IP allowlist
    await page.locator('#ip-allowlist-toggle').click();
    await expect(page.locator('#ip-allowlist-toggle')).toHaveAttribute('data-state', 'checked', { timeout: 5000 });
    await expect(page.locator('#ip-allowlist')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(500);
  });

  test('empty allowlist shows no placeholder text', async ({ page }) => {
    const textarea = page.locator('#ip-allowlist');

    // Textarea should be empty with no placeholder/greyed out text
    const value = await textarea.inputValue();
    expect(value).toBe('');

    // Verify no placeholder attribute leaking content
    const placeholder = await textarea.getAttribute('placeholder');
    expect(placeholder ?? '').toBe('');

    console.log('✅ Empty allowlist shows no placeholder text');
  });

  test('accepts valid IPv4 addresses and shows Save button', async ({ page }) => {
    const textarea = page.locator('#ip-allowlist');

    await textarea.fill('192.168.1.1');
    await page.waitForTimeout(300);

    await expect(page.locator('button:has-text("Save Changes")')).toBeVisible();
    // No validation errors
    await expect(page.locator('text=/Validation Errors/i')).not.toBeVisible();

    console.log('✅ Valid IP accepted, Save button visible');
  });

  test('rejects CIDR ranges other than /32', async ({ page }) => {
    const textarea = page.locator('#ip-allowlist');

    await textarea.fill('192.168.1.0/24');
    await page.waitForTimeout(300);

    await expect(page.locator('text=/CIDR/i')).toBeVisible();
    console.log('✅ CIDR /24 rejected');
  });

  test('accepts /32 CIDR notation and normalizes it', async ({ page, request }) => {
    const textarea = page.locator('#ip-allowlist');

    await textarea.fill('192.168.1.1/32');
    await page.waitForTimeout(300);

    // No validation errors
    await expect(page.locator('text=/Validation Errors/i')).not.toBeVisible();

    await saveAndWaitForCompletion(page);

    // Verify database has normalized IP
    const serviceData = await (await request.get('http://localhost:22700/test/data/service-instance?serviceType=grpc')).json();
    expect(serviceData.config.ipAllowlist).toEqual(['192.168.1.1']);

    console.log('✅ /32 accepted and normalized to plain IP');
  });

  test('Save/Cancel buttons only appear when there are changes', async ({ page }) => {
    const textarea = page.locator('#ip-allowlist');

    // Initially no Save/Cancel buttons
    await expect(page.locator('button:has-text("Save Changes")')).not.toBeVisible();
    await expect(page.locator('button:has-text("Cancel")')).not.toBeVisible();

    // Make a change
    await textarea.fill('192.168.1.1');
    await page.waitForTimeout(300);

    // Buttons should appear
    await expect(page.locator('button:has-text("Save Changes")')).toBeVisible();
    await expect(page.locator('button:has-text("Cancel")')).toBeVisible();

    console.log('✅ Save/Cancel buttons appear only when there are changes');
  });

  test('Save buttons disappear after successful save', async ({ page }) => {
    const textarea = page.locator('#ip-allowlist');

    await textarea.fill('192.168.1.1');
    await page.waitForTimeout(300);

    // Buttons visible
    await expect(page.locator('button:has-text("Save Changes")')).toBeVisible();

    // Save
    await saveAndWaitForCompletion(page);

    // Buttons should be gone
    await expect(page.locator('button:has-text("Save Changes")')).not.toBeVisible();
    await expect(page.locator('button:has-text("Cancel")')).not.toBeVisible();

    console.log('✅ Buttons disappear after successful save');
  });

  test('Cancel button reverts changes', async ({ page }) => {
    const textarea = page.locator('#ip-allowlist');

    // Save an initial IP
    await textarea.fill('192.168.1.1');
    await saveAndWaitForCompletion(page);
    await page.waitForLoadState('networkidle');
    await expect(textarea).toHaveValue('192.168.1.1', { timeout: 5000 });

    // Make a new change
    await textarea.fill('192.168.1.1, 10.0.0.1');

    // Click Cancel
    await page.locator('button:has-text("Cancel")').click();
    await page.waitForTimeout(300);

    // Should revert to saved value
    expect(await textarea.inputValue()).toBe('192.168.1.1');

    // Buttons should disappear
    await expect(page.locator('button:has-text("Save Changes")')).not.toBeVisible();

    console.log('✅ Cancel reverts to saved state');
  });

  test('validates and saves multiple IPs with proper formatting', async ({ page, request }) => {
    const textarea = page.locator('#ip-allowlist');

    await textarea.fill('192.168.1.1, 10.0.0.1');
    await page.waitForTimeout(300);

    await expect(page.locator('text=/Validation Errors/i')).not.toBeVisible();

    await saveAndWaitForCompletion(page);

    // Verify database
    const serviceData = await (await request.get('http://localhost:22700/test/data/service-instance?serviceType=grpc')).json();
    expect(serviceData.config.ipAllowlist).toHaveLength(2);
    expect(serviceData.config.ipAllowlist).toContain('192.168.1.1');
    expect(serviceData.config.ipAllowlist).toContain('10.0.0.1');

    // Verify formatting in UI
    await expect(textarea).toHaveValue('192.168.1.1, 10.0.0.1', { timeout: 5000 });

    console.log('✅ Multiple IPs saved and formatted correctly');
  });

  test('enforces tier limit (Pro: max 2 IPv4)', async ({ page }) => {
    const textarea = page.locator('#ip-allowlist');

    await textarea.fill('192.168.1.1, 192.168.1.2, 192.168.1.3');
    await page.waitForTimeout(300);

    // Try to save (fails due to tier limit)
    await page.locator('button:has-text("Save Changes")').click();
    await expect(page.locator('text=/Maximum.*IPv4/i')).toBeVisible({ timeout: 5000 });

    console.log('✅ Tier limit enforced on save');
  });
});
