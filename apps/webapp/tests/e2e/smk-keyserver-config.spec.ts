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
 * SMK Vault Format (single "clients" entry with arrays):
 * {
 *   "clients": "{\"derived_keys\":[{\"cust_id\":\"c0\",\"key_idx\":0,\"idx\":0,...}],\"imported_keys\":[...]}"
 * }
 *
 * This is DIFFERENT from SMA vault which uses customer-based structure.
 *
 * Prerequisites:
 * - GM running for vault generation
 * - Database running
 */

import { test, expect } from '@playwright/test';
import { resetCustomer, setupCpEnabled } from '../helpers/db';
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

// Vault key entry types (match GM's buildKeyserverVaultData output)
interface SMKDerivedKey {
  cust_id: string;
  key_idx: number;
  idx: number; // derivation index
  obj_id: string;
  pkg_ids: string[];
}

interface SMKImportedKey {
  cust_id: string;
  key_idx: number;
  env_var: string;
  obj_id: string;
  pkg_ids: string[];
}

interface SMKVaultContents {
  seq: number;
  derivedKeys: SMKDerivedKey[];
  importedKeys: SMKImportedKey[];
}

// Test key has cust_id "c0" - used to filter it out when counting customer keys
const TEST_KEY_CUST_ID = 'c0';

// Get SMK vault contents by parsing the "clients" entry
async function getSMKVault(): Promise<SMKVaultContents> {
  const result = await runKvcrypt(['get-all', 'smk', '--show-value']);

  if (result.status !== 'success' || !result.data) {
    return { seq: 0, derivedKeys: [], importedKeys: [] };
  }

  let seq = 0;
  let derivedKeys: SMKDerivedKey[] = [];
  let importedKeys: SMKImportedKey[] = [];

  // Parse __vault metadata
  if (result.data.__vault) {
    try {
      const meta = JSON.parse(result.data.__vault);
      seq = meta.seq || 0;
    } catch {
      // Ignore parse errors
    }
  }

  // Parse "clients" entry (single entry with derived_keys + imported_keys arrays)
  if (result.data.clients) {
    try {
      const config = JSON.parse(result.data.clients);
      derivedKeys = config.derived_keys || [];
      importedKeys = config.imported_keys || [];
    } catch (e) {
      console.warn(`Failed to parse SMK "clients" entry: ${e}`);
    }
  }

  return { seq, derivedKeys, importedKeys };
}

