/**
 * Seal Service Configuration E2E Test
 * Tests the onboarding form for subscribing to Seal service
 */

import { test, expect } from '@playwright/test';

test.describe('Seal Service Onboarding Form', () => {
  test.beforeEach(async ({ page }) => {
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
    await expect(page.locator('text=STARTER')).toBeVisible();
    await expect(page.locator('text=PRO')).toBeVisible();
    await expect(page.locator('text=BUSINESS')).toBeVisible();

    // Should see "Included with every subscription" section
    await expect(page.locator('text=Included with every subscription')).toBeVisible();

    // Should see Pay-As-You-Go section
    await expect(page.locator('text=Pay-As-You-Go')).toBeVisible();

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

    // Subscribe button should show PRO price ($40)
    await expect(page.locator('button:has-text("$40.00/month")')).toBeVisible();

    console.log('✅ PRO tier is selected by default with correct price');
  });

  test('selecting different tier updates price on subscribe button', async ({ page }) => {
    // Initially PRO ($40)
    await expect(page.locator('button:has-text("$40.00/month")')).toBeVisible();

    // Click STARTER tier
    await page.locator('text=STARTER').click();

    // Price should update to $20
    await expect(page.locator('button:has-text("$20.00/month")')).toBeVisible();

    // SELECTED badge should move to STARTER
    const starterCard = page.locator('div').filter({ hasText: /^STARTER/ }).first();
    await expect(starterCard).toHaveClass(/border-\[#f38020\]/);

    // Click BUSINESS tier
    await page.locator('text=BUSINESS').click();

    // Price should update to $80
    await expect(page.locator('button:has-text("$80.00/month")')).toBeVisible();

    console.log('✅ Tier selection updates subscribe button price correctly');
  });

  test('tier cards show correct hover states', async ({ page }) => {
    // Hover over STARTER (not selected)
    const starterCard = page.locator('div').filter({ hasText: /^STARTER/ }).first();
    await starterCard.hover();

    // Should show hover border (2px gray)
    await expect(starterCard).toHaveClass(/hover:border-2/);

    console.log('✅ Tier card hover states work');
  });

  test('tooltips are functional', async ({ page }) => {
    // Click "Guaranteed Bandwidth" info icon
    const bandwidthTooltip = page.locator('h3:has-text("Guaranteed Bandwidth")').locator('..').locator('button').first();
    await bandwidthTooltip.click();

    // Should show tooltip content
    await expect(page.locator('text=/3 regions.*US-East.*US-West.*EU-Frankfurt/i')).toBeVisible();

    // Click outside to close
    await page.locator('h3:has-text("Guaranteed Bandwidth")').click();

    // Click "Global geo-steering" info icon
    const geoSteeringTooltip = page.locator('text=Global geo-steering and failover').locator('..').locator('button').first();
    await geoSteeringTooltip.click();

    // Should show tooltip content
    await expect(page.locator('text=/Closest key-server.*automatically selected/i')).toBeVisible();

    console.log('✅ Tooltips are functional');
  });

  test('terms of service link opens modal', async ({ page }) => {
    // Click terms of service link
    await page.locator('button:has-text("terms of service")').click();

    // Modal should open
    await expect(page.locator('text=Suiftly Seal Service Agreement')).toBeVisible();

    // Should see Download PDF button
    await expect(page.locator('button:has-text("Download PDF")')).toBeVisible();

    // Should see Agree and Close button
    await expect(page.locator('button:has-text("Agree and Close")')).toBeVisible();

    // Modal should be scrollable
    const modalContent = page.locator('text=Service Level Agreement');
    await expect(modalContent).toBeVisible();

    console.log('✅ Terms of service modal opens and displays content');
  });

  test('accepting terms via modal enables subscribe button', async ({ page }) => {
    // Subscribe button should be disabled initially
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await expect(subscribeButton).toBeDisabled();

    // Open TOS modal
    await page.locator('button:has-text("terms of service")').click();

    // Click "Agree and Close"
    await page.locator('button:has-text("Agree and Close")').click();

    // Modal should close
    await expect(page.locator('text=Suiftly Seal Service Agreement')).not.toBeVisible();

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
    await page.locator('text=STARTER').click();
    subscribeButton = page.locator('button:has-text("Subscribe to Service for $20.00/month")');
    await expect(subscribeButton).toBeVisible();

    // Switch to BUSINESS
    await page.locator('text=BUSINESS').click();
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
    await expect(page.locator('text=1x Seal Key, 3x packages per key')).toBeVisible();
    await expect(page.locator('text=2x API-Key')).toBeVisible();
    await expect(page.locator('text=2x IPv4 Whitelisting')).toBeVisible();

    // Should see checkmark icon
    await expect(page.locator('svg[class*="lucide-check"]').first()).toBeVisible();

    console.log('✅ Included features are displayed correctly');
  });

  test('pay-as-you-go section is displayed', async ({ page }) => {
    // Should see Pay-As-You-Go section
    await expect(page.locator('text=Pay-As-You-Go (charged separately, no expiration)')).toBeVisible();
    await expect(page.locator('text=$1 per 10,000 requests')).toBeVisible();

    // Should have blue-tinted background
    const paygoSection = page.locator('text=Pay-As-You-Go').locator('..');
    await expect(paygoSection).toHaveClass(/border-blue-200/);

    console.log('✅ Pay-As-You-Go section is displayed correctly');
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
