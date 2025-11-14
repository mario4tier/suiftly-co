/**
 * E2E Authentication Test
 * Tests complete auth flow with mock wallet and protected route access
 */

import { test, expect } from '@playwright/test';
import { resetCustomer } from '../helpers/db';

test.describe('Authentication Flow', () => {
  test.beforeEach(async ({ request }) => {
    // Reset customer to production defaults (prevents test pollution from previous tests)
    await resetCustomer(request);
  });

  test('can authenticate with mock wallet and access protected route', async ({ page }) => {
    // Go to home page
    await page.goto('/');

    // Click "Mock Wallet" button directly on login page
    await page.click('button:has-text("Mock Wallet")');

    // Should authenticate and show address button (wait for auth to complete)
    await expect(page.locator('text=/0x[a-f0-9]{4}\\.\\.\\./')).toBeVisible({ timeout: 5000 });

    // Navigate to protected /test route
    await page.goto('/test');

    // Should see authenticated content (not redirected to home)
    await expect(page.locator('text=Phase 8: Authentication Test')).toBeVisible();
    await expect(page.locator('text=Authentication Successful')).toBeVisible();

    // Should see wallet address displayed
    await expect(page.locator('text=/0xaaaa.*aaaa/')).toBeVisible();

    // Click "Test Protected Endpoint" button
    await page.click('button:has-text("Test Protected Endpoint")');

    // Wait for response to appear
    await page.waitForSelector('pre', { timeout: 5000 });

    // Get the response text
    const responseText = await page.locator('pre').textContent();

    // Verify response contains expected fields
    expect(responseText).toContain('walletAddress');
    expect(responseText).toContain('0xaaaa');

    // Parse JSON and verify structure
    const response = JSON.parse(responseText || '{}');
    expect(response).toHaveProperty('user');
    expect(response.user).toHaveProperty('walletAddress');
    expect(response.user.walletAddress).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    console.log('✅ Protected endpoint returned correct wallet address:', response.user.walletAddress);
  });

  test('logout works and clears session', async ({ page }) => {
    // Authenticate first
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');

    // Wait for address button to appear (authentication complete)
    const addressButton = page.locator('button', { hasText: /0x[a-f0-9]{4}/ });
    await expect(addressButton).toBeVisible({ timeout: 5000 });

    // Click address button to open dropdown
    await addressButton.click();

    // Wait for dropdown menu to appear and click disconnect
    await page.waitForSelector('text=Disconnect', { timeout: 2000 });
    await page.click('text=Disconnect');

    // Should redirect to /login
    await page.waitForURL('/login', { timeout: 5000 });
    expect(page.url()).toContain('/login');

    // Should show "Mock Wallet" button again
    await expect(page.locator('button:has-text("Mock Wallet")')).toBeVisible();

    // localStorage should be cleared
    const authState = await page.evaluate(() => localStorage.getItem('suiftly-auth'));
    const parsed = authState ? JSON.parse(authState) : null;
    expect(parsed?.state?.isAuthenticated).toBeFalsy();
  });
});
