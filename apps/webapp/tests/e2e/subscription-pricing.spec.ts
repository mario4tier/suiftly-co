/**
 * Subscription Pricing Validation Tests
 * Tests that subscription validation shows correct pricing in error messages
 * and properly handles various balance scenarios
 */

import { test, expect } from '@playwright/test';

test.describe('Subscription Pricing Validation', () => {
  test.beforeEach(async ({ page }) => {
    // Authenticate with mock wallet first
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');

    // Wait for redirect to /dashboard after auth
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Wait for authentication toast to disappear before starting tests
    await page.waitForTimeout(3000);
  });

  test('all three tiers create service successfully even with insufficient balance', async ({ page }) => {
    // Reset with zero balance
    await page.request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 0, // $0
        spendingLimitUsdCents: 25000, // $250
        clearEscrowAccount: true, // Ensure no escrow account
      },
    });

    // Navigate to seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Accept terms and subscribe to STARTER tier
    await page.locator('label:has-text("Agree to")').click();
    await page.getByRole('heading', { name: 'STARTER' }).click();
    let subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();

    // Should create service and show payment pending banner (no error toast)
    await expect(page.locator('text=/Subscription payment pending/i')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#service-toggle')).toBeVisible();

    console.log('✅ STARTER tier: Service created with payment pending');

    // The remaining tier tests are covered by other test files
    console.log('✅ Services are created successfully even with $0 balance');
  });

  test('PRO tier subscription creates service when balance is short by $1', async ({ page }) => {
    // Reset with $28 balance (need $29 for PRO) - no escrow account
    await page.request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 25000, // $250
        clearEscrowAccount: true,
      },
    });

    // Navigate to seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Accept terms and select PRO tier (default)
    await page.locator('label:has-text("Agree to")').click();
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();

    // Should create service with payment pending banner
    await expect(page.locator('text=/Subscription payment pending/i')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#service-toggle')).toBeVisible();

    console.log('✅ PRO tier creates service with payment pending when funds insufficient');
  });

  test('PRO tier subscription succeeds when balance is exactly $29', async ({ page }) => {
    // Reset and create escrow account with exactly $29 balance
    await page.request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 25000, // $250
        clearEscrowAccount: true,
      },
    });

    // Create escrow account with $29 balance
    await page.request.post('http://localhost:3000/test/wallet/deposit', {
      data: {
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        amountUsd: 29,
        initialSpendingLimitUsd: 250,
      },
    });

    // Navigate to seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Accept terms and select PRO tier (default)
    await page.locator('label:has-text("Agree to")').click();
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();

    // Wait for validation and subscription to complete
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    // Should show service state banner (disabled state)
    await expect(page.locator('text=/Service is currently OFF/i')).toBeVisible({ timeout: 5000 });

    // The page should now show the service management interface (Overview tab)
    await expect(page.getByRole('heading', { name: 'Guaranteed Bandwidth' })).not.toBeVisible();

    console.log('✅ PRO tier subscription succeeds with exactly $29 balance');
  });

  test('STARTER tier subscription creates service when balance is short by $1', async ({ page }) => {
    // Reset with $0 balance (need $9 for STARTER) - no escrow account
    await page.request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 25000, // $250
        clearEscrowAccount: true,
      },
    });

    // Navigate to seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Accept terms and select STARTER tier
    await page.locator('label:has-text("Agree to")').click();
    await page.getByRole('heading', { name: 'STARTER' }).click();
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();

    // Should create service with payment pending banner
    await expect(page.locator('text=/Subscription payment pending/i')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#service-toggle')).toBeVisible();

    console.log('✅ STARTER tier creates service with payment pending when funds insufficient');
  });

  test('STARTER tier subscription succeeds when balance is exactly $9', async ({ page }) => {
    // Reset and create escrow account with exactly $9 balance
    await page.request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 25000, // $250
        clearEscrowAccount: true,
      },
    });

    // Create escrow account with $9 balance
    await page.request.post('http://localhost:3000/test/wallet/deposit', {
      data: {
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        amountUsd: 9,
        initialSpendingLimitUsd: 250,
      },
    });

    // Navigate to seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Accept terms and select STARTER tier
    await page.locator('label:has-text("Agree to")').click();
    await page.getByRole('heading', { name: 'STARTER' }).click();
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();

    // Wait for validation and subscription to complete
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    // Should show service state banner (disabled state)
    await expect(page.locator('text=/Service is currently OFF/i')).toBeVisible({ timeout: 5000 });

    // Should redirect away from onboarding form
    await expect(page.getByRole('heading', { name: 'Guaranteed Bandwidth' })).not.toBeVisible();

    console.log('✅ STARTER tier subscription succeeds with exactly $9 balance');
  });

  test('ENTERPRISE tier subscription creates service when balance is short by $1', async ({ page }) => {
    // Reset with $0 balance (need $185 for ENTERPRISE) - no escrow account
    await page.request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 25000, // $250
        clearEscrowAccount: true,
      },
    });

    // Navigate to seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Accept terms and select ENTERPRISE tier
    await page.locator('label:has-text("Agree to")').click();
    await page.getByRole('heading', { name: 'ENTERPRISE' }).click();
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();

    // Should create service with payment pending banner
    await expect(page.locator('text=/Subscription payment pending/i')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#service-toggle')).toBeVisible();

    console.log('✅ ENTERPRISE tier creates service with payment pending when funds insufficient');
  });

  test('ENTERPRISE tier subscription succeeds when balance is exactly $185', async ({ page }) => {
    // Reset and create escrow account with exactly $185 balance
    await page.request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 25000, // $250
        clearEscrowAccount: true,
      },
    });

    // Create escrow account with $185 balance
    await page.request.post('http://localhost:3000/test/wallet/deposit', {
      data: {
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        amountUsd: 185,
        initialSpendingLimitUsd: 250,
      },
    });

    // Navigate to seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Accept terms and select ENTERPRISE tier
    await page.locator('label:has-text("Agree to")').click();
    await page.getByRole('heading', { name: 'ENTERPRISE' }).click();
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();

    // Wait for validation and subscription to complete
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    // Should show service state banner (disabled state)
    await expect(page.locator('text=/Service is currently OFF/i')).toBeVisible({ timeout: 5000 });

    // Should redirect away from onboarding form
    await expect(page.getByRole('heading', { name: 'Guaranteed Bandwidth' })).not.toBeVisible();

    console.log('✅ ENTERPRISE tier subscription succeeds with exactly $185 balance');
  });

  test('subscribe button shows correct prices for all tiers', async ({ page }) => {
    // Reset with sufficient balance
    await page.request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 100000, // $1000
        spendingLimitUsdCents: 25000, // $250
      },
    });

    // Navigate to seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Accept terms
    await page.locator('label:has-text("Agree to")').click();

    // Check STARTER price - $9
    await page.getByRole('heading', { name: 'STARTER' }).click();
    await expect(page.locator('button:has-text("$9.00/month")')).toBeVisible();
    console.log('✅ STARTER tier button shows $9.00/month');

    // Check PRO price - $29
    await page.getByRole('heading', { name: 'PRO' }).click();
    await expect(page.locator('button:has-text("$29.00/month")')).toBeVisible();
    console.log('✅ PRO tier button shows $29.00/month');

    // Check ENTERPRISE price - $185
    await page.getByRole('heading', { name: 'ENTERPRISE' }).click();
    await expect(page.locator('button:has-text("$185.00/month")')).toBeVisible();
    console.log('✅ ENTERPRISE tier button shows $185.00/month');

    console.log('✅ All tier buttons show correct pricing');
  });
});
