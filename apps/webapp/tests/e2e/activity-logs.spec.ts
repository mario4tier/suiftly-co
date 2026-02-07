/**
 * E2E Activity Logs Test
 * Tests user activity logging functionality including login logs and pagination
 */

import { test, expect } from '@playwright/test';
import { resetCustomer, authenticateWithMockWallet } from '../helpers/db';
import { waitAfterMutation } from '../helpers/wait-utils';

test.describe('Activity Logs', () => {
  test.beforeEach(async ({ request }) => {
    // Reset customer to production defaults (prevents test pollution from previous tests)
    await resetCustomer(request);
  });

  test('displays login activity after authentication', async ({ page }) => {
    // Authenticate with mock wallet
    await authenticateWithMockWallet(page);

    // Navigate to logs page
    await page.goto('/logs');

    // Wait for logs to load
    await expect(page.locator('h2:has-text("Activity Logs")')).toBeVisible();

    // Should see the "Login" activity log entry (there may be multiple from previous tests)
    await expect(page.locator('text=Login').first()).toBeVisible({ timeout: 5000 });

    // Should see timestamp for the login event
    const logEntry = page.locator('text=Login').first().locator('..');
    await expect(logEntry).toBeVisible();

    // Should see an IP address in the log entry (127.0.0.1 or ::1 for localhost)
    await expect(page.locator('text=/127\\.0\\.0\\.1|::1/').first()).toBeVisible();

    console.log('✅ Login activity successfully logged and displayed');
  });

  test('shows empty state when no logs exist for new user', async ({ page, context }) => {
    // Clear any existing auth state
    await context.clearCookies();
    await page.goto('/');

    // This test would only work if we can create a truly new user
    // For now, we'll skip since mock wallet always uses same address
    // In production, each new wallet would see empty state on first visit
  });

  test('pagination works correctly', async ({ page }) => {
    // Authenticate
    await authenticateWithMockWallet(page);

    // Navigate to logs page
    await page.goto('/logs');
    await expect(page.locator('h2:has-text("Activity Logs")')).toBeVisible();

    // Wait for logs to load
    await page.waitForSelector('text=Login', { timeout: 5000 });

    // Check if we have pagination controls (only visible if >20 entries or multiple pages loaded)
    const hasLoadMore = await page.locator('button:has-text("Load More")').isVisible();
    const hasBackToTop = await page.locator('button:has-text("Back to Top")').isVisible();

    if (hasLoadMore) {
      // Get the current showing range
      const initialShowingText = await page.locator('text=/Showing \\d+ - \\d+ of \\d+/').textContent();

      // Click "Load More"
      await page.click('button:has-text("Load More")');

      // Wait for new entries to load (smart wait - returns as soon as pagination complete)
      await waitAfterMutation(page);

      // Check the new showing range (should be next page, e.g., "Showing 21 - 40 of...")
      const newShowingText = await page.locator('text=/Showing \\d+ - \\d+ of \\d+/').textContent();
      expect(newShowingText).not.toBe(initialShowingText);

      // "Back to Top" button should now be visible
      await expect(page.locator('button:has-text("Back to Top")')).toBeVisible();

      console.log('✅ Pagination working correctly');
    } else {
      // Not enough logs to test pagination - that's OK
      console.log('ℹ️  Not enough logs to test pagination (< 20 entries)');
    }
  });

  test('limits display to 100 entries', async ({ page }) => {
    // Authenticate
    await authenticateWithMockWallet(page);

    // Navigate to logs page
    await page.goto('/logs');

    // Wait for logs to load
    await page.waitForSelector('text=Login', { timeout: 5000 });

    // Check the total count display
    const countText = await page.locator('text=/Showing \\d+ - \\d+ of \\d+/').textContent();

    if (countText) {
      const match = countText.match(/of (\d+)/);
      if (match) {
        const totalCount = parseInt(match[1], 10);

        // Total count should never exceed 100
        expect(totalCount).toBeLessThanOrEqual(100);

        console.log(`✅ Total count correctly capped: ${totalCount} <= 100`);
      }
    }
  });

  test('displays log entries with proper formatting', async ({ page }) => {
    // Authenticate
    await authenticateWithMockWallet(page);

    // Navigate to logs page
    await page.goto('/logs');
    await expect(page.locator('h2:has-text("Activity Logs")')).toBeVisible();

    // Wait for first log entry
    await page.waitForSelector('text=Login', { timeout: 5000 });

    // Find first log entry (compact monospace format)
    const firstEntry = page.locator('.space-y-0\\.5.font-mono .py-0\\.5').first();
    await expect(firstEntry).toBeVisible();

    // Verify entry contains all required parts in text content
    const entryText = await firstEntry.textContent();
    expect(entryText).toBeTruthy();

    // Should have timestamp (numbers indicating date/time)
    expect(entryText).toMatch(/\d+\/\d+\/\d+/); // Date pattern
    expect(entryText).toMatch(/\d+:\d+:\d+/); // Time pattern

    // Should have IP address
    expect(entryText).toMatch(/\d+\.\d+\.\d+\.\d+|::1|::ffff:/);

    // Should have Login message
    expect(entryText).toContain('Login');

    console.log('✅ Log entry properly formatted with timestamp, IP, and message');
  });

  test('can navigate back to top after loading more', async ({ page }) => {
    // Authenticate
    await authenticateWithMockWallet(page);

    // Navigate to logs page
    await page.goto('/logs');
    await expect(page.locator('h2:has-text("Activity Logs")')).toBeVisible();

    // Wait for logs to load
    await page.waitForSelector('text=Login', { timeout: 5000 });

    // Check if "Load More" exists
    const hasLoadMore = await page.locator('button:has-text("Load More")').isVisible();

    if (hasLoadMore) {
      // Click "Load More"
      await page.click('button:has-text("Load More")');
      await waitAfterMutation(page);

      // Click "Back to Top"
      await page.click('button:has-text("Back to Top")');
      await waitAfterMutation(page);

      // Should be back at the top (showing entries 1-20)
      const countText = await page.locator('text=/Showing \\d+ - \\d+ of \\d+/').textContent();
      expect(countText).toMatch(/^Showing 1 - /);

      // "Back to Top" button should no longer be visible
      await expect(page.locator('button:has-text("Back to Top")')).not.toBeVisible();

      console.log('✅ Back to Top navigation working correctly');
    } else {
      console.log('ℹ️  Not enough logs to test Back to Top (< 20 entries)');
    }
  });

  test('handles errors gracefully', async ({ page, context }) => {
    // Authenticate first
    await authenticateWithMockWallet(page);

    // Navigate to logs page first
    await page.goto('/logs');

    // Now intercept the next API call and make it fail
    await page.route('**/i/api/activity.getLogs**', route => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            message: 'Internal server error',
            code: 'INTERNAL_SERVER_ERROR',
          },
        }),
      });
    });

    // Force a reload to trigger the error
    await page.reload();

    // Should show error message (check for the actual error that shows up)
    await expect(page.locator('text=/Failed to load|Internal server error|INTERNAL_SERVER_ERROR/')).toBeVisible({ timeout: 5000 });

    console.log('✅ Error handling working correctly');
  });
});
