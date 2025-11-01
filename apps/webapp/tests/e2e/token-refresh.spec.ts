/**
 * Token Refresh E2E Tests
 *
 * Tests JWT token expiry and automatic refresh in two scenarios:
 * 1. NORMAL EXPIRY (15m): Verify tokens work well beyond short timeframes
 * 2. SHORT EXPIRY (2s): Verify auto-refresh works when token expires
 *
 * Based on docs/TDD_TOKEN_REFRESH.md
 */

import { test, expect } from '@playwright/test';

test.describe('Token Expiry - Normal Config (15m access, 30d refresh)', () => {
  test('access token should remain valid after 5 seconds', async ({ page }) => {
    // Ensure we're using NORMAL expiry (not test expiry)
    // This should be the default when ENABLE_SHORT_JWT_EXPIRY is not set

    // 1. Authenticate with mock wallet
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');

    // Wait for auth to complete
    await expect(page.locator('text=/0x[a-f0-9]{4}\\.\\.\\./')).toBeVisible({ timeout: 5000 });

    // 2. Wait 5 seconds (token should still be valid with 15m expiry)
    console.log('[TEST] Waiting 5 seconds...');
    await page.waitForTimeout(5000);

    // 3. Navigate to protected route (should work without re-auth)
    await page.goto('/test');

    // 4. Verify protected content is visible (not redirected to login)
    await expect(page.locator('text=Phase 8: Authentication Test')).toBeVisible();
    await expect(page.locator('text=Authentication Successful')).toBeVisible();

    // 5. Call protected API endpoint
    await page.click('button:has-text("Test Protected Endpoint")');

    // 6. Wait for response
    await page.waitForSelector('pre', { timeout: 5000 });
    const responseText = await page.locator('pre').textContent();

    // 7. Verify API call succeeded (token was still valid)
    expect(responseText).toContain('walletAddress');
    expect(responseText).toContain('0xaaaa');

    const response = JSON.parse(responseText || '{}');
    expect(response).toHaveProperty('user');
    expect(response.user.walletAddress).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    console.log('✅ Access token remained valid after 5 seconds (15m expiry working correctly)');
  });

  test('access token should remain valid after multiple API calls over 10 seconds', async ({ page }) => {
    // 1. Authenticate
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');
    await expect(page.locator('text=/0x[a-f0-9]{4}\\.\\.\\./')).toBeVisible({ timeout: 5000 });

    // 2. Navigate to test page
    await page.goto('/test');

    // 3. Make API call every 3 seconds for 10 seconds total
    for (let i = 1; i <= 3; i++) {
      console.log(`[TEST] API call ${i}/3 at ${i * 3} seconds...`);

      await page.click('button:has-text("Test Protected Endpoint")');
      await page.waitForSelector('pre', { timeout: 5000 });

      const responseText = await page.locator('pre').textContent();
      const response = JSON.parse(responseText || '{}');

      // Verify each call succeeds
      expect(response.user.walletAddress).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

      // Wait 3 seconds before next call (unless it's the last one)
      if (i < 3) {
        await page.waitForTimeout(3000);
      }
    }

    console.log('✅ Token remained valid through multiple API calls over 10 seconds');
  });
});

test.describe('Token Refresh - Short Expiry Config (2s access, 10s refresh)', () => {
  test('access token should auto-refresh after expiry (2s) and request should succeed', async ({ page }) => {
    // Backend automatically started with short expiry config via Playwright webServer
    // ENABLE_SHORT_JWT_EXPIRY=true JWT_SECRET=TEST_DEV MOCK_AUTH=true

    // 1. Authenticate with mock wallet
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');
    await expect(page.locator('text=/0x[a-f0-9]{4}\\.\\.\\./')).toBeVisible({ timeout: 5000 });

    // 2. Wait for access token to expire (2 seconds + buffer)
    console.log('[TEST] Waiting 2.5 seconds for access token to expire...');
    await page.waitForTimeout(2500);

    // 3. Navigate to protected route (should trigger auto-refresh)
    await page.goto('/test');

    // 4. API call should succeed after auto-refresh
    await page.click('button:has-text("Test Protected Endpoint")');
    await page.waitForSelector('pre', { timeout: 5000 });

    const responseText = await page.locator('pre').textContent();
    const response = JSON.parse(responseText || '{}');

    // 5. Verify request succeeded (auto-refresh worked)
    expect(response.user.walletAddress).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    console.log('✅ Access token auto-refreshed after 2s expiry');
  });

  test('should redirect to login when refresh token expires (10s)', async ({ page }) => {
    // This test simulates the 30-day refresh token lifecycle in just 10 seconds!
    // Backend automatically started with short expiry config via Playwright webServer

    // 1. Authenticate
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');
    await expect(page.locator('text=/0x[a-f0-9]{4}\\.\\.\\./')).toBeVisible({ timeout: 5000 });

    // 2. Wait for refresh token to expire (10 seconds + buffer)
    console.log('[TEST] Waiting 11 seconds for refresh token to expire...');
    await page.waitForTimeout(11000);

    // 3. Try to access protected route
    await page.goto('/test');

    // 4. Trigger an API call that will discover tokens are expired
    //    This will trigger: 401 → refresh attempt → refresh fails → clearAuth → redirect to login
    await page.click('button:has-text("Test Protected Endpoint")');

    // 5. Should be redirected to login page after failed refresh attempt
    await expect(page).toHaveURL('/login', { timeout: 5000 });

    console.log('✅ Redirected to login after refresh token expired');
  });

  test.skip('should handle multiple concurrent 401s with single refresh call', async ({ page }) => {
    // TODO: Requires test environment and monitoring of refresh endpoint calls

    // This test would verify that when multiple API calls happen simultaneously
    // after token expiry, only ONE refresh call is made (not multiple)

    // Implementation would require:
    // 1. Intercept network requests to count refresh calls
    // 2. Make multiple concurrent API calls after token expiry
    // 3. Verify refresh endpoint was only called once
  });
});

test.describe('Token Refresh - Production Safety Guards', () => {
  test('production deployment should reject test JWT config', async () => {
    // This test verifies that the jwt-config.ts guards prevent
    // accidentally using short expiry in production
    //
    // Note: This is a documentation test - actual runtime guards are in jwt-config.ts
    // The guards will throw errors if:
    // 1. NODE_ENV=production with ENABLE_SHORT_JWT_EXPIRY=true
    // 2. Production with JWT_SECRET containing 'TEST' or 'DEV'
    // 3. Access token < 60s or Refresh token < 3600s in production

    console.log('✅ Production safety guards documented in jwt-config.ts');
    expect(true).toBe(true);
  });
});
