/**
 * E2E Authentication Test
 * Tests complete auth flow with mock wallet and protected route access
 */

import { test, expect } from '@playwright/test';

test.describe('Authentication Flow', () => {
  test('can authenticate with mock wallet and access protected route', async ({ page }) => {
    // Go to home page
    await page.goto('/');

    // Click "Connect Wallet" button
    await page.click('text=Connect Wallet');

    // Modal should open - click "Connect Mock Wallet"
    await page.click('text=Connect Mock Wallet');

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
    await page.click('text=Connect Wallet');
    await page.click('text=Connect Mock Wallet');
    await expect(page.locator('text=/0x[a-f0-9]{4}\\.\\.\\./')).toBeVisible({ timeout: 5000 });

    // Click address to open dropdown
    await page.click('text=/0x[a-f0-9]{4}\\.\\.\\.*/');

    // Click disconnect
    await page.click('text=Disconnect');

    // Should show "Connect Wallet" button again
    await expect(page.locator('text=Connect Wallet')).toBeVisible();

    // localStorage should be cleared
    const authState = await page.evaluate(() => localStorage.getItem('suiftly-auth'));
    const parsed = authState ? JSON.parse(authState) : null;
    expect(parsed?.state?.isAuthenticated).toBeFalsy();
  });
});
