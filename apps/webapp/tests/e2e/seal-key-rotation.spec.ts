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
import { resetCustomer, ensureTestBalance, subscribePlatformService, getTestApiKeys } from '../helpers/db';
import {
  waitForSealStatus,
  isHAProxyAvailable,
  isSealBackendAvailable,
  SEAL_PORTS,
} from '../helpers/seal-requests';
import {
  waitForStabilization,
  triggerSyncAndWait,
  getGMHealth,
  getLMHealth,
} from '../helpers/vault-sync';

const API_URL = 'http://localhost:22700';
const SEAL_METERED_PORT = SEAL_PORTS.MAINNET_PUBLIC;

type ApiKeyInfo = import('../helpers/db').TestApiKeyInfo;

/**
 * Sync vault changes through the system.
 *
 * Usage pattern for test mutations:
 * 1. BEFORE mutation: `const baseline = await waitForStabilization()` - capture baseline
 * 2. Do mutation (API call, UI click, etc.)
 * 3. AFTER mutation: `await syncVault(baseline.vaultSeq)` - wait for propagation
 * 4. Verify the change took effect
 *
 * @param baselineSeq - The vault seq captured BEFORE the mutation
 */
async function syncVault(baselineSeq: number): Promise<void> {
  await triggerSyncAndWait(baselineSeq, { source: 'e2e-key-rotation-test' });
}

async function getApiKeys(
  request: import('@playwright/test').APIRequestContext
): Promise<ApiKeyInfo[]> {
  return getTestApiKeys(request, 'seal');
}

async function buildPipelineDiagnostic(): Promise<string> {
  const [gm, lm] = await Promise.all([getGMHealth(), getLMHealth()]);
  const gmSeq = gm?.vaults.sma.vaultSeq ?? '?';
  const gmPending = gm?.vaults.sma.hasPending ?? '?';
  const lmSeq = lm?.vaults.find((v) => v.type === 'sma')?.applied?.seq ?? '?';
  return `GM vaultSeq=${gmSeq} hasPending=${gmPending} / LM appliedSeq=${lmSeq}`;
}

async function verifySealStatus(
  apiKey: string,
  label: string,
  expectedStatus: number,
  successEmoji: string,
  description: string
): Promise<void> {
  const response = await waitForSealStatus(
    { apiKey, port: SEAL_METERED_PORT },
    { expectedStatus, timeoutMs: 60_000, pollIntervalMs: 1000 }
  );
  if (response.status !== expectedStatus) {
    const diagnostic = await buildPipelineDiagnostic();
    console.log(
      `❌ ${label}: want ${expectedStatus}, got ${response.status} after ${response.polls} polls ` +
        `(${Math.round(response.elapsedMs / 1000)}s). body=${JSON.stringify(response.body)} | ${diagnostic}`
    );
  }
  expect(
    response.status,
    `${label} should return ${expectedStatus} (${description})`
  ).toBe(expectedStatus);
  console.log(
    `${successEmoji} ${label}: ${description} (${expectedStatus}) after ${response.polls} poll(s), ${Math.round(response.elapsedMs / 1000)}s`
  );
}

async function verifyKeyWorks(apiKey: string, label: string): Promise<void> {
  await verifySealStatus(apiKey, label, 200, '✅', 'works');
}

async function verifyKeyRejected(apiKey: string, label: string): Promise<void> {
  await verifySealStatus(apiKey, label, 401, '✅', 'rejected');
}

async function verifyServiceDisabled(apiKey: string, label: string): Promise<void> {
  await verifySealStatus(apiKey, label, 403, '✅', 'service disabled');
}

