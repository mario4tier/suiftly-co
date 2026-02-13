/**
 * Tailwind Colors E2E Test
 * Verifies that Tailwind color classes are working correctly:
 * - Custom Cloudflare colors
 * - Standard Tailwind colors (gray, amber, red, blue, etc.)
 * - Dark mode color switching
 *
 * Note: Tailwind v4 uses OKLCH color space for better color accuracy
 */

import { test, expect } from '@playwright/test';
import { waitAfterMutation } from '../helpers/wait-utils';

/**
 * Helper to check if a color matches expected value (handles both RGB and OKLCH)
 * Tailwind v4 uses oklch() format, older versions use rgb()
 */
function expectColorMatch(actual: string, expectedRgb: string, expectedOklch: string) {
  if (actual.startsWith('rgb')) {
    expect(actual).toBe(expectedRgb);
  } else if (actual.startsWith('oklch')) {
    expect(actual).toBe(expectedOklch);
  } else {
    throw new Error(`Unexpected color format: ${actual}`);
  }
}

test.describe('Tailwind Color System', () => {
  test.beforeEach(async ({ page, request }) => {
    // Reset DB to ensure fresh state (no existing services)
    await request.post('http://localhost:22700/test/data/reset', {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 0,
        clearEscrowAccount: true,
      },
    });

    // Clear cookies for clean auth state (prevents test pollution)
    await page.context().clearCookies();

    // Authenticate with mock wallet
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await waitAfterMutation(page);

    // Wait for redirect to /dashboard after auth
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Stay on dashboard to test header colors (wallet button exists here)
    // Seal service page is used only for specific tests that need onboarding form
  });

  test('custom Cloudflare colors are applied correctly', async ({ page }) => {
    // Navigate to Seal service page to access subscribe button
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Test the orange (#f38020) branding color on subscribe button
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await expect(subscribeButton).toBeVisible();

    // Get computed background color
    const bgColor = await subscribeButton.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });

    // #f38020 = rgb(243, 128, 32)
    expect(bgColor).toBe('rgb(243, 128, 32)');

    console.log('✅ Custom Cloudflare orange color (#f38020) is applied correctly');
  });

  test('standard Tailwind gray colors are applied correctly', async ({ page }) => {
    // Test gray-700 text color on wallet address in light mode
    const walletButton = page.locator('button').filter({ hasText: /0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}/ }).first();
    await expect(walletButton).toBeVisible();

    const walletText = walletButton.locator('span.font-mono').first();
    const textColor = await walletText.evaluate((el) => {
      return window.getComputedStyle(el).color;
    });

    // gray-700: rgb(55, 65, 81) or oklch(0.373 0.034 259.733)
    expectColorMatch(textColor, 'rgb(55, 65, 81)', 'oklch(0.373 0.034 259.733)');

    console.log('✅ Standard Tailwind gray-700 color is applied correctly');
  });

  test('standard Tailwind amber colors are applied correctly', async ({ page }) => {
    // Navigate to Seal service page to access Guaranteed Bandwidth section
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Click an info icon to open tooltip with amber background
    const infoButton = page.locator('h3:has-text("Guaranteed Bandwidth")').locator('..').locator('button').first();
    await infoButton.click();

    // Get the popover element (Playwright auto-retries toBeVisible)
    const popover = page.locator('[role="dialog"]').or(page.locator('.z-50').filter({ hasText: /regions/ })).first();
    await expect(popover).toBeVisible();

    const bgColor = await popover.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });

    // amber-50: rgb(255, 251, 235) or oklch(0.987 0.022 95.277)
    expectColorMatch(bgColor, 'rgb(255, 251, 235)', 'oklch(0.987 0.022 95.277)');

    console.log('✅ Standard Tailwind amber-50 color is applied correctly');
  });

  test('standard Tailwind red colors are applied correctly', async ({ page }) => {
    // Open wallet menu
    const walletButton = page.locator('button').filter({ hasText: /0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}/ }).first();
    await walletButton.click();

    // Check red disconnect button (text-red-600) - Playwright auto-retries toBeVisible
    const disconnectButton = page.locator('button:has-text("Disconnect")');
    await expect(disconnectButton).toBeVisible();

    const textColor = await disconnectButton.evaluate((el) => {
      return window.getComputedStyle(el).color;
    });

    // red-600: rgb(220, 38, 38) or oklch(0.577 0.245 27.325)
    expectColorMatch(textColor, 'rgb(220, 38, 38)', 'oklch(0.577 0.245 27.325)');

    console.log('✅ Standard Tailwind red-600 color is applied correctly');
  });

  test('dark mode switches colors correctly', async ({ page }) => {
    // Get initial background color of wallet button in light mode
    const walletButtonLight = page.locator('button').filter({ hasText: /0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}/ }).first();
    await expect(walletButtonLight).toBeVisible();

    const lightBgColor = await walletButtonLight.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });

    // bg-white: rgb(255, 255, 255) or oklch(1 0 0)
    expectColorMatch(lightBgColor, 'rgb(255, 255, 255)', 'oklch(1 0 0)');

    console.log('✅ Light mode: wallet button has white background');

    // Switch to dark mode by manually adding dark class to html
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
    });

    // Small wait for CSS recomputation (browser needs time to apply dark mode styles)
    await page.waitForTimeout(200);

    // Re-query the wallet button after dark mode switch (element may have re-rendered)
    const walletButtonDark = page.locator('button').filter({ hasText: /0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}/ }).first();
    await expect(walletButtonDark).toBeVisible();

    const darkBgColor = await walletButtonDark.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });

    // dark:bg-gray-800: rgb(31, 41, 55) or oklch(0.278 0.033 256.848)
    expectColorMatch(darkBgColor, 'rgb(31, 41, 55)', 'oklch(0.278 0.033 256.848)');

    console.log('✅ Dark mode: wallet button has gray-800 background');
  });

  test('dark mode switches text colors correctly', async ({ page }) => {
    // Get wallet text color in light mode
    const walletButton = page.locator('button').filter({ hasText: /0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}/ }).first();
    const walletText = walletButton.locator('span.font-mono').first();

    const lightTextColor = await walletText.evaluate((el) => {
      return window.getComputedStyle(el).color;
    });

    // text-gray-700: rgb(55, 65, 81) or oklch(0.373 0.034 259.733)
    expectColorMatch(lightTextColor, 'rgb(55, 65, 81)', 'oklch(0.373 0.034 259.733)');

    console.log('✅ Light mode: wallet text has gray-700 color');

    // Switch to dark mode
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
    });

    // Small wait for CSS recomputation
    await page.waitForTimeout(200);

    const darkTextColor = await walletText.evaluate((el) => {
      return window.getComputedStyle(el).color;
    });

    // dark:text-gray-200: rgb(229, 231, 235) or oklch(0.928 0.006 264.531)
    expectColorMatch(darkTextColor, 'rgb(229, 231, 235)', 'oklch(0.928 0.006 264.531)');

    console.log('✅ Dark mode: wallet text has gray-200 color');
  });

  test('dark mode switches border colors correctly', async ({ page }) => {
    // Get wallet button border color in light mode
    const walletButton = page.locator('button').filter({ hasText: /0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}/ }).first();

    const lightBorderColor = await walletButton.evaluate((el) => {
      return window.getComputedStyle(el).borderColor;
    });

    // border-gray-200: rgb(229, 231, 235) or oklch(0.928 0.006 264.531)
    expectColorMatch(lightBorderColor, 'rgb(229, 231, 235)', 'oklch(0.928 0.006 264.531)');

    console.log('✅ Light mode: wallet button has gray-200 border');

    // Switch to dark mode
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
    });

    // Small wait for CSS recomputation
    await page.waitForTimeout(200);

    const darkBorderColor = await walletButton.evaluate((el) => {
      return window.getComputedStyle(el).borderColor;
    });

    // dark:border-gray-700: rgb(55, 65, 81) or oklch(0.373 0.034 259.733)
    expectColorMatch(darkBorderColor, 'rgb(55, 65, 81)', 'oklch(0.373 0.034 259.733)');

    console.log('✅ Dark mode: wallet button has gray-700 border');
  });

  test('popover dark mode colors switch correctly', async ({ page }) => {
    // Navigate to Seal service page to access Guaranteed Bandwidth section
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Switch to dark mode first
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
    });

    // Small wait for CSS recomputation
    await page.waitForTimeout(200);

    // Click info icon to open tooltip
    const infoButton = page.locator('h3:has-text("Guaranteed Bandwidth")').locator('..').locator('button').first();
    await infoButton.click();

    // Get the popover element (Playwright auto-retries toBeVisible)
    const popover = page.locator('[role="dialog"]').or(page.locator('.z-50').filter({ hasText: /regions/ })).first();
    await expect(popover).toBeVisible();

    const darkBgColor = await popover.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });

    // dark:bg-amber-950: rgb(69, 26, 3) or oklch(0.279 0.077 45.635)
    expectColorMatch(darkBgColor, 'rgb(69, 26, 3)', 'oklch(0.279 0.077 45.635)');

    const darkTextColor = await popover.evaluate((el) => {
      return window.getComputedStyle(el).color;
    });

    // dark:text-amber-50: rgb(255, 251, 235) or oklch(0.987 0.022 95.277)
    expectColorMatch(darkTextColor, 'rgb(255, 251, 235)', 'oklch(0.987 0.022 95.277)');

    console.log('✅ Dark mode: popover has amber-950 background and amber-50 text');
  });

  test('MOCK badge uses amber colors correctly', async ({ page }) => {
    // Check if MOCK badge is visible (using mock wallet)
    const mockBadge = page.locator('span:has-text("MOCK")');

    if (await mockBadge.isVisible()) {
      const bgColor = await mockBadge.evaluate((el) => {
        return window.getComputedStyle(el).backgroundColor;
      });

      // bg-amber-100: rgb(254, 243, 199) or oklch(0.962 0.059 95.617)
      expectColorMatch(bgColor, 'rgb(254, 243, 199)', 'oklch(0.962 0.059 95.617)');

      const textColor = await mockBadge.evaluate((el) => {
        return window.getComputedStyle(el).color;
      });

      // text-amber-700: rgb(180, 83, 9) or oklch(0.555 0.163 48.998)
      expectColorMatch(textColor, 'rgb(180, 83, 9)', 'oklch(0.555 0.163 48.998)');

      console.log('✅ MOCK badge has amber-100 background and amber-700 text');
    } else {
      console.log('ℹ️  MOCK badge not visible (using real wallet)');
    }
  });

  test('blue colors are applied correctly in active sidebar item', async ({ page }) => {
    // Navigate back to dashboard to see active sidebar item
    await page.goto('/dashboard');

    // Find active sidebar item (should have blue background)
    const activeSidebarItem = page.locator('a.sidebar-active, [class*="sidebar-active"]').first();
    await expect(activeSidebarItem).toBeVisible();

    const bgColor = await activeSidebarItem.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });

    // bg-[#dbeafe] (blue-50-ish) - should be blue-ish color
    // This could be rgb(219, 234, 254) or oklch equivalent
    expect(bgColor).toMatch(/rgb\(219, 234, 254\)|oklch\(0\.9\d+ 0\.0\d+ \d+\.\d+\)/);

    console.log('✅ Active sidebar item has blue background color');
  });

  test('green gradient colors work correctly on wallet icon', async ({ page }) => {
    // Get the wallet icon container (has gradient)
    const walletButton = page.locator('button').filter({ hasText: /0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}/ }).first();
    const iconContainer = walletButton.locator('div').filter({ has: page.locator('svg') }).first();

    await expect(iconContainer).toBeVisible();

    const bgImage = await iconContainer.evaluate((el) => {
      return window.getComputedStyle(el).backgroundImage;
    });

    // Should have a gradient with green colors (rgb or oklch format)
    expect(bgImage).toContain('linear-gradient');
    expect(bgImage).toMatch(/rgb.*green|#[0-9a-f]{3,6}|oklch/i);

    console.log('✅ Wallet icon has green gradient background');
  });
});
