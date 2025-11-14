/**
 * Test Locator Utilities
 * Provides robust, reusable locators for common UI elements
 * Helps avoid "strict mode violation" errors from non-specific selectors
 */

import type { Page, Locator } from '@playwright/test';

/**
 * Locate the banner section on a service page
 * Banners show important status messages like "Payment pending" or "Service active"
 *
 * @example
 * await expect(getBanner(page)).toContainText('Subscription payment pending');
 * await expect(getBanner(page)).toContainText('Service is active');
 */
export function getBanner(page: Page): Locator {
  return page.getByTestId('banner-section');
}

/**
 * Locate a toast notification by text content
 * Toasts are temporary notifications that appear and disappear
 *
 * @param page - Playwright page object
 * @param textMatch - Text or regex to match in toast content
 * @param options - Optional configuration
 * @returns Locator for the matching toast
 *
 * @example
 * await expect(getToast(page, /Subscription successful/i)).toBeVisible({ timeout: 5000 });
 * await expect(getToast(page, 'Deposit funds')).toBeVisible();
 */
export function getToast(
  page: Page,
  textMatch: string | RegExp,
  options?: {
    /** Wait for toast to appear (default: true) */
    waitFor?: boolean;
  }
): Locator {
  const locator = page.locator('[data-sonner-toast]').filter({ hasText: textMatch });
  return locator;
}

/**
 * Locate a success toast (green notification)
 *
 * @example
 * await expect(getSuccessToast(page, 'Subscription successful')).toBeVisible();
 */
export function getSuccessToast(page: Page, textMatch: string | RegExp): Locator {
  // Sonner success toasts have specific classes/attributes
  return page.locator('[data-sonner-toast][data-type="success"]').filter({ hasText: textMatch });
}

/**
 * Locate an error toast (red notification)
 *
 * @example
 * await expect(getErrorToast(page, 'insufficient balance')).toBeVisible();
 */
export function getErrorToast(page: Page, textMatch: string | RegExp): Locator {
  return page.locator('[data-sonner-toast][data-type="error"]').filter({ hasText: textMatch });
}

/**
 * Locate a warning toast (orange/yellow notification)
 *
 * @example
 * await expect(getWarningToast(page, 'Payment pending')).toBeVisible();
 */
export function getWarningToast(page: Page, textMatch: string | RegExp): Locator {
  return page.locator('[data-sonner-toast][data-type="warning"]').filter({ hasText: textMatch });
}

/**
 * Wait for any toast to disappear (useful for test cleanup)
 *
 * @param page - Playwright page object
 * @param timeout - Max time to wait in ms (default: 10000)
 *
 * @example
 * await waitForToastsToDisappear(page);
 */
export async function waitForToastsToDisappear(page: Page, timeout = 10000): Promise<void> {
  try {
    await page.locator('[data-sonner-toast]').first().waitFor({ state: 'hidden', timeout });
  } catch {
    // If no toasts found, that's fine
  }
}
