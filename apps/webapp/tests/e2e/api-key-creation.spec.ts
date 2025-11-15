/**
 * API Key Creation on Service Subscription E2E Test
 *
 * Validates that exactly one API key is automatically generated
 * when a customer subscribes to the Seal service.
 */

import { test, expect } from '@playwright/test';

test.describe('API Key Creation on Subscription', () => {
  test.beforeEach(async ({ page }) => {
    // Authenticate with mock wallet
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');

    // Wait for redirect to dashboard after auth
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Wait for authentication toast to disappear
    await page.waitForTimeout(3000);
  });

  test('creates exactly one API key when subscribing to Seal service', async ({ page, request }) => {
    // Reset database
    const resetResponse = await request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 0, // Will be set via deposit
        spendingLimitUsdCents: 25000, // $250
      },
    });
    expect(resetResponse.ok()).toBe(true);

    // Create escrow account and deposit funds
    const depositResponse = await request.post('http://localhost:3000/test/wallet/deposit', {
      data: {
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        amountUsd: 10, // $10 (enough for Starter tier $9)
        initialSpendingLimitUsd: 250, // $250
      },
    });
    expect(depositResponse.ok()).toBe(true);
    const depositData = await depositResponse.json();
    expect(depositData.success).toBe(true);

    console.log('✅ Database reset and escrow account created with $10 balance');

    // Navigate to Seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    console.log('✅ Navigated to Seal service page');

    // Accept terms and select STARTER tier
    await page.locator('label:has-text("Agree to")').click();
    await page.getByRole('heading', { name: 'STARTER' }).click();

    console.log('✅ Accepted terms and selected STARTER tier');

    // Subscribe to service
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await subscribeButton.click();

    // Wait for subscription success
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    console.log('✅ Subscription successful');

    // Wait for page to settle
    await page.waitForTimeout(1000);

    // Query database to verify API key was created
    const apiKeysResponse = await request.get('http://localhost:3000/test/data/api-keys');
    expect(apiKeysResponse.ok()).toBe(true);

    const apiKeysData = await apiKeysResponse.json();

    console.log('API Keys Data:', JSON.stringify(apiKeysData, null, 2));

    // Validate exactly one API key was created
    expect(apiKeysData.apiKeys).toHaveLength(1);
    console.log('✅ Exactly 1 API key created');

    const apiKey = apiKeysData.apiKeys[0];

    // Validate API key properties
    expect(apiKey.serviceType).toBe('seal');
    console.log('✅ API key service type is "seal"');

    expect(apiKey.isUserEnabled).toBe(true);
    console.log('✅ API key is active');

    // Validate API key format (should be 37 characters: S + 36 chars)
    expect(apiKey.apiKeyId).toHaveLength(37);
    console.log('✅ API key has correct length (37 characters)');

    expect(apiKey.apiKeyId[0]).toBe('S');
    console.log('✅ API key starts with "S" (Seal service)');

    // Validate metadata
    expect(apiKey.metadata).toBeDefined();
    expect(apiKey.metadata.generatedAt).toBe('subscription');
    console.log('✅ API key metadata indicates generation at subscription');

    // Validate timestamps
    expect(apiKey.createdAt).toBeDefined();
    expect(apiKey.revokedAt).toBeNull();
    console.log('✅ API key has createdAt timestamp and no revokedAt');

    console.log('\n🎉 All validations passed!');
    console.log('Summary:');
    console.log('  - 1 API key created automatically');
    console.log('  - Service type: seal');
    console.log('  - API key format: 37 chars starting with "S"');
    console.log('  - Active and not revoked');
    console.log('  - Generated during subscription');
  });

  test('API key count starts at 0 before subscription', async ({ page, request }) => {
    // Reset database
    const resetResponse = await request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 25000, // $250
      },
    });
    expect(resetResponse.ok()).toBe(true);

    // Create escrow account (needed for future tests, but not for this check)
    const depositResponse = await request.post('http://localhost:3000/test/wallet/deposit', {
      data: {
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        amountUsd: 10,
        initialSpendingLimitUsd: 250,
      },
    });
    expect(depositResponse.ok()).toBe(true);

    console.log('✅ Database reset and escrow account created');

    // Query database before subscription
    const apiKeysResponse = await request.get('http://localhost:3000/test/data/api-keys');
    expect(apiKeysResponse.ok()).toBe(true);

    const apiKeysData = await apiKeysResponse.json();

    // Should have zero API keys before subscription
    expect(apiKeysData.apiKeys).toHaveLength(0);
    console.log('✅ Zero API keys before subscription');
  });

  test('service starts in DISABLED state with subscription_charge_pending=false', async ({ page, request }) => {
    // Reset database
    await request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 25000, // $250
      },
    });

    // Create escrow account and deposit funds
    const depositResponse = await request.post('http://localhost:3000/test/wallet/deposit', {
      data: {
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        amountUsd: 10,
        initialSpendingLimitUsd: 250,
      },
    });
    expect(depositResponse.ok()).toBe(true);

    // Navigate and subscribe
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
    await page.locator('label:has-text("Agree to")').click();
    await page.getByRole('heading', { name: 'STARTER' }).click();
    await page.locator('button:has-text("Subscribe to Service")').click();

    // Wait for subscription success
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    // Wait for page to show disabled state
    await expect(page.locator('text=/Service is currently OFF/i')).toBeVisible({ timeout: 5000 });
    console.log('✅ Service shows as disabled after subscription');

    // Query service state from API
    const serviceResponse = await request.get('http://localhost:3000/test/data/service-instance?serviceType=seal');
    expect(serviceResponse.ok()).toBe(true);

    const serviceData = await serviceResponse.json();

    expect(serviceData.state).toBe('disabled');
    console.log('✅ Service state is "disabled"');

    expect(serviceData.isUserEnabled).toBe(false);
    console.log('✅ Service isUserEnabled is false');

    expect(serviceData.subscriptionChargePending).toBe(false);
    console.log('✅ subscriptionChargePending is false (payment succeeded)');
  });

  test('seal keys and allowlist start at 0 count', async ({ page, request }) => {
    // Reset database
    await request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 25000, // $250
      },
    });

    // Create escrow account and deposit funds
    const depositResponse = await request.post('http://localhost:3000/test/wallet/deposit', {
      data: {
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        amountUsd: 10,
        initialSpendingLimitUsd: 250,
      },
    });
    expect(depositResponse.ok()).toBe(true);

    // Navigate and subscribe
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
    await page.locator('label:has-text("Agree to")').click();
    await page.getByRole('heading', { name: 'STARTER' }).click();
    await page.locator('button:has-text("Subscribe to Service")').click();

    // Wait for subscription success
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    // Query seal keys from database
    const sealKeysResponse = await request.get('http://localhost:3000/test/data/seal-keys');
    expect(sealKeysResponse.ok()).toBe(true);

    const sealKeysData = await sealKeysResponse.json();

    // Should have zero seal keys after subscription
    expect(sealKeysData.sealKeys).toHaveLength(0);
    console.log('✅ Zero seal keys after subscription (expected)');

    // Query service config to check allowlist
    const serviceResponse = await request.get('http://localhost:3000/test/data/service-instance?serviceType=seal');
    expect(serviceResponse.ok()).toBe(true);

    const serviceData = await serviceResponse.json();

    const allowlist = serviceData.config?.ipAllowlist || [];
    expect(allowlist).toHaveLength(0);
    console.log('✅ Zero allowlist entries after subscription (expected)');
  });
});
