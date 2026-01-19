/**
 * Seal Key Rotation E2E Tests
 *
 * Tests API key lifecycle and rotation scenarios through HAProxy:
 * 1. Multiple API keys working simultaneously with service toggle
 * 2. Key rotation workflow (disable old → delete → new key active)
 * 3. Re-enable a disabled key
 *
 * Prerequisites: HAProxy, LM, GM, API server, Seal backend (mseal1)
 */

import { test, expect, type Page } from '@playwright/test';
import { waitAfterMutation } from '../helpers/wait-utils';
import { resetCustomer, ensureTestBalance } from '../helpers/db';
import {
  sealHealthCheck,
  sealHealthCheckWithRetry,
  isHAProxyAvailable,
  isSealBackendAvailable,
  SEAL_PORTS,
} from '../helpers/seal-requests';

const LM_URL = 'http://localhost:22610';
const GM_URL = 'http://localhost:22600';
const API_URL = 'http://localhost:22700';
const SEAL_METERED_PORT = SEAL_PORTS.MAINNET_PUBLIC;

interface LMHealthResponse {
  vaults: Array<{
    type: string;
    customerCount: number;
    applied: { seq: number; at: string } | null;
    processing: object | null;
  }>;
}

interface ApiKeyInfo {
  apiKeyFp: number;
  keyPreview: string;
  fullKey: string;
  isUserEnabled: boolean;
}

