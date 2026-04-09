/**
 * API Key Creation on Platform Subscription E2E Test
 *
 * Validates that when a customer subscribes to the platform service,
 * a Seal API key is automatically created (via auto-provisioning).
 */

import { test, expect } from '@playwright/test';
import { ensureTestBalance, subscribePlatformService } from '../helpers/db';
import { API_KEY_ORIGIN } from '@suiftly/shared/constants';

test.describe('API Key Creation on Platform Subscription', () => {
  test.beforeEach(async ({ page, request }) => {
    // Reset database
    await request.post('http://localhost:22700/test/data/reset', {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 25000,
      },
    });

    // Create escrow and fund
    await ensureTestBalance(request, 10);

    // Authenticate
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);
  });

  test('creates seal API key automatically when subscribing to platform', async ({ page, request }) => {
    // Subscribe to platform (auto-provisions seal with API key)
    await subscribePlatformService(page);

    // Query database to verify API key was created
    const apiKeysResponse = await request.get('http://localhost:22700/test/data/api-keys');
    expect(apiKeysResponse.ok()).toBe(true);

    const apiKeysData = await apiKeysResponse.json();
    console.log('API Keys Data:', JSON.stringify(apiKeysData, null, 2));

    // Platform subscription auto-provisions seal + grpc + graphql, each with an API key
    expect(apiKeysData.apiKeys).toHaveLength(3);

    const sealKey = apiKeysData.apiKeys.find((k: any) => k.serviceType === 'seal');
    expect(sealKey).toBeDefined();
    expect(sealKey.isUserEnabled).toBe(true);
    expect(sealKey.apiKeyId).toHaveLength(37);
    expect(sealKey.apiKeyId[0]).toBe('S');
    // Key was auto-provisioned at login, not overwritten at subscription
    expect(sealKey.metadata?.generatedAt).toBe(API_KEY_ORIGIN.SERVICE_PROVISIONING);
    expect(sealKey.revokedAt).toBeNull();

    console.log('✅ 3 API keys auto-created (seal, grpc, graphql) on platform subscription');
  });

  test('API keys are auto-provisioned at login before platform subscription', async ({ page, request }) => {
    // API keys are now auto-provisioned at login via ensureServiceInstancesProvisioned
    const apiKeysResponse = await request.get('http://localhost:22700/test/data/api-keys');
    expect(apiKeysResponse.ok()).toBe(true);

    const apiKeysData = await apiKeysResponse.json();
    expect(apiKeysData.apiKeys).toHaveLength(3);

    // All keys should have 'service_provisioning' origin (not yet platform-subscribed)
    for (const key of apiKeysData.apiKeys) {
      expect(key.metadata?.generatedAt).toBe(API_KEY_ORIGIN.SERVICE_PROVISIONING);
    }

    console.log('✅ 3 API keys auto-provisioned at login (before platform subscription)');
  });

  test('seal service starts in DISABLED state after platform subscribe', async ({ page, request }) => {
    // Subscribe to platform (auto-provisions seal as disabled)
    await subscribePlatformService(page);

    // Query seal service state from API
    const serviceResponse = await request.get('http://localhost:22700/test/data/service-instance?serviceType=seal');
    expect(serviceResponse.ok()).toBe(true);

    const serviceData = await serviceResponse.json();
    expect(serviceData.state).toBe('disabled');
    expect(serviceData.isUserEnabled).toBe(false);
    expect(serviceData.subscriptionChargePending).toBe(false);

    console.log('✅ Seal service is disabled with no pending charge after platform subscription');
  });

  test('seal keys and allowlist start at 0 after platform subscribe', async ({ page, request }) => {
    // Subscribe to platform (auto-provisions seal)
    await subscribePlatformService(page);

    // Query seal keys - should have none (seal created but no keys yet)
    const sealKeysResponse = await request.get('http://localhost:22700/test/data/seal-keys');
    expect(sealKeysResponse.ok()).toBe(true);
    const sealKeysData = await sealKeysResponse.json();
    expect(sealKeysData.sealKeys).toHaveLength(0);

    // Query service config - allowlist should be empty
    const serviceResponse = await request.get('http://localhost:22700/test/data/service-instance?serviceType=seal');
    expect(serviceResponse.ok()).toBe(true);
    const serviceData = await serviceResponse.json();
    const allowlist = serviceData.config?.ipAllowlist || [];
    expect(allowlist).toHaveLength(0);

    console.log('✅ Zero seal keys and allowlist entries after platform subscription');
  });
});
