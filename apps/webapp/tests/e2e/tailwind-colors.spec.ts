/**
 * Tailwind Colors E2E Test
 * Verifies that Tailwind color classes are working correctly:
 * - Custom Cloudflare colors
 * - Standard Tailwind colors (gray, amber, red, blue, etc.)
 * - Dark mode color switching
 */

import { test, expect } from '@playwright/test';

test.describe('Tailwind Color System', () => {
  test.beforeEach(async ({ page }) => {
    // Authenticate with mock wallet
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');

    // Wait for redirect to /dashboard after auth
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Navigate to seal service page to test colors
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
  });

  test('custom Cloudflare colors are applied correctly', async ({ page }) => {
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

    // gray-700 = rgb(55, 65, 81)
    expect(textColor).toBe('rgb(55, 65, 81)');

    console.log('✅ Standard Tailwind gray-700 color is applied correctly');
  });

  test('standard Tailwind amber colors are applied correctly', async ({ page }) => {
    // Click an info icon to open tooltip with amber background
    const infoButton = page.locator('h3:has-text("Guaranteed Bandwidth")').locator('..').locator('button').first();
    await infoButton.click();

    // Wait for popover to appear
    await page.waitForTimeout(200);

    // Get the popover element
    const popover = page.locator('[role="dialog"]').or(page.locator('.z-50').filter({ hasText: /regions/ })).first();
    await expect(popover).toBeVisible();

    const bgColor = await popover.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });

    // amber-50 = rgb(255, 251, 235)
    expect(bgColor).toBe('rgb(255, 251, 235)');

    console.log('✅ Standard Tailwind amber-50 color is applied correctly');
  });

  test('standard Tailwind red colors are applied correctly', async ({ page }) => {
    // Open wallet menu
    const walletButton = page.locator('button').filter({ hasText: /0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}/ }).first();
    await walletButton.click();

    // Wait for menu to appear
    await page.waitForTimeout(200);

    // Check red disconnect button
    const disconnectButton = page.locator('button:has-text("Disconnect")');
    await expect(disconnectButton).toBeVisible();

    const textColor = await disconnectButton.evaluate((el) => {
      return window.getComputedStyle(el).color;
    });

    // red-600 = rgb(220, 38, 38)
    expect(textColor).toBe('rgb(220, 38, 38)');

    console.log('✅ Standard Tailwind red-600 color is applied correctly');
  });

  test('dark mode switches colors correctly', async ({ page }) => {
    // Get initial background color of wallet button in light mode
    const walletButton = page.locator('button').filter({ hasText: /0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}/ }).first();
    await expect(walletButton).toBeVisible();

    const lightBgColor = await walletButton.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });

    // bg-white = rgb(255, 255, 255)
    expect(lightBgColor).toBe('rgb(255, 255, 255)');

    console.log('✅ Light mode: wallet button has white background');

    // Switch to dark mode by clicking the theme toggle
    const themeToggle = page.locator('button[aria-label*="theme"]').or(page.locator('button').filter({ has: page.locator('svg') }).filter({ hasText: '' })).first();

    // Look for theme toggle button - it might be in the header or sidebar
    const toggleButton = page.locator('button').filter({ has: page.locator('svg[class*="lucide"]') }).locator('..').filter({ hasNot: page.locator('span') }).first();

    // If we can't find a theme toggle, manually add dark class to html
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
    });

    // Wait for theme change to take effect
    await page.waitForTimeout(300);

    const darkBgColor = await walletButton.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });

    // dark:bg-gray-800 = rgb(31, 41, 55)
    expect(darkBgColor).toBe('rgb(31, 41, 55)');

    console.log('✅ Dark mode: wallet button has gray-800 background');
  });

  test('dark mode switches text colors correctly', async ({ page }) => {
    // Get wallet text color in light mode
    const walletButton = page.locator('button').filter({ hasText: /0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}/ }).first();
    const walletText = walletButton.locator('span.font-mono').first();

    const lightTextColor = await walletText.evaluate((el) => {
      return window.getComputedStyle(el).color;
    });

    // text-gray-700 = rgb(55, 65, 81)
    expect(lightTextColor).toBe('rgb(55, 65, 81)');

    console.log('✅ Light mode: wallet text has gray-700 color');

    // Switch to dark mode
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
    });

    await page.waitForTimeout(300);

    const darkTextColor = await walletText.evaluate((el) => {
      return window.getComputedStyle(el).color;
    });

    // dark:text-gray-200 = rgb(229, 231, 235)
    expect(darkTextColor).toBe('rgb(229, 231, 235)');

    console.log('✅ Dark mode: wallet text has gray-200 color');
  });

  test('dark mode switches border colors correctly', async ({ page }) => {
    // Get wallet button border color in light mode
    const walletButton = page.locator('button').filter({ hasText: /0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}/ }).first();

    const lightBorderColor = await walletButton.evaluate((el) => {
      return window.getComputedStyle(el).borderColor;
    });

    // border-gray-200 = rgb(229, 231, 235)
    expect(lightBorderColor).toBe('rgb(229, 231, 235)');

    console.log('✅ Light mode: wallet button has gray-200 border');

    // Switch to dark mode
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
    });

    await page.waitForTimeout(300);

    const darkBorderColor = await walletButton.evaluate((el) => {
      return window.getComputedStyle(el).borderColor;
    });

    // dark:border-gray-700 = rgb(55, 65, 81)
    expect(darkBorderColor).toBe('rgb(55, 65, 81)');

    console.log('✅ Dark mode: wallet button has gray-700 border');
  });

  test('popover dark mode colors switch correctly', async ({ page }) => {
    // Switch to dark mode first
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
    });

    await page.waitForTimeout(300);

    // Click info icon to open tooltip
    const infoButton = page.locator('h3:has-text("Guaranteed Bandwidth")').locator('..').locator('button').first();
    await infoButton.click();

    await page.waitForTimeout(200);

    // Get the popover element
    const popover = page.locator('[role="dialog"]').or(page.locator('.z-50').filter({ hasText: /regions/ })).first();
    await expect(popover).toBeVisible();

    const darkBgColor = await popover.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });

    // dark:bg-amber-950 = rgb(69, 26, 3)
    expect(darkBgColor).toBe('rgb(69, 26, 3)');

    const darkTextColor = await popover.evaluate((el) => {
      return window.getComputedStyle(el).color;
    });

    // dark:text-amber-50 = rgb(255, 251, 235)
    expect(darkTextColor).toBe('rgb(255, 251, 235)');

    console.log('✅ Dark mode: popover has amber-950 background and amber-50 text');
  });

  test('MOCK badge uses amber colors correctly', async ({ page }) => {
    // Check if MOCK badge is visible (using mock wallet)
    const mockBadge = page.locator('span:has-text("MOCK")');

    if (await mockBadge.isVisible()) {
      const bgColor = await mockBadge.evaluate((el) => {
        return window.getComputedStyle(el).backgroundColor;
      });

      // bg-amber-100 = rgb(254, 243, 199)
      expect(bgColor).toBe('rgb(254, 243, 199)');

      const textColor = await mockBadge.evaluate((el) => {
        return window.getComputedStyle(el).color;
      });

      // text-amber-700 = rgb(180, 83, 9)
      expect(textColor).toBe('rgb(180, 83, 9)');

      console.log('✅ MOCK badge has amber-100 background and amber-700 text');
    } else {
      console.log('ℹ️  MOCK badge not visible (using real wallet)');
    }
  });

  test('blue colors are applied correctly in Pay-As-You-Go section', async ({ page }) => {
    // Find the Pay-As-You-Go section
    const paygoSection = page.locator('div').filter({ hasText: /Pay-As-You-Go/ }).filter({ hasText: /per 10,000 requests/ }).first();
    await expect(paygoSection).toBeVisible();

    const borderColor = await paygoSection.evaluate((el) => {
      return window.getComputedStyle(el).borderColor;
    });

    // border-blue-200 = rgb(191, 219, 254)
    expect(borderColor).toBe('rgb(191, 219, 254)');

    const bgColor = await paygoSection.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });

    // bg-blue-50 = rgb(239, 246, 255)
    expect(bgColor).toBe('rgb(239, 246, 255)');

    console.log('✅ Pay-As-You-Go section has blue-200 border and blue-50 background');
  });

  test('green gradient colors work correctly on wallet icon', async ({ page }) => {
    // Get the wallet icon container (has gradient)
    const walletButton = page.locator('button').filter({ hasText: /0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}/ }).first();
    const iconContainer = walletButton.locator('div').filter({ has: page.locator('svg') }).first();

    await expect(iconContainer).toBeVisible();

    const bgImage = await iconContainer.evaluate((el) => {
      return window.getComputedStyle(el).backgroundImage;
    });

    // Should have a gradient with green colors
    expect(bgImage).toContain('linear-gradient');
    expect(bgImage).toMatch(/rgb.*green|#[0-9a-f]{3,6}/i);

    console.log('✅ Wallet icon has green gradient background');
  });
});
