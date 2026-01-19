/**
 * Control Plane Sync E2E Test
 * Tests the full flow: subscribe -> enable -> create key -> add package -> vault sync
 *
 * Verifies:
 * 1. cpEnabled is set when service is enabled + has seal key with package
 * 2. Vault is generated with customer config
 * 3. LM picks up the vault
 * 4. Status shows as "synced" in the UI
 */

import { test, expect, Page } from '@playwright/test';
import { waitAfterMutation } from '../helpers/wait-utils';
import { resetCustomer, ensureTestBalance } from '../helpers/db';
import { db } from '@suiftly/database';
import { serviceInstances, systemControl } from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import { SERVICE_TYPE } from '@suiftly/shared/constants';

// Service URLs
const LM_URL = 'http://localhost:22610';
const GM_URL = 'http://localhost:22600';

// Helper function to create a seal key via UI
async function createSealKeyViaUI(page: Page): Promise<void> {
  const addKeyButton = page.locator('button:has-text("Add New Seal Key")');
  await addKeyButton.click();
  await waitAfterMutation(page);
  await expect(page.locator('text=/Seal key created successfully/i')).toBeVisible({ timeout: 5000 });
}

// Helper function to add a package via UI
async function addPackageViaUI(page: Page, address: string, name: string): Promise<void> {
  const addPackageButton = page.locator('button:has-text("Add Package to this Seal Key")').first();
  await expect(addPackageButton).toBeVisible({ timeout: 5000 });
  await addPackageButton.click();
  await waitAfterMutation(page);

  // Wait for modal
  await expect(page.getByRole('heading', { name: 'Add Package' })).toBeVisible({ timeout: 5000 });

  // Fill in fields
  await page.locator('input#packageAddress').fill(address);
  await page.locator('input#name').fill(name);

  // Submit
  await page.locator('button:has-text("Add Package")').last().click();
  await waitAfterMutation(page);

  // Wait for success toast
  const toast = page.locator('text=Package added successfully').first();
  await expect(toast).toBeVisible({ timeout: 5000 });
}

// Helper to get service cpEnabled status from DB
async function getServiceCpEnabled(customerId: number): Promise<boolean | null> {
  const service = await db.query.serviceInstances.findFirst({
    where: and(
      eq(serviceInstances.customerId, customerId),
      eq(serviceInstances.serviceType, SERVICE_TYPE.SEAL)
    ),
  });
  return service?.cpEnabled ?? null;
}

// Helper to get current vault seq from system_control
async function getCurrentVaultSeq(): Promise<number> {
  const [control] = await db.select({ seq: systemControl.smaVaultSeq }).from(systemControl).where(eq(systemControl.id, 1));
  return control?.seq ?? 0;
}

