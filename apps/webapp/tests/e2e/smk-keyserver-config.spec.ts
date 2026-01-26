/**
 * SMK Vault → Keyserver Config E2E Tests
 *
 * Tests that seal keys created trigger SMK (Seal Mainnet Keyserver) vault
 * generation with the correct keyserver client config format.
 *
 * Architecture:
 * 1. Customer creates seal key (via setupCpEnabled helper)
 * 2. GM generates SMK vault with keyserver client configs
 * 3. LM reads SMK vault and generates key-server-config.yaml
 * 4. Seal server uses config to serve the correct keys
 *
 * SMK Vault Format (expected by cfg_mgr_seal.py):
 * {
 *   "key_<id>": "{\"key_type\":\"Derived\",\"derivation_index\":1,...}",
 *   ...
 * }
 *
 * This is DIFFERENT from SMA vault which uses customer-based structure.
 *
 * Prerequisites:
 * - GM running for vault generation
 * - Database running
 */

import { test, expect } from '@playwright/test';
import { resetCustomer, setupCpEnabled, getCustomerData } from '../helpers/db';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// kvcrypt command helper
async function runKvcrypt(args: string[]): Promise<{ status: string; data?: Record<string, string>; error?: string }> {
  try {
    const { stdout } = await execAsync(
      `cd /home/olet/mhaxbe/packages/kvcrypt && npx kvcrypt ${args.join(' ')}`,
      { timeout: 30000 }
    );
    return JSON.parse(stdout);
  } catch (error) {
    return { status: 'error', error: String(error) };
  }
}

// Parsed SMK client config
interface SMKClientConfig {
  name: string;
  keyType: 'Derived' | 'Imported' | 'Exported';
  derivationIndex?: number;
  deprecatedDerivationIndex?: number;
  envVar?: string;
  objectId: string;
  packageIds: string[];
}

// Get SMK vault contents
async function getSMKVault(): Promise<{
  seq: number;
  clients: SMKClientConfig[];
}> {
  const result = await runKvcrypt(['get-all', 'smk', '--show-value']);

  if (result.status !== 'success' || !result.data) {
    return { seq: 0, clients: [] };
  }

  const clients: SMKClientConfig[] = [];
  let seq = 0;

  for (const [key, value] of Object.entries(result.data)) {
    if (key === '__vault') {
      try {
        const meta = JSON.parse(value);
        seq = meta.seq || 0;
      } catch {
        // Ignore parse errors
      }
      continue;
    }

    // Skip metadata keys
    if (key.startsWith('_')) continue;

    try {
      const config = JSON.parse(value);
      clients.push({
        name: key,
        keyType: config.key_type,
        derivationIndex: config.derivation_index,
        deprecatedDerivationIndex: config.deprecated_derivation_index,
        envVar: config.env_var,
        objectId: config.key_server_object_id,
        packageIds: config.package_ids || [],
      });
    } catch (e) {
      console.warn(`Failed to parse SMK entry '${key}': ${e}`);
    }
  }

  return { seq, clients };
}

// Wait for SMK vault to contain expected client count
async function waitForSMKVault(
  expectedMinCount: number,
  options?: { timeout?: number; pollInterval?: number }
): Promise<{
  success: boolean;
  seq: number;
  clients: SMKClientConfig[];
}> {
  const timeout = options?.timeout ?? 30000;
  const pollInterval = options?.pollInterval ?? 2000;
  const maxAttempts = Math.ceil(timeout / pollInterval);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const vault = await getSMKVault();

    if (vault.clients.length >= expectedMinCount) {
      return { success: true, ...vault };
    }

    console.log(
      `  SMK vault: ${vault.clients.length}/${expectedMinCount} clients (attempt ${attempt + 1}/${maxAttempts})`
    );

    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  const finalVault = await getSMKVault();
  return { success: false, ...finalVault };
}