/** Subscribe to Seal, enable service, create seal key + package (for cpEnabled) */
async function setupSealService(page: Page, packageSuffix: string): Promise<void> {
  // Subscribe to platform (auto-provisions seal as disabled)
  await subscribePlatformService(page);

  // Navigate to seal overview
  await page.click('text=Seal');
  await page.waitForURL(/\/services\/seal\/overview/, { timeout: 5000 });

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
    await page.click('button:has-text("Mock Wallet 0")');
    await waitAfterMutation(page);
    await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.waitForLoadState('networkidle');
    await ensureTestBalance(page.request, 1000, { spendingLimitUsd: 250 });
  });

  test('multiple API keys work simultaneously with service toggle', async ({ page }) => {
    test.setTimeout(300000);
    if (!(await checkPrerequisites())) { test.skip(); return; }

    // BEFORE setup: get baseline
    let baseline = await waitForStabilization();

    // Setup: Subscribe, enable, create seal key + package
    await setupSealService(page, 'a');
    console.log('✅ Setup complete');

    // AFTER setup: wait for sync with baseline
    await syncVault(baseline.vaultSeq);

    // Get first API key and verify
    let apiKeys = await getApiKeys(page.request);
    expect(apiKeys.length).toBe(1);
    const key1 = apiKeys[0].fullKey;
    console.log(`Key 1: ${apiKeys[0].keyPreview}`);
    await verifyKeyWorks(key1, 'Key 1 initial');

    // BEFORE creating second API key: get baseline
    baseline = await waitForStabilization();
    await page.goto('/services/seal/overview?tab=x-api-key');
    await waitAfterMutation(page);
    await page.locator('button:has-text("Add New API Key")').click();
    await waitAfterMutation(page);
    await expect(page.locator('text=/2 of 2 used/i')).toBeVisible({ timeout: 5000 });

    apiKeys = await getApiKeys(page.request);
    expect(apiKeys.length).toBe(2);
    const key2 = apiKeys[0].fullKey; // Newest first
    console.log(`Key 2: ${apiKeys[0].keyPreview}`);
    // AFTER: wait for sync with baseline
    await syncVault(baseline.vaultSeq);

    // Verify both keys work
    await verifyKeyWorks(key1, 'Key 1');
    await verifyKeyWorks(key2, 'Key 2');

    // Toggle service OFF
    // BEFORE: get baseline
    baseline = await waitForStabilization();
    await page.goto('/services/seal/overview');
    await waitAfterMutation(page);
    await page.locator('button[role="switch"]').click();
    await waitAfterMutation(page);
    // AFTER: wait for sync with baseline
    await syncVault(baseline.vaultSeq);

    // Both keys should return 403
    await verifyServiceDisabled(key1, 'Key 1 (OFF)');
    await verifyServiceDisabled(key2, 'Key 2 (OFF)');

    // Toggle service ON
    // BEFORE: get baseline
    baseline = await waitForStabilization();
    await page.locator('button[role="switch"]').click();
    await waitAfterMutation(page);
    // AFTER: wait for sync with baseline
    await syncVault(baseline.vaultSeq);

    // Both keys work again
    await verifyKeyWorks(key1, 'Key 1 (ON)');
    await verifyKeyWorks(key2, 'Key 2 (ON)');

    console.log('\n🎉 Multiple API keys test complete!');
  });

  test('key rotation workflow: disable old key, delete it', async ({ page }) => {
    test.setTimeout(300000);
    if (!(await checkPrerequisites())) { test.skip(); return; }

    // BEFORE setup: get baseline
    let baseline = await waitForStabilization();

    await setupSealService(page, 'b');
    console.log('✅ Setup complete');

    // AFTER setup: wait for sync with baseline
    await syncVault(baseline.vaultSeq);

    // Get Key 1 and verify
    let apiKeys = await getApiKeys(page.request);
    expect(apiKeys.length).toBe(1);
    const key1 = apiKeys[0].fullKey;
    const key1Fp = apiKeys[0].apiKeyFp;
    console.log(`Key 1: ${apiKeys[0].keyPreview}`);
    await verifyKeyWorks(key1, 'Key 1 initial');

    // BEFORE creating Key 2: get baseline
    baseline = await waitForStabilization();
    await page.goto('/services/seal/overview?tab=x-api-key');
    await waitAfterMutation(page);
    await page.locator('button:has-text("Add New API Key")').click();
    await waitAfterMutation(page);
    await expect(page.locator('text=/2 of 2 used/i')).toBeVisible({ timeout: 5000 });

    apiKeys = await getApiKeys(page.request);
    expect(apiKeys.length).toBe(2);
    const key2 = apiKeys.find((k) => k.apiKeyFp !== key1Fp)!.fullKey;
    console.log(`Key 2: ${apiKeys.find((k) => k.apiKeyFp !== key1Fp)!.keyPreview}`);
    // AFTER: wait for sync with baseline
    await syncVault(baseline.vaultSeq);
    await verifyKeyWorks(key1, 'Key 1');
    await verifyKeyWorks(key2, 'Key 2');

    // BEFORE disabling Key 1: get baseline
    baseline = await waitForStabilization();
    const key1Row = page.locator(`[data-testid="apik-${key1Fp}"]`);
    await key1Row.locator('button:has-text("Disable")').click();
    await waitAfterMutation(page);
    await page.locator('button:has-text("Disable Key")').last().click();
    await waitAfterMutation(page);
    await expect(page.locator('text=/Disable API Key/i')).not.toBeVisible({ timeout: 5000 });
    console.log('✅ Key 1 disabled');

    // AFTER: wait for sync with baseline
    await syncVault(baseline.vaultSeq);
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

    // BEFORE setup: get baseline
    let baseline = await waitForStabilization();

    await setupSealService(page, 'c');
    console.log('✅ Setup complete');

    // AFTER setup: wait for sync with baseline
    await syncVault(baseline.vaultSeq);

    // Get Key 1 and verify
    let apiKeys = await getApiKeys(page.request);
    const key1 = apiKeys[0].fullKey;
    const key1Fp = apiKeys[0].apiKeyFp;
    console.log(`Key 1: ${apiKeys[0].keyPreview}`);
    await verifyKeyWorks(key1, 'Key 1 initial');

    // BEFORE creating Key 2: get baseline
    baseline = await waitForStabilization();
    await page.goto('/services/seal/overview?tab=x-api-key');
    await waitAfterMutation(page);
    await page.locator('button:has-text("Add New API Key")').click();
    await waitAfterMutation(page);
    await expect(page.locator('text=/2 of 2 used/i')).toBeVisible({ timeout: 5000 });

    apiKeys = await getApiKeys(page.request);
    const key2 = apiKeys.find((k) => k.apiKeyFp !== key1Fp)!.fullKey;
    console.log(`Key 2: ${apiKeys.find((k) => k.apiKeyFp !== key1Fp)!.keyPreview}`);
    // AFTER: wait for sync with baseline
    await syncVault(baseline.vaultSeq);
    await verifyKeyWorks(key1, 'Key 1');
    await verifyKeyWorks(key2, 'Key 2');

    // BEFORE disabling Key 1: get baseline
    baseline = await waitForStabilization();
    const keyRow = page.locator(`[data-testid="apik-${key1Fp}"]`);
    await keyRow.locator('button:has-text("Disable")').click();
    await waitAfterMutation(page);
    await page.locator('button:has-text("Disable Key")').last().click();
    await waitAfterMutation(page);
    console.log('✅ Key 1 disabled');

    // AFTER: wait for sync with baseline
    await syncVault(baseline.vaultSeq);
    await verifyKeyRejected(key1, 'Key 1 (disabled)');
    await verifyKeyWorks(key2, 'Key 2');

    // BEFORE re-enabling Key 1: get baseline
    baseline = await waitForStabilization();
    await page.reload();
    await waitAfterMutation(page);
    await page.locator(`[data-testid="apik-${key1Fp}"]`).locator('button:has-text("Enable")').click();
    await waitAfterMutation(page);
    console.log('✅ Key 1 re-enabled');

    // AFTER: wait for sync with baseline
    await syncVault(baseline.vaultSeq);
    await verifyKeyWorks(key1, 'Key 1 (re-enabled)');
    await verifyKeyWorks(key2, 'Key 2');

    console.log('\n🎉 Re-enable key test complete!');
  });
});