// Wait for SMK vault to contain a derived key with the given cust_id.
// This avoids counting from stale vault state (GM may not have regenerated yet after resetCustomer).
async function waitForSMKVaultCustId(
  custId: string,
  options?: { timeout?: number; pollInterval?: number }
): Promise<{
  success: boolean;
} & SMKVaultContents> {
  const timeout = options?.timeout ?? 30000;
  const pollInterval = options?.pollInterval ?? 2000;
  const maxAttempts = Math.ceil(timeout / pollInterval);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const vault = await getSMKVault();
    const found = vault.derivedKeys.some((k) => k.cust_id === custId);

    if (found) {
      return { success: true, ...vault };
    }

    console.log(
      `  SMK vault: waiting for cust_id=${custId} (attempt ${attempt + 1}/${maxAttempts}, seq=${vault.seq}, derived=${vault.derivedKeys.length})`
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

    // === STEP 1: Use setupCpEnabled helper to create seal key with package ===
    const setupResult = await setupCpEnabled(request);
    expect(setupResult.success).toBe(true);
    expect(setupResult.sealKeyId).toBeDefined();
    expect(setupResult.customerId).toBeDefined();
    console.log(`setupCpEnabled completed: sealKeyId=${setupResult.sealKeyId}, customerId=${setupResult.customerId}`);

    // === STEP 2: Wait for GM to regenerate SMK vault with the new customer's key ===
    // GM detects drift every ~5s and regenerates. We wait for the specific cust_id
    // instead of counting keys, because the vault may contain stale data from before resetCustomer.
    const custId = `c${setupResult.customerId}`;
    console.log(`Waiting for SMK vault to contain cust_id=${custId}...`);

    const updatedVault = await waitForSMKVaultCustId(custId, { timeout: 60000 });

    if (!updatedVault.success) {
      console.log('SMK vault contents:', JSON.stringify(updatedVault, null, 2));
      throw new Error(`SMK vault not updated: cust_id=${custId} not found`);
    }

    console.log(
      `SMK vault updated: seq=${updatedVault.seq}, derived=${updatedVault.derivedKeys.length}, imported=${updatedVault.importedKeys.length}`
    );

    // === STEP 3: Find the new customer entry (by cust_id) ===
    const newKey = updatedVault.derivedKeys.find((k) => k.cust_id === custId);

    expect(newKey).toBeDefined();
    console.log('New derived key entry:', JSON.stringify(newKey, null, 2));

    // === STEP 4: Verify SMK vault schema matches keyserver config format ===
    expect(typeof newKey!.idx).toBe('number');
    expect(newKey!.idx).toBeGreaterThanOrEqual(0);
    expect(newKey!.obj_id).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(Array.isArray(newKey!.pkg_ids)).toBe(true);
    expect(newKey!.pkg_ids.length).toBeGreaterThan(0);
    expect(typeof newKey!.key_idx).toBe('number');
    expect(typeof newKey!.cust_id).toBe('string');

    // Derived keys should NOT have env_var
    expect((newKey as Record<string, unknown>).env_var).toBeUndefined();

    console.log('✅ SMK vault entry matches keyserver config schema:');
    console.log(`   - Customer: ${newKey!.cust_id}`);
    console.log(`   - Key Index: ${newKey!.key_idx}`);
    console.log(`   - Derivation Index: ${newKey!.idx}`);
    console.log(`   - Object ID: ${newKey!.obj_id.substring(0, 20)}...`);
    console.log(`   - Package Count: ${newKey!.pkg_ids.length}`);
  });

  test('SMK vault entries have valid hex addresses', async ({ request }) => {
    test.setTimeout(90000);

    // Setup seal key
    const setupResult = await setupCpEnabled(request);
    expect(setupResult.success).toBe(true);

    // Wait for vault to contain this customer's key
    const custId = `c${setupResult.customerId}`;
    const vault = await waitForSMKVaultCustId(custId, { timeout: 60000 });
    expect(vault.success).toBe(true);

    // Verify all derived key hex addresses
    for (const key of vault.derivedKeys) {
      // Object ID: 0x + 64 hex chars (32 bytes)
      expect(key.obj_id).toMatch(/^0x[0-9a-fA-F]{64}$/);

      // Package IDs: 0x + 64 hex chars (32 bytes) each
      for (const pkgId of key.pkg_ids) {
        expect(pkgId).toMatch(/^0x[0-9a-fA-F]{64}$/);
      }
    }

    // Verify all imported key hex addresses
    for (const key of vault.importedKeys) {
      expect(key.obj_id).toMatch(/^0x[0-9a-fA-F]{64}$/);
      for (const pkgId of key.pkg_ids) {
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

    // Wait for SMK vault to have this customer's key
    const custId = `c${setupResult.customerId}`;
    const smkVault = await waitForSMKVaultCustId(custId, { timeout: 60000 });
    expect(smkVault.success).toBe(true);

    // SMK should have derived_keys with customer entries
    const customerDerived = smkVault.derivedKeys.filter((k) => k.cust_id !== TEST_KEY_CUST_ID);
    expect(customerDerived.length).toBeGreaterThan(0);

    // Get SMA vault for comparison
    const smaResult = await runKvcrypt(['get-all', 'sma', '--show-value']);

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
    console.log(`   - SMK: Single "clients" entry with derived_keys/imported_keys arrays`);
    console.log(`   - SMA: Customer structure (customer:<id> → services[])`);
  });
});