test.describe('SMK Vault Keyserver Config', () => {
  test.beforeEach(async ({ request }) => {
    // Reset to clean customer state
    await resetCustomer(request);
  });

  test('setupCpEnabled populates SMK vault with correct keyserver config format', async ({ request }) => {
    test.setTimeout(90000);

    // === STEP 1: Get initial SMK vault state ===
    const initialVault = await getSMKVault();
    console.log(`Initial SMK vault: seq=${initialVault.seq}, clients=${initialVault.clients.length}`);

    // === STEP 2: Use setupCpEnabled helper to create seal key with package ===
    // This is the same helper used by other tests - proven to work
    const setupResult = await setupCpEnabled(request);
    expect(setupResult.success).toBe(true);
    expect(setupResult.sealKeyId).toBeDefined();
    console.log(`✅ setupCpEnabled completed: sealKeyId=${setupResult.sealKeyId}`);

    // === STEP 3: Wait for SMK vault to be updated by GM ===
    const expectedClientCount = initialVault.clients.length + 1;
    console.log(`Waiting for SMK vault to have ${expectedClientCount} client(s)...`);

    const updatedVault = await waitForSMKVault(expectedClientCount, { timeout: 60000 });

    if (!updatedVault.success) {
      console.log('SMK vault contents:', JSON.stringify(updatedVault, null, 2));
      throw new Error(
        `SMK vault not updated: expected >=${expectedClientCount} clients, got ${updatedVault.clients.length}`
      );
    }

    console.log(`✅ SMK vault updated: seq=${updatedVault.seq}, clients=${updatedVault.clients.length}`);

    // === STEP 4: Find the new client entry ===
    const newClient = updatedVault.clients.find(
      (c) => c.name === `key_${setupResult.sealKeyId}`
    );

    expect(newClient).toBeDefined();
    console.log('New client entry:', JSON.stringify(newClient, null, 2));

    // === STEP 5: Verify SMK vault schema matches keyserver config format ===
    // This is the format expected by cfg_mgr_seal.py (see SEAL_SERVER_FEATURE.md)
    expect(newClient!.keyType).toBe('Derived');
    expect(typeof newClient!.derivationIndex).toBe('number');
    expect(newClient!.derivationIndex).toBeGreaterThanOrEqual(0);
    expect(newClient!.objectId).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(Array.isArray(newClient!.packageIds)).toBe(true);
    expect(newClient!.packageIds.length).toBeGreaterThan(0);

    // For Derived keys, these should NOT be present
    expect(newClient!.deprecatedDerivationIndex).toBeUndefined();
    expect(newClient!.envVar).toBeUndefined();

    console.log('✅ SMK vault entry matches keyserver config schema:');
    console.log(`   - Name: ${newClient!.name}`);
    console.log(`   - Key Type: ${newClient!.keyType}`);
    console.log(`   - Derivation Index: ${newClient!.derivationIndex}`);
    console.log(`   - Object ID: ${newClient!.objectId.substring(0, 20)}...`);
    console.log(`   - Package Count: ${newClient!.packageIds.length}`);
  });

  test('SMK vault entries have valid hex addresses', async ({ request }) => {
    test.setTimeout(90000);

    // Setup seal key
    const setupResult = await setupCpEnabled(request);
    expect(setupResult.success).toBe(true);

    // Wait for vault
    const vault = await waitForSMKVault(1, { timeout: 60000 });
    expect(vault.success).toBe(true);
    expect(vault.clients.length).toBeGreaterThan(0);

    // Verify all hex addresses are properly formatted
    for (const client of vault.clients) {
      // Object ID: 0x + 64 hex chars (32 bytes)
      expect(client.objectId).toMatch(/^0x[0-9a-fA-F]{64}$/);

      // Package IDs: 0x + 64 hex chars (32 bytes) each
      for (const pkgId of client.packageIds) {
        expect(pkgId).toMatch(/^0x[0-9a-fA-F]{64}$/);
      }
    }

    console.log('✅ All SMK vault addresses are valid hex format');
  });
});

test.describe('SMK vs SMA Vault Structure', () => {
  test('SMK and SMA vaults have different structures', async ({ request }) => {
    test.setTimeout(90000);

    // Setup creates entries in both vaults
    const setupResult = await setupCpEnabled(request);
    expect(setupResult.success).toBe(true);

    // Wait for SMK vault
    const smkVault = await waitForSMKVault(1, { timeout: 60000 });
    expect(smkVault.success).toBe(true);

    // Get SMA vault for comparison
    const smaResult = await runKvcrypt(['get-all', 'sma', '--show-value']);

    // SMK should have "key_<id>" entries (flattened seal keys)
    const smkHasKeyEntries = smkVault.clients.some((c) => c.name.startsWith('key_'));
    expect(smkHasKeyEntries).toBe(true);

    // SMA should have "customer:<id>" entries (customer-based structure)
    const smaData = smaResult.data || {};
    const smaHasCustomerEntries = Object.keys(smaData).some((k) => k.startsWith('customer:'));
    // Note: SMA may be empty if no customers are cpEnabled yet, so we just check the format IF entries exist
    if (smaHasCustomerEntries) {
      const customerEntry = Object.entries(smaData).find(([k]) => k.startsWith('customer:'));
      if (customerEntry) {
        const parsed = JSON.parse(customerEntry[1]);
        // SMA customer entries have nested structure
        expect(parsed.customerId).toBeDefined();
        expect(parsed.services).toBeDefined();
      }
    }

    console.log('✅ SMK and SMA vaults have different structures:');
    console.log(`   - SMK: Flattened seal keys (key_<id> → keyserver config)`);
    console.log(`   - SMA: Customer structure (customer:<id> → services[])`);
  });
});
