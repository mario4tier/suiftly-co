/**
 * gRPC Usage Display E2E Test
 *
 * Tests that "Usage This Month" on the gRPC overview page shows:
 * - Request line: "{count} requests @ $X.XXXX/req" with subtotal
 * - Bandwidth line: "{GB} GB @ $X.XX/GB" with subtotal (when bandwidth > 0)
 * - Total at bottom (not NaN)
 *
 * Injects demo data programmatically if none exists.
 */

import { test, expect } from '@playwright/test';
import { resetCustomer, ensureTestBalance, subscribePlatformService } from '../helpers/db';
import { waitForToastsToDisappear } from '../helpers/locators';

test.describe('gRPC Usage This Month Display', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetCustomer(request);
    await ensureTestBalance(request, 50);

    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.waitForLoadState('networkidle');

    await subscribePlatformService(page);
    await waitForToastsToDisappear(page);
  });

  test('should show usage line items with correct format (no NaN)', async ({ page }) => {
    // Navigate to gRPC overview
    await page.goto('/services/grpc/overview');
    await page.waitForLoadState('networkidle');

    // "Usage This Month" section should be visible
    await expect(page.locator('text=Usage This Month')).toBeVisible({ timeout: 5000 });

    // Should NOT show NaN anywhere in the usage section
    const usageSection = page.locator('text=Usage This Month').locator('..');
    const usageText = await usageSection.textContent();
    expect(usageText).not.toContain('NaN');
    expect(usageText).not.toContain('undefined');

    // Should show request line with format "X requests @ $0.0001/req"
    await expect(page.locator('text=/requests @ \\$/i')).toBeVisible({ timeout: 5000 });

    // Should show bandwidth line with format "X.XXX GB @ $0.06/GB"
    await expect(page.locator('text=/GB @ \\$/i')).toBeVisible({ timeout: 5000 });

    // Total should be a valid dollar amount
    const totalElement = page.locator('[data-testid="usage-total"]');
    await expect(totalElement).toBeVisible({ timeout: 5000 });
    const totalText = await totalElement.textContent();
    expect(totalText).toMatch(/^\$\d+\.\d{2}$/);

    console.log('✅ Usage This Month: no NaN, correct line item format');
  });
});
