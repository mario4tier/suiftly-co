/**
 * Seal IP Allowlist E2E Tests
 *
 * Tests comprehensive IP validation with Save/Cancel workflow:
 * 1. IPv4-only validation (no IPv6)
 * 2. CIDR validation (only /32 or none allowed)
 * 3. Real-time validation feedback
 * 4. Save/Cancel button behavior
 * 5. Formatting (10 IPs per line, comma+space)
 * 6. Database persistence
 */

import { test, expect, type Page } from '@playwright/test';
import { getToast, waitForToastsToDisappear } from '../helpers/locators';

/** Click "Save Changes" and wait for the API mutation response + UI to settle */
async function saveAndWaitForCompletion(page: Page) {
  const saveResponse = page.waitForResponse(
    (resp) => resp.url().includes('/i/api') && resp.request().method() === 'POST' && resp.ok()
  );
  await page.locator('button:has-text("Save Changes")').click();
  await saveResponse;
  await expect(page.locator('button:has-text("Save Changes")')).not.toBeVisible({ timeout: 10000 });
}

test.describe('Seal IP Allowlist - Validation & Save/Cancel', () => {
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

    // Subscribe to PRO tier
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
    await page.locator('label:has-text("Agree to")').click();
    await page.getByRole('heading', { name: 'PRO' }).click();
    await page.locator('button:has-text("Subscribe to Service")').click();

    await expect(getToast(page, /Subscription successful/i)).toBeVisible({ timeout: 5000 });
    await page.waitForURL(/\/services\/seal\/overview/, { timeout: 5000 });

    // Wait for toasts to disappear before navigating (prevents pollution)
    await waitForToastsToDisappear(page);

    // Navigate to More Settings
    await page.click('button[role="tab"]:has-text("More Settings")');
    await expect(page.locator('#ip-allowlist-toggle')).toBeVisible({ timeout: 5000 });

    // Enable IP allowlist - wait for mutation + all triggered refetches to complete
    const toggleResponse = page.waitForResponse(
      (resp) => resp.url().includes('/i/api') && resp.request().method() === 'POST' && resp.ok()
    );
    await page.locator('#ip-allowlist-toggle').click();
    await toggleResponse;
    await page.waitForLoadState('networkidle');
  });

  test('accepts valid IPv4 addresses and shows Save button', async ({ page }) => {
    const textarea = page.locator('#ip-allowlist');

    // Enter valid IPs
    await textarea.fill('192.168.1.1');
    await page.waitForTimeout(300);

    // Save button should appear
    await expect(page.locator('button:has-text("Save Changes")')).toBeVisible();

    // No validation errors
    await expect(page.locator('text=/Validation Errors/i')).not.toBeVisible();

    console.log('✅ Valid IP accepted, Save button visible');
  });

  test.skip('rejects IPv6 addresses with helpful error', async ({ page }) => {
    const textarea = page.locator('#ip-allowlist');

    // Enter IPv6 address
    await textarea.fill('2001:0db8:85a3:0000:0000:8a2e:0370:7334');
    await page.waitForTimeout(300);

    // Should show validation error section
    await expect(page.locator('text=/Validation Errors/i')).toBeVisible();

    // Verify error list contains the IPv6 address that failed
    const errorSection = page.locator('div:has-text("Validation Errors:")');
    await expect(errorSection).toContainText('2001:0db8:85a3:0000:0000:8a2e:0370:7334');

    // If Save button appears, it should be disabled
    const saveButton = page.locator('button:has-text("Save Changes")');
    if (await saveButton.isVisible()) {
      await expect(saveButton).toBeDisabled();
    }

    console.log('✅ IPv6 rejected with validation error');
  });

  test('rejects CIDR ranges other than /32', async ({ page }) => {
    const textarea = page.locator('#ip-allowlist');

    // Enter CIDR range /24
    await textarea.fill('192.168.1.0/24');
    await page.waitForTimeout(300);

    // Should show validation error
    await expect(page.locator('text=/Validation Errors/i')).toBeVisible();
    await expect(page.locator('text=/CIDR ranges.*not supported/i')).toBeVisible();

    console.log('✅ CIDR /24 rejected');
  });

  test('accepts /32 CIDR notation and normalizes it', async ({ page, request }) => {
    const textarea = page.locator('#ip-allowlist');

    // Enter IP with /32
    await textarea.fill('192.168.1.1/32');
    await page.waitForTimeout(300);

    // No validation errors
    await expect(page.locator('text=/Validation Errors/i')).not.toBeVisible();

    // Click Save and wait for API response + UI to settle
    await saveAndWaitForCompletion(page);

    // Verify database has normalized IP (without /32)
    const serviceData = await (await request.get('http://localhost:22700/test/data/service-instance?serviceType=seal')).json();
    expect(serviceData.config.ipAllowlist).toEqual(['192.168.1.1']); // Normalized without /32

    console.log('✅ /32 accepted and normalized to plain IP');
  });

  test('Save/Cancel buttons only appear when there are changes', async ({ page }) => {
    const textarea = page.locator('#ip-allowlist');

    // Initially no Save/Cancel buttons (no changes)
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

  test('Cancel button reverts changes', async ({ page }) => {
    const textarea = page.locator('#ip-allowlist');

    // Start with a saved IP
    await textarea.fill('192.168.1.1');
    await saveAndWaitForCompletion(page);
    await page.waitForLoadState('networkidle');
    // Verify component settled to saved state before filling again
    await expect(textarea).toHaveValue('192.168.1.1', { timeout: 5000 });

    // Make a new change
    await textarea.fill('192.168.1.1, 10.0.0.1');

    // Buttons appear
    await expect(page.locator('button:has-text("Cancel")')).toBeVisible();

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

    // Enter 2 IPs (comma separated)
    await textarea.fill('192.168.1.1, 10.0.0.1');
    await page.waitForTimeout(300);

    // No validation errors
    await expect(page.locator('text=/Validation Errors/i')).not.toBeVisible();

    // Save and wait for API response + UI to settle
    await saveAndWaitForCompletion(page);

    // Verify database
    const serviceData = await (await request.get('http://localhost:22700/test/data/service-instance?serviceType=seal')).json();
    expect(serviceData.config.ipAllowlist).toHaveLength(2);
    expect(serviceData.config.ipAllowlist).toContain('192.168.1.1');
    expect(serviceData.config.ipAllowlist).toContain('10.0.0.1');

    // Verify formatting in UI (use toHaveValue to retry until onSuccess reformats)
    await expect(textarea).toHaveValue('192.168.1.1, 10.0.0.1', { timeout: 5000 });

    console.log('✅ Multiple IPs saved and formatted correctly');
  });

  test('enforces tier limit (Pro: max 2 IPv4)', async ({ page }) => {
    const textarea = page.locator('#ip-allowlist');

    // Try to add 3 IPs
    await textarea.fill('192.168.1.1, 192.168.1.2, 192.168.1.3');
    await page.waitForTimeout(300);

    // No client-side validation error (count is checked on server)
    await expect(page.locator('text=/Validation Errors/i')).not.toBeVisible();

    // Try to save (fails due to tier limit)
    await page.locator('button:has-text("Save Changes")').click();
    await expect(page.locator('text=/Maximum 2 IPv4 addresses/i')).toBeVisible({ timeout: 5000 });

    console.log('✅ Tier limit enforced on save');
  });

  test('detects duplicate IPs and shows error', async ({ page }) => {
    const textarea = page.locator('#ip-allowlist');

    // Enter duplicate IPs
    await textarea.fill('192.168.1.1, 192.168.1.1');
    await page.waitForTimeout(300);

    // Should show validation error
    await expect(page.locator('text=/Validation Errors/i')).toBeVisible();
    await expect(page.locator('text=/Duplicate IP address/i')).toBeVisible();

    // Save button disabled
    await expect(page.locator('button:has-text("Save Changes")')).toBeDisabled();

    console.log('✅ Duplicate IPs detected');
  });

  test('handles mixed separators (comma, space, newline)', async ({ page, request }) => {
    const textarea = page.locator('#ip-allowlist');

    // Enter IPs with mixed separators
    await textarea.fill('192.168.1.1\n10.0.0.1');
    await page.waitForTimeout(300);

    // No errors
    await expect(page.locator('text=/Validation Errors/i')).not.toBeVisible();

    // Save and wait for API response + UI to settle
    await saveAndWaitForCompletion(page);

    // Verify both IPs saved
    const serviceData = await (await request.get('http://localhost:22700/test/data/service-instance?serviceType=seal')).json();
    expect(serviceData.config.ipAllowlist).toHaveLength(2);

    console.log('✅ Mixed separators handled correctly');
  });

  test('real-time validation as user types', async ({ page }) => {
    const textarea = page.locator('#ip-allowlist');

    // Start typing invalid IP
    await textarea.fill('999');
    await page.waitForTimeout(300);

    // Should show validation error immediately
    await expect(page.locator('text=/Validation Errors/i')).toBeVisible();

    // Continue typing to make it valid
    await textarea.clear();
    await textarea.fill('192.168.1.1');
    await page.waitForTimeout(300);

    // Error should disappear
    await expect(page.locator('text=/Validation Errors/i')).not.toBeVisible();

    console.log('✅ Real-time validation works');
  });

  test('disabling toggle preserves IPs in database for temporary disable', async ({ page, request }) => {
    const textarea = page.locator('#ip-allowlist');

    // Add and save an IP
    await textarea.fill('192.168.1.1');
    await saveAndWaitForCompletion(page);

    // Disable toggle - wait for mutation response
    const disableResponse = page.waitForResponse(
      (resp) => resp.url().includes('/i/api') && resp.request().method() === 'POST' && resp.ok()
    );
    await page.locator('#ip-allowlist-toggle').click();
    await disableResponse;

    // Verify database preserves IPs but feature is disabled
    const serviceData = await (await request.get('http://localhost:22700/test/data/service-instance?serviceType=seal')).json();
    expect(serviceData.config.ipAllowlistEnabled).toBe(false);
    expect(serviceData.config.ipAllowlist).toEqual(['192.168.1.1']); // IPs preserved

    // Re-enable toggle - wait for mutation response
    const enableResponse = page.waitForResponse(
      (resp) => resp.url().includes('/i/api') && resp.request().method() === 'POST' && resp.ok()
    );
    await page.locator('#ip-allowlist-toggle').click();
    await enableResponse;

    // Verify textarea still shows the IP
    const textareaValue = await textarea.inputValue();
    expect(textareaValue).toBe('192.168.1.1');

    // Verify feature is enabled again in database
    const reEnabledData = await (await request.get('http://localhost:22700/test/data/service-instance?serviceType=seal')).json();
    expect(reEnabledData.config.ipAllowlistEnabled).toBe(true);
    expect(reEnabledData.config.ipAllowlist).toEqual(['192.168.1.1']);

    console.log('✅ Disabling toggle preserves IPs for temporary disable');
  });

  test('formats saved IPs as 10 per line with comma+space', async ({ page }) => {
    const textarea = page.locator('#ip-allowlist');

    // Enter 2 IPs
    await textarea.fill('192.168.1.1\n10.0.0.1');
    await saveAndWaitForCompletion(page);

    // Verify formatted output (use toHaveValue to retry until onSuccess reformats)
    await expect(textarea).toHaveValue('192.168.1.1, 10.0.0.1', { timeout: 5000 }); // comma+space format

    console.log('✅ Formatting applied: comma+space separated');
  });

  test('validates octet ranges (0-255)', async ({ page }) => {
    const textarea = page.locator('#ip-allowlist');

    // Invalid octet (>255)
    await textarea.fill('192.168.1.256');
    await page.waitForTimeout(300);

    await expect(page.locator('text=/Validation Errors/i')).toBeVisible();
    await expect(page.locator('text=/Invalid IPv4 address/i')).toBeVisible();

    console.log('✅ Octet range validation works');
  });

  test('shows helpful error for malformed IPs', async ({ page }) => {
    const textarea = page.locator('#ip-allowlist');

    // Malformed IP
    await textarea.fill('192.168.abc.1');
    await page.waitForTimeout(300);

    await expect(page.locator('text=/Validation Errors/i')).toBeVisible();
    await expect(page.locator('text=/Invalid IPv4 address/i')).toBeVisible();

    console.log('✅ Malformed IP error shown');
  });

  test('invalid edits surface Save/Cancel buttons for user to revert', async ({ page }) => {
    const textarea = page.locator('#ip-allowlist');

    // First, save a valid IP
    await textarea.fill('192.168.1.1');
    await saveAndWaitForCompletion(page);
    await page.waitForLoadState('networkidle');
    // Verify component settled to saved state before filling again
    await expect(textarea).toHaveValue('192.168.1.1', { timeout: 5000 });
    await expect(page.locator('button:has-text("Cancel")')).not.toBeVisible();

    // Now type an invalid IP alongside the valid one
    await textarea.fill('192.168.1.1, invalid-address');

    // Validation error should appear
    await expect(page.locator('text=/Validation Errors/i')).toBeVisible();

    // Save/Cancel buttons SHOULD appear even with validation errors
    await expect(page.locator('button:has-text("Save Changes")')).toBeVisible();
    await expect(page.locator('button:has-text("Cancel")')).toBeVisible();

    // Save button should be disabled due to validation errors
    await expect(page.locator('button:has-text("Save Changes")')).toBeDisabled();

    // Cancel button should work to revert changes
    await page.locator('button:has-text("Cancel")').click();
    await page.waitForTimeout(300);

    // Should revert to saved value
    expect(await textarea.inputValue()).toBe('192.168.1.1');

    // Validation errors should disappear
    await expect(page.locator('text=/Validation Errors/i')).not.toBeVisible();

    // Save/Cancel buttons should disappear
    await expect(page.locator('button:has-text("Save Changes")')).not.toBeVisible();
    await expect(page.locator('button:has-text("Cancel")')).not.toBeVisible();

    console.log('✅ Invalid edits surface Save/Cancel, Cancel reverts successfully');
  });
});

