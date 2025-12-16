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
import { serviceInstances, sealKeys, systemControl } from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import { SERVICE_TYPE } from '@suiftly/shared/constants';

// Sudob API for test reset and vault sync
const SUDOB_URL = 'http://localhost:22800';
const LM_URL = 'http://localhost:22610';

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

// Helper to trigger vault sync via sudob (simulates sync-files)
async function triggerVaultSync(): Promise<void> {
  const response = await fetch(`${SUDOB_URL}/api/vault/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vaultType: 'sma' }),
  });
  if (!response.ok) {
    throw new Error(`Vault sync failed: ${await response.text()}`);
  }
}

// Component confirmation status
interface ComponentConfirmation {
  confirmedAt: string;
}

// Key-server confirmation status
interface KeyServersApplied {
  mseal1: ComponentConfirmation;
  mseal2: ComponentConfirmation;
}

// Applied state (fully confirmed)
interface AppliedState {
  seq: number;
  startedAt: string;
  haproxy: ComponentConfirmation;
  keyServers: KeyServersApplied;
}

// Per-vault status in the vaults array
interface VaultStatus {
  type: string;
  seq: number;
  customerCount: number;
  inSync: boolean; // Vault loaded + HAProxy updated (service operational)
  fullSync: boolean; // All components confirmed including key-servers
  applied: AppliedState | null;
  processing: object | null;
  lastError: string | null;
}

// LM health response structure (no 'status' field - if there's a response, LM is up)
interface LMHealthResponse {
  service: string;
  timestamp: string;
  vaults: VaultStatus[];
  inSync: boolean; // All vaults have HAProxy updated (service operational)
  fullSync: boolean; // All vaults have all components confirmed
}

// Helper to get LM health status
async function getLMHealth(): Promise<LMHealthResponse> {
  const response = await fetch(`${LM_URL}/api/health`);
  if (!response.ok) {
    throw new Error(`LM health check failed: ${await response.text()}`);
  }
  return response.json();
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
      await page.locator('label:has-text("Agree to")').click();
      await waitAfterMutation(page);
      await subscribeButton.click();
      await waitAfterMutation(page);
      // Wait for navigation to overview (subscription worked even if toast was missed)
      await page.waitForURL(/\/services\/seal\/overview/, { timeout: 10000 });
    }

    // Enable the service
    const serviceToggle = page.locator('button[role="switch"]');
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

    // Get initial vault seq
    const initialSeq = await getCurrentVaultSeq();

    // Subscribe, enable, create key, add package (makes cpEnabled=true)
    await page.goto('/services/seal');
    await waitAfterMutation(page);

    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    if (await subscribeButton.isVisible()) {
      await page.locator('label:has-text("Agree to")').click();
      await waitAfterMutation(page);
      await subscribeButton.click();
      await waitAfterMutation(page);
      // Wait for navigation to overview (subscription worked even if toast was missed)
      await page.waitForURL(/\/services\/seal\/overview/, { timeout: 10000 });
    }

    const serviceToggle = page.locator('button[role="switch"]');
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

    // Get customer ID (auth already done in beforeEach)
    const customerData = await page.request.get('http://localhost:22700/test/data/customer');
    const { customer } = await customerData.json();

    // Get initial LM vault seq from vaults array
    const initialLMHealth = await getLMHealth();
    const initialLMSeq = initialLMHealth.vaults[0]?.seq ?? 0;

    // Subscribe, enable, create key, add package
    await page.goto('/services/seal');
    await waitAfterMutation(page);

    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    if (await subscribeButton.isVisible()) {
      await page.locator('label:has-text("Agree to")').click();
      await waitAfterMutation(page);
      await subscribeButton.click();
      await waitAfterMutation(page);
      // Wait for navigation to overview (subscription worked even if toast was missed)
      await page.waitForURL(/\/services\/seal\/overview/, { timeout: 10000 });
    }

    const serviceToggle = page.locator('button[role="switch"]');
    const toggleState = await serviceToggle.getAttribute('aria-checked');
    if (toggleState === 'false') {
      await serviceToggle.click();
      await waitAfterMutation(page);
    }

    await page.goto('/services/seal/overview?tab=seal-keys');
    await waitAfterMutation(page);
    await createSealKeyViaUI(page);
    await addPackageViaUI(page, '0x' + '3'.repeat(64), 'Sync Test Package');

    // Trigger vault sync (simulates sync-files) - optional if LM not running
    await triggerVaultSync();

    // Wait a bit for LM to process
    await page.waitForTimeout(2000);

    // Force LM to reload vault
    await fetch(`${LM_URL}/api/vault/reload`, { method: 'POST' });

    // Wait for LM to process
    await page.waitForTimeout(1000);

    // Check LM health
    const finalLMHealth = await getLMHealth();

    console.log('=== LM Health Status ===');
    console.log('Vaults:', JSON.stringify(finalLMHealth.vaults, null, 2));
    console.log('inSync:', finalLMHealth.inSync);
    console.log('fullSync:', finalLMHealth.fullSync);
    console.log('Initial LM seq was:', initialLMSeq);

    // Global sync status (if we got a response, LM is up)
    expect(finalLMHealth.inSync).toBe(true);
    expect(finalLMHealth.fullSync).toBe(true);

    // Vaults array assertions
    expect(finalLMHealth.vaults).toHaveLength(1);
    const smaVault = finalLMHealth.vaults[0];
    expect(smaVault.type).toBe('sma');
    expect(smaVault.seq).toBeGreaterThanOrEqual(initialLMSeq);

    // Per-vault sync status
    expect(smaVault.inSync).toBe(true);
    expect(smaVault.fullSync).toBe(true);

    // Vault should be applied (not processing)
    expect(smaVault.applied).not.toBeNull();
    expect(smaVault.processing).toBeNull();
    expect(smaVault.lastError).toBeNull();

    // Applied state should have all components confirmed
    expect(smaVault.applied!.haproxy.confirmedAt).toBeTruthy();
    expect(smaVault.applied!.keyServers.mseal1.confirmedAt).toBeTruthy();
    expect(smaVault.applied!.keyServers.mseal2.confirmedAt).toBeTruthy();

    // Verify the service has cpEnabled=true and smaConfigChangeVaultSeq is set
    const finalCustomerData = await page.request.get('http://localhost:22700/test/data/customer');
    const { services } = await finalCustomerData.json();
    const sealService = services.find((s: { serviceType: string }) => s.serviceType === 'seal');
    expect(sealService).toBeTruthy();
    console.log('Service state:', sealService);
  });
});