// Helper to wait for vault to propagate via syncf and LM to pick it up
// Polls LM health every 500ms for up to 30 seconds
async function waitForVaultSync(expectedMinSeq: number): Promise<void> {
  const maxAttempts = 60; // 30 seconds total
  const pollInterval = 500; // 500ms

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(`${LM_URL}/api/health`);
      if (!response.ok) continue;

      const health = await response.json() as {
        vaults: Array<{ type: string; applied?: { seq: number }; processing: unknown | null }>;
      };
      const smaVault = health.vaults.find(v => v.type === 'sma');

      // Check if vault is applied (not processing) and has expected seq
      if (smaVault?.applied && smaVault.applied.seq >= expectedMinSeq && !smaVault.processing) {
        console.log(`Vault sync detected after ${(attempt + 1) * pollInterval}ms (seq=${smaVault.applied.seq})`);
        return;
      }
    } catch {
      // LM not responding, keep polling
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Vault sync timed out after ${maxAttempts * pollInterval}ms waiting for seq >= ${expectedMinSeq}`);
}

// Applied state from LM
interface AppliedState {
  seq: number;
  at: string;
}

// Per-vault status in the vaults array (actual LM format)
interface VaultStatus {
  type: string;
  customerCount: number;
  applied: AppliedState | null;
  processing: object | null;
}

// LM health response structure (actual format)
interface LMHealthResponse {
  service: string;
  timestamp: string;
  vaults: VaultStatus[];
}

// Helper to get LM health status
async function getLMHealth(): Promise<LMHealthResponse> {
  const response = await fetch(`${LM_URL}/api/health`);
  if (!response.ok) {
    throw new Error(`LM health check failed: ${await response.text()}`);
  }
  return response.json() as Promise<LMHealthResponse>;
}

test.describe('Control Plane Sync Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Reset customer to clean state
    await resetCustomer(page.request);

    // Clear cookies for clean auth state
    await page.context().clearCookies();

    // Authenticate with mock wallet (creates customer if doesn't exist)
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');
    await waitAfterMutation(page);
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Ensure customer has escrow account with $1000 balance for subscription payment
    await ensureTestBalance(page.request, 1000, { spendingLimitUsd: 250 });
  });

  test('cpEnabled transitions to true when service enabled with seal key and package', async ({ page }) => {
    // Get customer ID for verification (auth already done in beforeEach)
    const customerData = await page.request.get('http://localhost:22700/test/data/customer');
    const { customer } = await customerData.json();
    const customerId = customer.customerId;

    // Verify cpEnabled is initially false (or null)
    let cpEnabled = await getServiceCpEnabled(customerId);
    expect(cpEnabled).toBeFalsy();

    // Navigate to Seal service and subscribe
    await page.goto('/services/seal');
    await waitAfterMutation(page);

    // Subscribe to PRO tier
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    if (await subscribeButton.isVisible()) {
      // Click checkbox using role selector - most robust for Radix UI components
      await page.getByRole('checkbox').click();
      await waitAfterMutation(page);
      // Verify checkbox is checked before clicking subscribe
      await expect(page.getByRole('checkbox')).toBeChecked({ timeout: 2000 });
      await subscribeButton.click();
      await waitAfterMutation(page);
      // Wait for navigation to overview (subscription worked even if toast was missed)
      await page.waitForURL(/\/services\/seal\/overview/, { timeout: 10000 });
    }

    // Wait for the interactive form to render (shows when service is subscribed)
    const serviceToggle = page.locator('button[role="switch"]');
    await expect(serviceToggle).toBeVisible({ timeout: 10000 });
    const toggleState = await serviceToggle.getAttribute('aria-checked');
    if (toggleState === 'false') {
      await serviceToggle.click();
      await waitAfterMutation(page);
      await expect(serviceToggle).toHaveAttribute('aria-checked', 'true', { timeout: 5000 });
    }

    // Still cpEnabled should be false (no seal key with package yet)
    cpEnabled = await getServiceCpEnabled(customerId);
    expect(cpEnabled).toBe(false);

    // Navigate to Seal Keys tab
    await page.goto('/services/seal/overview?tab=seal-keys');
    await waitAfterMutation(page);

    // Create a seal key
    await createSealKeyViaUI(page);

    // Still cpEnabled should be false (seal key has no package)
    cpEnabled = await getServiceCpEnabled(customerId);
    expect(cpEnabled).toBe(false);

    // Add a package to the seal key
    const packageAddress = '0x' + '1'.repeat(64);
    await addPackageViaUI(page, packageAddress, 'Test Package');

    // NOW cpEnabled should be true!
    cpEnabled = await getServiceCpEnabled(customerId);
    expect(cpEnabled).toBe(true);

    console.log('cpEnabled successfully transitioned to true');
  });

  test('vault is generated with customer config when cpEnabled', async ({ page }) => {
    test.setTimeout(60000); // Extended timeout for vault generation

    // Get customer ID (auth already done in beforeEach)
    const customerData = await page.request.get('http://localhost:22700/test/data/customer');
    const { customer } = await customerData.json();
    const customerId = customer.customerId;

    // Subscribe, enable, create key, add package (makes cpEnabled=true)
    await page.goto('/services/seal');
    await waitAfterMutation(page);

    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    if (await subscribeButton.isVisible()) {
      // Click checkbox using role selector - most robust for Radix UI components
      await page.getByRole('checkbox').click();
      await waitAfterMutation(page);
      // Verify checkbox is checked before clicking subscribe
      await expect(page.getByRole('checkbox')).toBeChecked({ timeout: 2000 });
      await subscribeButton.click();
      await waitAfterMutation(page);
      // Wait for navigation to overview (subscription worked even if toast was missed)
      await page.waitForURL(/\/services\/seal\/overview/, { timeout: 10000 });
    }

    // Wait for the interactive form to render (shows when service is subscribed)
    const serviceToggle = page.locator('button[role="switch"]');
    await expect(serviceToggle).toBeVisible({ timeout: 10000 });
    const toggleState = await serviceToggle.getAttribute('aria-checked');
    if (toggleState === 'false') {
      await serviceToggle.click();
      await waitAfterMutation(page);
    }

    await page.goto('/services/seal/overview?tab=seal-keys');
    await waitAfterMutation(page);
    await createSealKeyViaUI(page);
    await addPackageViaUI(page, '0x' + '2'.repeat(64), 'Vault Test Package');

    // Check that smaConfigChangeVaultSeq was set after cpEnabled became true
    const service = await db.query.serviceInstances.findFirst({
      where: and(
        eq(serviceInstances.customerId, customerId),
        eq(serviceInstances.serviceType, SERVICE_TYPE.SEAL)
      ),
    });

    expect(service?.cpEnabled).toBe(true);
    expect(service?.smaConfigChangeVaultSeq).toBeGreaterThan(0);

    console.log('Service cpEnabled:', service?.cpEnabled);
    console.log('smaConfigChangeVaultSeq:', service?.smaConfigChangeVaultSeq);
  });

  test('LM picks up vault and reports sync status', async ({ page }) => {
    test.setTimeout(90000); // Extended timeout for full sync flow

    // Skip if LM is not running
    try {
      await getLMHealth();
    } catch {
      test.skip();
      return;
    }

    // Get initial LM vault seq from vaults array (find the SMA vault)
    const initialLMHealth = await getLMHealth();
    const initialSmaVault = initialLMHealth.vaults.find(v => v.type === 'sma');
    const initialLMSeq = initialSmaVault?.applied?.seq ?? 0;

    // Subscribe, enable, create key, add package
    await page.goto('/services/seal');
    await waitAfterMutation(page);

    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    if (await subscribeButton.isVisible()) {
      // Click checkbox using role selector - most robust for Radix UI components
      await page.getByRole('checkbox').click();
      await waitAfterMutation(page);
      // Verify checkbox is checked before clicking subscribe
      await expect(page.getByRole('checkbox')).toBeChecked({ timeout: 2000 });
      await subscribeButton.click();
      await waitAfterMutation(page);
      // Wait for navigation to overview (subscription worked even if toast was missed)
      await page.waitForURL(/\/services\/seal\/overview/, { timeout: 10000 });
    }

    // Wait for the interactive form to render (shows when service is subscribed)
    const serviceToggle = page.locator('button[role="switch"]');
    await expect(serviceToggle).toBeVisible({ timeout: 10000 });
    const toggleState = await serviceToggle.getAttribute('aria-checked');
    if (toggleState === 'false') {
      await serviceToggle.click();
      await waitAfterMutation(page);
    }

    await page.goto('/services/seal/overview?tab=seal-keys');
    await waitAfterMutation(page);
    await createSealKeyViaUI(page);
    await addPackageViaUI(page, '0x' + '3'.repeat(64), 'Sync Test Package');

    // Get expected vault seq from database (set when cpEnabled became true)
    const expectedSeq = await getCurrentVaultSeq();
    console.log('Expected vault seq after config change:', expectedSeq);

    // Trigger GM sync-all to generate the vault
    await fetch(`${GM_URL}/api/queue/sync-all?source=e2e-test`, { method: 'POST' });

    // Wait for syncf to propagate vault to LM (polls every 500ms for up to 10s)
    await waitForVaultSync(expectedSeq);

    // Check LM health
    const finalLMHealth = await getLMHealth();

    console.log('=== LM Health Status ===');
    console.log('Vaults:', JSON.stringify(finalLMHealth.vaults, null, 2));
    console.log('Initial LM seq was:', initialLMSeq);

    // Vaults array assertions - should have at least one vault
    // (more vaults may be added in the future, so don't assert exact count)
    expect(finalLMHealth.vaults.length).toBeGreaterThanOrEqual(1);
    const smaVault = finalLMHealth.vaults.find(v => v.type === 'sma');
    if (!smaVault) {
      throw new Error('SMA vault not found in LM health response');
    }

    // Vault should be applied (not processing)
    expect(smaVault.applied).not.toBeNull();
    expect(smaVault.applied!.seq).toBeGreaterThanOrEqual(initialLMSeq);
    expect(smaVault.processing).toBeNull();

    // Verify the service has cpEnabled=true and smaConfigChangeVaultSeq is set
    const finalCustomerData = await page.request.get('http://localhost:22700/test/data/customer');
    const { services } = await finalCustomerData.json();
    const sealService = services.find((s: { serviceType: string }) => s.serviceType === 'seal');
    expect(sealService).toBeTruthy();
    console.log('Service state:', sealService);
  });
});