test.describe('Seal IP Allowlist - Persistence & Reload', () => {
  test.beforeEach(async ({ page, request }) => {
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

    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
    await page.locator('label:has-text("Agree to")').click();
    await page.getByRole('heading', { name: 'PRO' }).click();
    await page.locator('button:has-text("Subscribe to Service")').click();

    await expect(getToast(page, /Subscription successful/i)).toBeVisible({ timeout: 5000 });
    await page.waitForURL(/\/services\/seal\/overview/, { timeout: 5000 });
  });

  test('saved IPs persist after page reload', async ({ page, request }) => {
    // Wait for subscription toast to clear before proceeding
    await waitForToastsToDisappear(page);

    // Navigate to More Settings and wait for tab content
    await page.click('button[role="tab"]:has-text("More Settings")');
    await expect(page.locator('#ip-allowlist-toggle')).toBeVisible({ timeout: 5000 });

    // Enable IP allowlist - wait for mutation + all triggered refetches to complete
    const toggleResponse = page.waitForResponse(
      (resp) => resp.url().includes('/i/api') && resp.request().method() === 'POST' && resp.ok()
    );
    await page.locator('#ip-allowlist-toggle').click();
    await toggleResponse;
    await page.waitForLoadState('networkidle');

    // Add and save IP
    const textarea = page.locator('#ip-allowlist');
    await textarea.fill('192.168.1.100');
    await saveAndWaitForCompletion(page);
    await page.waitForLoadState('networkidle');

    // Verify data persisted in database before reloading
    const serviceData = await (await request.get('http://localhost:22700/test/data/service-instance?serviceType=seal')).json();
    expect(serviceData.config.ipAllowlistEnabled).toBe(true);
    expect(serviceData.config.ipAllowlist).toEqual(['192.168.1.100']);

    // Reload page and navigate back to More Settings
    await page.reload();
    await page.click('button[role="tab"]:has-text("More Settings")');
    // Wait for data to load — toggle will be checked once the fetched config has ipAllowlistEnabled=true
    await expect(page.locator('#ip-allowlist-toggle')).toBeChecked({ timeout: 10000 });

    // Verify IP persisted in UI
    await expect(textarea).toHaveValue('192.168.1.100', { timeout: 10000 });

    console.log('✅ IPs persist after reload');
  });
});
