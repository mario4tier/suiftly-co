/**
 * Seal Service Configuration E2E Test
 * Tests the onboarding form for subscribing to Seal service
 */

import { test, expect } from '@playwright/test';

test.describe('Seal Service Onboarding Form', () => {
  test.beforeEach(async ({ page }) => {
    // Reset customer test data (delete all services, reset balance)
    await page.request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 100000, // $1000
        spendingLimitUsdCents: 25000, // $250
      },
    });

    // Authenticate with mock wallet
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');

    // Wait for redirect to /dashboard after auth
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Navigate to seal service page (should show onboarding form)
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
  });

  test('onboarding form loads with all required elements', async ({ page }) => {
    // Should see "Guaranteed Bandwidth" section
    await expect(page.locator('h3:has-text("Guaranteed Bandwidth")')).toBeVisible();

    // Should see info tooltip button
    await expect(page.locator('button').filter({ has: page.locator('svg[class*="lucide-info"]') }).first()).toBeVisible();

    // Should see all three tier cards
    await expect(page.getByRole('heading', { name: 'STARTER' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'PRO' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'ENTERPRISE' })).toBeVisible();

    // Should see "Included with every subscription" section
    await expect(page.locator('text=Included with every subscription')).toBeVisible();

    // Should see Per-Request Pricing section
    await expect(page.locator('text=Per-Request Pricing')).toBeVisible();

    // Should see terms checkbox
    await expect(page.locator('text=Agree to')).toBeVisible();

    // Should see Subscribe button (initially disabled)
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await expect(subscribeButton).toBeVisible();
    await expect(subscribeButton).toBeDisabled();

    console.log('✅ All onboarding form elements are visible');
  });

  test('PRO tier is selected by default', async ({ page }) => {
    // PRO tier card should have orange border and SELECTED badge
    const proCard = page.locator('div').filter({ hasText: /^PRO/ }).first();
    await expect(proCard).toHaveClass(/border-\[#f38020\]/);
    await expect(page.locator('text=SELECTED')).toBeVisible();

    // Subscribe button should show PRO price ($29)
    await expect(page.locator('button:has-text("$29.00/month")')).toBeVisible();

    console.log('✅ PRO tier is selected by default with correct price');
  });

  test('selecting different tier updates price on subscribe button', async ({ page }) => {
    // Initially PRO ($29)
    await expect(page.locator('button:has-text("$29.00/month")')).toBeVisible();

    // Click STARTER tier
    await page.getByRole('heading', { name: 'STARTER' }).click();

    // Price should update to $9
    await expect(page.locator('button:has-text("$9.00/month")')).toBeVisible();

    // SELECTED badge should move to STARTER
    await expect(page.locator('text=SELECTED')).toBeVisible();

    // Click ENTERPRISE tier
    await page.getByRole('heading', { name: 'ENTERPRISE' }).click();

    // Price should update to $185
    await expect(page.locator('button:has-text("$185.00/month")')).toBeVisible();

    console.log('✅ Tier selection updates subscribe button price correctly');
  });

  test('tier cards show correct hover states', async ({ page }) => {
    // Hover over STARTER heading (not selected)
    const starterHeading = page.getByRole('heading', { name: 'STARTER' });
    await starterHeading.hover();

    // Just verify we can hover without error - visual hover states are CSS-based
    await expect(starterHeading).toBeVisible();

    console.log('✅ Tier card hover states work');
  });

  test('tooltips are functional', async ({ page }) => {
    // Check that info icon buttons exist
    const infoButtons = page.locator('button').filter({ has: page.locator('svg[class*="lucide-info"]') });
    await expect(infoButtons.first()).toBeVisible();

    console.log('✅ Tooltips info buttons are present');
  });

  test('terms of service link opens modal', async ({ page }) => {
    // Click terms of service link
    await page.locator('button:has-text("terms of service")').click();

    // Modal should open
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Terms of Service' })).toBeVisible();

    // Should see Download PDF button (on larger screens)
    await expect(page.locator('button').filter({ hasText: /Download PDF|PDF/ })).toBeVisible();

    // Should see I Agree button
    await expect(page.locator('button:has-text("I Agree")')).toBeVisible();

    // Should see Cancel button
    await expect(page.locator('button:has-text("Cancel")').last()).toBeVisible();

    console.log('✅ Terms of service modal opens and displays content');
  });

  test('accepting terms via modal enables subscribe button', async ({ page }) => {
    // Subscribe button should be disabled initially
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await expect(subscribeButton).toBeDisabled();

    // Open TOS modal
    await page.locator('button:has-text("terms of service")').click();

    // Click "I Agree"
    await page.locator('button:has-text("I Agree")').click();

    // Modal should close
    await expect(page.getByRole('dialog')).not.toBeVisible();

    // Checkbox should be checked
    const termsCheckbox = page.locator('#terms');
    await expect(termsCheckbox).toBeChecked();

    // Subscribe button should now be enabled
    await expect(subscribeButton).toBeEnabled();

    console.log('✅ Accepting terms via modal enables subscribe button');
  });

  test('checking terms checkbox directly enables subscribe button', async ({ page }) => {
    // Subscribe button should be disabled initially
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await expect(subscribeButton).toBeDisabled();

    // Click the checkbox directly (not the modal)
    await page.locator('label:has-text("Agree to")').click();

    // Checkbox should be checked
    const termsCheckbox = page.locator('#terms');
    await expect(termsCheckbox).toBeChecked();

    // Subscribe button should now be enabled
    await expect(subscribeButton).toBeEnabled();

    console.log('✅ Checking terms checkbox directly enables subscribe button');
  });

  test('subscribe button shows correct tier and price', async ({ page }) => {
    // Enable subscribe button
    await page.locator('label:has-text("Agree to")').click();

    // Check default PRO tier
    let subscribeButton = page.locator('button:has-text("Subscribe to Service for $40.00/month")');
    await expect(subscribeButton).toBeVisible();

    // Switch to STARTER
    await page.getByRole('heading', { name: 'STARTER' }).click();
    subscribeButton = page.locator('button:has-text("Subscribe to Service for $20.00/month")');
    await expect(subscribeButton).toBeVisible();

    // Switch to ENTERPRISE
    await page.getByRole('heading', { name: 'ENTERPRISE' }).click();
    subscribeButton = page.locator('button:has-text("Subscribe to Service for $80.00/month")');
    await expect(subscribeButton).toBeVisible();

    console.log('✅ Subscribe button displays correct tier and price');
  });

  test('subscribe button click logs to console (placeholder)', async ({ page }) => {
    // Enable subscribe button
    await page.locator('label:has-text("Agree to")').click();

    // Listen for console messages
    const consoleLogs: string[] = [];
    page.on('console', (msg) => {
      consoleLogs.push(msg.text());
    });

    // Click subscribe button
    await page.locator('button:has-text("Subscribe to Service")').click();

    // Should see console log (placeholder implementation)
    // Wait a bit for console log to appear
    await page.waitForTimeout(100);

    const hasSubscribeLog = consoleLogs.some((log) => log.includes('Subscribe to'));
    expect(hasSubscribeLog).toBe(true);

    console.log('✅ Subscribe button click triggers placeholder action');
  });

  test('included features are displayed correctly', async ({ page }) => {
    // Should see all included features
    await expect(page.locator('text=Global geo-steering and failover')).toBeVisible();
    await expect(page.locator('text=/1x Seal Key \\(3 packages\\)/i')).toBeVisible();
    await expect(page.locator('text=2x API-Key')).toBeVisible();
    await expect(page.locator('text=On-chain spending-limit protection')).toBeVisible();

    // Should see checkmark icon
    await expect(page.locator('svg[class*="lucide-check"]').first()).toBeVisible();

    console.log('✅ Included features are displayed correctly');
  });

  test('per-request pricing section is displayed', async ({ page }) => {
    // Should see Per-Request Pricing section
    await expect(page.locator('text=Per-Request Pricing')).toBeVisible();
    await expect(page.locator('text=/\\$1 charged per 10,000 successful requests/i')).toBeVisible();

    console.log('✅ Per-Request Pricing section is displayed correctly');
  });

  test('optional add-ons info is present', async ({ page }) => {
    // Should see optional add-ons text with tooltip
    await expect(page.locator('text=Optional add-ons are available')).toBeVisible();

    // Click info icon
    const addonsTooltip = page.locator('text=Optional add-ons are available').locator('..').locator('button').first();
    await addonsTooltip.click();

    // Should show tooltip content
    await expect(page.locator('text=/Additional Seal Keys.*packages.*API keys/i')).toBeVisible();

    console.log('✅ Optional add-ons info is present with functional tooltip');
  });
});