async function getLMHealth(): Promise<LMHealthResponse | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${LM_URL}/api/health`, { signal: controller.signal });
    return response.ok ? response.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getCurrentVaultSeq(): Promise<number> {
  const health = await getLMHealth();
  return health?.vaults.find((v) => v.type === 'sma')?.applied?.seq ?? 0;
}

async function waitForVaultSync(expectedMinSeq: number): Promise<void> {
  const maxAttempts = 120;
  const pollInterval = 500;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const health = await getLMHealth();
    const smaVault = health?.vaults.find((v) => v.type === 'sma');
    if (smaVault?.applied && smaVault.applied.seq >= expectedMinSeq && !smaVault.processing) {
      // Give HAProxy time to reload the map after LM applies the vault
      // HAProxy map reload can take a few seconds to propagate
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
  throw new Error(`Vault sync timed out waiting for seq >= ${expectedMinSeq}`);
}

async function triggerGMSync(): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    await fetch(`${GM_URL}/api/queue/sync-all?source=e2e-key-rotation-test`, {
      method: 'POST',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function syncVault(): Promise<void> {
  const seq = await getCurrentVaultSeq();
  await triggerGMSync();
  await waitForVaultSync(seq + 1);
}

async function getApiKeys(
  request: import('@playwright/test').APIRequestContext
): Promise<ApiKeyInfo[]> {
  const response = await request.get(`${API_URL}/test/data/api-keys`);
  if (!response.ok()) throw new Error(`Failed to get API keys: ${await response.text()}`);
  const data = await response.json();
  return (data.apiKeys || []).map((k: any) => ({
    apiKeyFp: k.apiKeyFp,
    keyPreview: `${k.apiKeyId.slice(0, 8)}...${k.apiKeyId.slice(-4)}`,
    fullKey: k.apiKeyId,
    isUserEnabled: k.isUserEnabled,
  }));
}

async function verifyKeyWorks(apiKey: string, label: string): Promise<void> {
  // Use retry to handle transient timing issues after vault sync
  // HAProxy may need time to reload maps after LM processes the vault
  const response = await sealHealthCheckWithRetry(
    { apiKey, port: SEAL_METERED_PORT },
    { maxAttempts: 5, delayMs: 3000, expectedStatus: 200 }
  );
  // DEBUG: Log response details for troubleshooting
  if (response.status !== 200) {
    console.log(`❌ ${label}: got ${response.status}, body: ${JSON.stringify(response.body)}`);
  }
  expect(response.status, `${label} should return 200`).toBe(200);
  console.log(`✅ ${label}: works (200)`);
}

async function verifyKeyRejected(apiKey: string, label: string): Promise<void> {
  const response = await sealHealthCheck({ apiKey, port: SEAL_METERED_PORT });
  expect(response.status, `${label} should return 401`).toBe(401);
  console.log(`✅ ${label}: rejected (401)`);
}

async function verifyServiceDisabled(apiKey: string, label: string): Promise<void> {
  const response = await sealHealthCheck({ apiKey, port: SEAL_METERED_PORT });
  expect(response.status, `${label} should return 403`).toBe(403);
  console.log(`✅ ${label}: service disabled (403)`);
}

/** Subscribe to Seal, enable service, create seal key + package (for cpEnabled) */
async function setupSealService(page: Page, packageSuffix: string): Promise<void> {
  await page.click('text=Seal');
  await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
  await page.locator('label:has-text("Agree to")').click();
  await page.getByRole('heading', { name: 'STARTER' }).click();
  await page.locator('button:has-text("Subscribe to Service")').click();
  await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });
  await page.waitForURL(/\/services\/seal\/overview/, { timeout: 10000 });

  // Enable service if needed
  const toggle = page.locator('button[role="switch"]');
  if ((await toggle.getAttribute('aria-checked')) === 'false') {
    await toggle.click();
    await waitAfterMutation(page);
  }

  // Create seal key and package
  await page.goto('/services/seal/overview?tab=seal-keys');
  await waitAfterMutation(page);
  await page.locator('button:has-text("Add New Seal Key")').click();
  await waitAfterMutation(page);
  await expect(page.locator('text=/Seal key created successfully/i')).toBeVisible({ timeout: 5000 });

  await page.locator('button:has-text("Add Package to this Seal Key")').first().click();
  await waitAfterMutation(page);
  await page.locator('input#packageAddress').fill('0x' + packageSuffix.repeat(64));
  await page.locator('input#name').fill('Test Package');
  await page.locator('button:has-text("Add Package")').last().click();
  await waitAfterMutation(page);
}

async function checkPrerequisites(): Promise<boolean> {
  const [haproxy, lm, backend] = await Promise.all([
    isHAProxyAvailable(),
    getLMHealth(),
    isSealBackendAvailable(),
  ]);
  return !!(haproxy && lm && backend);
}

test.describe('Seal Key Rotation', () => {
  test.beforeEach(async ({ page }) => {
    await resetCustomer(page.request);
    await page.context().clearCookies();
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');
    await waitAfterMutation(page);
    await page.waitForURL('/dashboard', { timeout: 10000 });
    await ensureTestBalance(page.request, 1000, { spendingLimitUsd: 250 });
  });

  test('multiple API keys work simultaneously with service toggle', async ({ page }) => {
    test.setTimeout(300000);
    if (!(await checkPrerequisites())) { test.skip(); return; }

    // Setup: Subscribe, enable, create seal key + package
    await setupSealService(page, 'a');
    console.log('✅ Setup complete');

    // Get first API key and sync
    let apiKeys = await getApiKeys(page.request);
    expect(apiKeys.length).toBe(1);
    const key1 = apiKeys[0].fullKey;
    console.log(`Key 1: ${apiKeys[0].keyPreview}`);
    await syncVault();
    await verifyKeyWorks(key1, 'Key 1 initial');

    // Create second API key
    await page.goto('/services/seal/overview?tab=x-api-key');
    await waitAfterMutation(page);
    await page.locator('button:has-text("Add New API Key")').click();
    await waitAfterMutation(page);
    await expect(page.locator('text=/2 of 2 used/i')).toBeVisible({ timeout: 5000 });

    apiKeys = await getApiKeys(page.request);
    expect(apiKeys.length).toBe(2);
    const key2 = apiKeys[0].fullKey; // Newest first
    console.log(`Key 2: ${apiKeys[0].keyPreview}`);
    await syncVault();

    // Verify both keys work
    await verifyKeyWorks(key1, 'Key 1');
    await verifyKeyWorks(key2, 'Key 2');

    // Toggle service OFF
    await page.goto('/services/seal/overview');
    await waitAfterMutation(page);
    await page.locator('button[role="switch"]').click();
    await waitAfterMutation(page);
    await syncVault();

    // Both keys should return 403
    await verifyServiceDisabled(key1, 'Key 1 (OFF)');
    await verifyServiceDisabled(key2, 'Key 2 (OFF)');

    // Toggle service ON
    await page.locator('button[role="switch"]').click();
    await waitAfterMutation(page);
    await syncVault();

    // Both keys work again
    await verifyKeyWorks(key1, 'Key 1 (ON)');
    await verifyKeyWorks(key2, 'Key 2 (ON)');

    console.log('\n🎉 Multiple API keys test complete!');
  });

  test('key rotation workflow: disable old key, delete it', async ({ page }) => {
    test.setTimeout(300000);
    if (!(await checkPrerequisites())) { test.skip(); return; }

    await setupSealService(page, 'b');
    console.log('✅ Setup complete');

    // Get Key 1 and sync
    let apiKeys = await getApiKeys(page.request);
    expect(apiKeys.length).toBe(1);
    const key1 = apiKeys[0].fullKey;
    const key1Fp = apiKeys[0].apiKeyFp;
    console.log(`Key 1: ${apiKeys[0].keyPreview}`);
    await syncVault();
    await verifyKeyWorks(key1, 'Key 1 initial');

    // Create Key 2
    await page.goto('/services/seal/overview?tab=x-api-key');
    await waitAfterMutation(page);
    await page.locator('button:has-text("Add New API Key")').click();
    await waitAfterMutation(page);
    await expect(page.locator('text=/2 of 2 used/i')).toBeVisible({ timeout: 5000 });

    apiKeys = await getApiKeys(page.request);
    expect(apiKeys.length).toBe(2);
    const key2 = apiKeys.find((k) => k.apiKeyFp !== key1Fp)!.fullKey;
    console.log(`Key 2: ${apiKeys.find((k) => k.apiKeyFp !== key1Fp)!.keyPreview}`);
    await syncVault();
    await verifyKeyWorks(key1, 'Key 1');
    await verifyKeyWorks(key2, 'Key 2');

    // Disable Key 1 (simulating key rotation)
    const key1Row = page.locator(`[data-testid="apik-${key1Fp}"]`);
    await key1Row.locator('button:has-text("Disable")').click();
    await waitAfterMutation(page);
    await page.locator('button:has-text("Disable Key")').last().click();
    await waitAfterMutation(page);
    await expect(page.locator('text=/Disable API Key/i')).not.toBeVisible({ timeout: 5000 });
    console.log('✅ Key 1 disabled');

    await syncVault();
    await verifyKeyRejected(key1, 'Key 1 (disabled)');
    await verifyKeyWorks(key2, 'Key 2 (active)');

    // Delete Key 1 (cleanup)
    await page.reload();
    await waitAfterMutation(page);
    const deleteButton = page.locator(`[data-testid="apik-${key1Fp}"]`).locator('button:has-text("Delete")');
    if (await deleteButton.isVisible()) {
      await deleteButton.click();
      await waitAfterMutation(page);
      await page.locator('button:has-text("Delete Key")').last().click();
      await waitAfterMutation(page);
      console.log('✅ Key 1 deleted');
    }

    // No vault sync needed - delete is soft delete, key already removed from HAProxy when disabled
    await verifyKeyRejected(key1, 'Key 1 (deleted)');
    await verifyKeyWorks(key2, 'Key 2 (only active)');

    console.log('\n🎉 Key rotation complete: Key 1 disabled/deleted, Key 2 active');
  });

  test('re-enable a disabled key', async ({ page }) => {
    test.setTimeout(300000);
    if (!(await checkPrerequisites())) { test.skip(); return; }

    await setupSealService(page, 'c');
    console.log('✅ Setup complete');

    // Get Key 1 and sync
    let apiKeys = await getApiKeys(page.request);
    const key1 = apiKeys[0].fullKey;
    const key1Fp = apiKeys[0].apiKeyFp;
    console.log(`Key 1: ${apiKeys[0].keyPreview}`);
    await syncVault();
    await verifyKeyWorks(key1, 'Key 1 initial');

    // Create Key 2 (need 2 keys to properly test disable/enable)
    await page.goto('/services/seal/overview?tab=x-api-key');
    await waitAfterMutation(page);
    await page.locator('button:has-text("Add New API Key")').click();
    await waitAfterMutation(page);
    await expect(page.locator('text=/2 of 2 used/i')).toBeVisible({ timeout: 5000 });

    apiKeys = await getApiKeys(page.request);
    const key2 = apiKeys.find((k) => k.apiKeyFp !== key1Fp)!.fullKey;
    console.log(`Key 2: ${apiKeys.find((k) => k.apiKeyFp !== key1Fp)!.keyPreview}`);
    await syncVault();
    await verifyKeyWorks(key1, 'Key 1');
    await verifyKeyWorks(key2, 'Key 2');

    // Disable Key 1
    const keyRow = page.locator(`[data-testid="apik-${key1Fp}"]`);
    await keyRow.locator('button:has-text("Disable")').click();
    await waitAfterMutation(page);
    await page.locator('button:has-text("Disable Key")').last().click();
    await waitAfterMutation(page);
    console.log('✅ Key 1 disabled');

    await syncVault();
    await verifyKeyRejected(key1, 'Key 1 (disabled)');
    await verifyKeyWorks(key2, 'Key 2');

    // Re-enable Key 1
    await page.reload();
    await waitAfterMutation(page);
    await page.locator(`[data-testid="apik-${key1Fp}"]`).locator('button:has-text("Enable")').click();
    await waitAfterMutation(page);
    console.log('✅ Key 1 re-enabled');

    await syncVault();
    await verifyKeyWorks(key1, 'Key 1 (re-enabled)');
    await verifyKeyWorks(key2, 'Key 2');

    console.log('\n🎉 Re-enable key test complete!');
  });
});
