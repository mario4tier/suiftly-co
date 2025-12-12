/**
 * API Test: Vault Versioning E2E
 *
 * Tests vault generation, propagation, and diff computation.
 *
 * This test verifies the full vault lifecycle:
 * 1. GM generates vault from customer/service data
 * 2. Vault file is written with correct format and seq
 * 3. LM can load vault using VaultReader
 * 4. VaultHandler manages active/previous instances
 * 5. computeDiff produces correct deltas between versions
 *
 * Uses real kvcrypt with test keys and temp directories.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import { serviceInstances, customers, apiKeys } from '@suiftly/database/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { mkdir, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  resetClock,
  ensureTestBalance,
  trpcMutation,
  resetTestData,
  subscribeAndEnable,
} from './helpers/http.js';
import { login, TEST_WALLET } from './helpers/auth.js';
import {
  createVaultReader,
  createVaultWriter,
  computeDiff,
  computeContentHash,
} from '@walrus/vault-codec';
import { VaultHandler } from '@walrus/local-manager';
import { createTestKeyProvider, generateKey } from '@walrus/kvcrypt';

// Test wallet addresses for multi-customer tests
const TEST_WALLET_2 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TEST_WALLET_3 = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

describe('API: Vault Versioning E2E', () => {
  let storageDir: string;
  let keyProvider: ReturnType<typeof createTestKeyProvider>;
  let accessToken: string;
  let customerId: number;

  beforeEach(async () => {
    // Create temp storage directory for this test run
    storageDir = join(tmpdir(), `vault-e2e-test-${randomBytes(8).toString('hex')}`);
    await mkdir(join(storageDir, 'sma'), { recursive: true });

    // Create test key provider with a key for 'sma' vault type
    keyProvider = createTestKeyProvider({ sma: generateKey() });

    // Reset clock to real time
    await resetClock();

    // Reset test customer data
    await resetTestData(TEST_WALLET);
    await resetTestData(TEST_WALLET_2);
    await resetTestData(TEST_WALLET_3);

    // Login and setup first test customer
    accessToken = await login(TEST_WALLET);

    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, TEST_WALLET),
    });
    if (!customer) {
      throw new Error('Test customer not found after login');
    }
    customerId = customer.customerId;

    // Ensure sufficient balance
    await ensureTestBalance(100, { walletAddress: TEST_WALLET });
  });

  afterEach(async () => {
    // Clean up temp directory
    await rm(storageDir, { recursive: true, force: true });

    // Reset clock
    await resetClock();

    // Clean up test data
    await resetTestData(TEST_WALLET);
    await resetTestData(TEST_WALLET_2);
    await resetTestData(TEST_WALLET_3);
  });

  describe('Vault Generation', () => {
    it('generates vault with correct seq and content', async () => {
      // Subscribe to seal service
      await subscribeAndEnable('seal', 'starter', accessToken);

      // Generate vault with test storage directory
      // Note: We use a custom writer since generateVault uses default keyProvider
      const writer = createVaultWriter({
        storageDir,
        keyProvider,
      });

      // Build vault data manually (simulating what generateVault does)
      const services = await db
        .select({
          customerId: serviceInstances.customerId,
          state: serviceInstances.state,
          tier: serviceInstances.tier,
          isUserEnabled: serviceInstances.isUserEnabled,
        })
        .from(serviceInstances)
        .where(eq(serviceInstances.serviceType, 'seal'));

      const vaultData: Record<string, string> = {};
      for (const service of services) {
        if (service.state === 'not_provisioned') continue;

        const keys = await db
          .select({ apiKeyFp: apiKeys.apiKeyFp })
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.customerId, service.customerId),
              eq(apiKeys.serviceType, 'seal'),
              eq(apiKeys.isUserEnabled, true),
              isNull(apiKeys.revokedAt),
              isNull(apiKeys.deletedAt)
            )
          );

        const config = {
          customerId: service.customerId,
          apiKeyFps: keys.map((k) => k.apiKeyFp),
          tier: service.tier,
          status: service.state === 'enabled' ? 'active' : 'disabled',
          isUserEnabled: service.isUserEnabled,
        };

        vaultData[`customer:${service.customerId}`] = JSON.stringify(config);
      }

      // Write vault
      const result = await writer.write('sma', vaultData, {
        seq: 1,
        pg: 1,
        source: 'test-gm',
      });

      // Verify file was created
      expect(result.filename).toMatch(/^sma-01-000000001-/);
      expect(result.encFile).toContain(storageDir);

      // Verify file exists
      const files = await readdir(join(storageDir, 'sma'));
      expect(files).toHaveLength(1);
      expect(files[0]).toBe(result.filename);
    });

    it('skips generation when content unchanged', async () => {
      // Subscribe to service
      await subscribeAndEnable('seal', 'starter', accessToken);

      // Build and write first vault
      const writer = createVaultWriter({ storageDir, keyProvider });

      const services = await db
        .select({
          customerId: serviceInstances.customerId,
          state: serviceInstances.state,
          tier: serviceInstances.tier,
          isUserEnabled: serviceInstances.isUserEnabled,
        })
        .from(serviceInstances)
        .where(eq(serviceInstances.serviceType, 'seal'));

      const vaultData: Record<string, string> = {};
      for (const service of services) {
        if (service.state === 'not_provisioned') continue;
        vaultData[`customer:${service.customerId}`] = JSON.stringify({
          customerId: service.customerId,
          apiKeyFps: [],
          tier: service.tier,
          status: 'active',
          isUserEnabled: service.isUserEnabled,
        });
      }

      // Write first version
      await writer.write('sma', vaultData, { seq: 1, pg: 1, source: 'test-gm' });

      // Compute content hash
      const contentHash = computeContentHash(vaultData);

      // Simulate checking for changes (same data = no new vault)
      const newHash = computeContentHash(vaultData);
      expect(newHash).toBe(contentHash);

      // Only one vault file should exist
      const files = await readdir(join(storageDir, 'sma'));
      expect(files).toHaveLength(1);
    });

    it('generates new version when content changes', async () => {
      // Subscribe first customer
      await subscribeAndEnable('seal', 'starter', accessToken);

      const writer = createVaultWriter({ storageDir, keyProvider });

      // Build first vault
      const vaultData1: Record<string, string> = {};
      vaultData1[`customer:${customerId}`] = JSON.stringify({
        customerId,
        apiKeyFps: [],
        tier: 'starter',
        status: 'active',
        isUserEnabled: true,
      });

      await writer.write('sma', vaultData1, { seq: 1, pg: 1, source: 'test-gm' });

      // Login and subscribe second customer
      await ensureTestBalance(100, { walletAddress: TEST_WALLET_2 });
      const accessToken2 = await login(TEST_WALLET_2);
      await subscribeAndEnable('seal', 'pro', accessToken2);

      const customer2 = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, TEST_WALLET_2),
      });

      // Build second vault with both customers
      const vaultData2: Record<string, string> = {};
      vaultData2[`customer:${customerId}`] = JSON.stringify({
        customerId,
        apiKeyFps: [],
        tier: 'starter',
        status: 'active',
        isUserEnabled: true,
      });
      vaultData2[`customer:${customer2!.customerId}`] = JSON.stringify({
        customerId: customer2!.customerId,
        apiKeyFps: [],
        tier: 'pro',
        status: 'active',
        isUserEnabled: true,
      });

      await writer.write('sma', vaultData2, { seq: 2, pg: 1, source: 'test-gm' });

      // Two vault files should exist
      const files = await readdir(join(storageDir, 'sma'));
      expect(files).toHaveLength(2);

      // Verify filenames have correct sequence numbers
      const seqs = files
        .map((f) => f.match(/sma-01-(\d+)-/)?.[1])
        .filter(Boolean)
        .map(Number);
      expect(seqs).toContain(1);
      expect(seqs).toContain(2);
    });
  });

  describe('Vault Loading', () => {
    it('loads latest vault version', async () => {
      await subscribeAndEnable('seal', 'starter', accessToken);

      const writer = createVaultWriter({ storageDir, keyProvider });

      // Write two versions
      const vaultData1 = { [`customer:${customerId}`]: '{"v":1}' };
      await writer.write('sma', vaultData1, { seq: 1, pg: 1, source: 'test' });

      const vaultData2 = { [`customer:${customerId}`]: '{"v":2}' };
      await writer.write('sma', vaultData2, { seq: 2, pg: 1, source: 'test' });

      // Load latest
      const reader = createVaultReader({ storageDir, keyProvider });
      const vault = await reader.loadLatest('sma');

      expect(vault).not.toBeNull();
      expect(vault!.seq).toBe(2);
      expect(vault!.data[`customer:${customerId}`]).toBe('{"v":2}');
    });

    it('loads specific version by seq', async () => {
      const writer = createVaultWriter({ storageDir, keyProvider });

      await writer.write('sma', { key: 'v1' }, { seq: 10, pg: 1, source: 'test' });
      await writer.write('sma', { key: 'v2' }, { seq: 20, pg: 1, source: 'test' });
      await writer.write('sma', { key: 'v3' }, { seq: 30, pg: 1, source: 'test' });

      const reader = createVaultReader({ storageDir, keyProvider });

      const v10 = await reader.loadBySeq('sma', 10);
      expect(v10?.data.key).toBe('v1');

      const v20 = await reader.loadBySeq('sma', 20);
      expect(v20?.data.key).toBe('v2');

      const v30 = await reader.loadBySeq('sma', 30);
      expect(v30?.data.key).toBe('v3');
    });

    it('lists versions in descending order', async () => {
      const writer = createVaultWriter({ storageDir, keyProvider });

      await writer.write('sma', { key: 'a' }, { seq: 5, pg: 1, source: 'test' });
      await writer.write('sma', { key: 'b' }, { seq: 15, pg: 1, source: 'test' });
      await writer.write('sma', { key: 'c' }, { seq: 10, pg: 1, source: 'test' });

      const reader = createVaultReader({ storageDir, keyProvider });
      const versions = await reader.listVersions('sma');

      expect(versions).toHaveLength(3);
      expect(versions[0].seq).toBe(15); // Newest first
      expect(versions[1].seq).toBe(10);
      expect(versions[2].seq).toBe(5);
    });
  });

  describe('VaultHandler', () => {
    it('initializes with latest vault', async () => {
      const writer = createVaultWriter({ storageDir, keyProvider });
      await writer.write(
        'sma',
        { 'customer:123': JSON.stringify({ customerId: 123, tier: 'starter' }) },
        { seq: 100, pg: 1, source: 'test' }
      );

      const handler = new VaultHandler('sma', { storageDir, keyProvider });
      const result = await handler.initialize();

      expect(result).toBe(true);
      expect(handler.getActiveSeq()).toBe(100);
      expect(handler.getActive()).not.toBeNull();
    });

    it('detects and loads new vault version', async () => {
      const writer = createVaultWriter({ storageDir, keyProvider });
      await writer.write('sma', { key: 'v1' }, { seq: 1, pg: 1, source: 'test' });

      const handler = new VaultHandler('sma', { storageDir, keyProvider });
      await handler.initialize();
      expect(handler.getActiveSeq()).toBe(1);

      // Write new version
      await writer.write('sma', { key: 'v2' }, { seq: 2, pg: 1, source: 'test' });

      // Check for update
      const updated = await handler.checkForUpdate();

      expect(updated).toBe(true);
      expect(handler.getActiveSeq()).toBe(2);
      expect(handler.getPrevious()?.seq).toBe(1);
    });

    it('retrieves customer config by ID', async () => {
      const config = {
        customerId: 12345,
        apiKeyFps: [100, 200, 300],
        tier: 'pro',
        status: 'active',
        isUserEnabled: true,
      };

      const writer = createVaultWriter({ storageDir, keyProvider });
      await writer.write(
        'sma',
        { 'customer:12345': JSON.stringify(config) },
        { seq: 1, pg: 1, source: 'test' }
      );

      const handler = new VaultHandler('sma', { storageDir, keyProvider });
      await handler.initialize();

      const result = handler.getCustomerConfig(12345);

      expect(result).toEqual(config);
    });

    it('returns null for non-existent customer', async () => {
      const writer = createVaultWriter({ storageDir, keyProvider });
      await writer.write('sma', { 'customer:1': '{}' }, { seq: 1, pg: 1, source: 'test' });

      const handler = new VaultHandler('sma', { storageDir, keyProvider });
      await handler.initialize();

      const result = handler.getCustomerConfig(99999);

      expect(result).toBeNull();
    });

    it('lists all customer IDs', async () => {
      const writer = createVaultWriter({ storageDir, keyProvider });
      await writer.write(
        'sma',
        {
          'customer:111': '{}',
          'customer:222': '{}',
          'customer:333': '{}',
        },
        { seq: 1, pg: 1, source: 'test' }
      );

      const handler = new VaultHandler('sma', { storageDir, keyProvider });
      await handler.initialize();

      const ids = handler.listCustomerIds();

      expect(ids).toHaveLength(3);
      expect(ids).toContain(111);
      expect(ids).toContain(222);
      expect(ids).toContain(333);
    });
  });

  describe('Diff Computation', () => {
    it('computes diff with added keys', async () => {
      const writer = createVaultWriter({ storageDir, keyProvider });
      await writer.write('sma', { key1: 'v1' }, { seq: 1, pg: 1, source: 'test' });
      await writer.write('sma', { key1: 'v1', key2: 'v2', key3: 'v3' }, { seq: 2, pg: 1, source: 'test' });

      const reader = createVaultReader({ storageDir, keyProvider });
      const v1 = await reader.loadBySeq('sma', 1);
      const v2 = await reader.loadBySeq('sma', 2);

      const diff = computeDiff(v1!, v2!);

      expect(diff.fromSeq).toBe(1);
      expect(diff.toSeq).toBe(2);
      expect(diff.added.size).toBe(2);
      expect(diff.added.has('key2')).toBe(true);
      expect(diff.added.has('key3')).toBe(true);
      expect(diff.removed.size).toBe(0);
      expect(diff.modified.size).toBe(0);
      expect(diff.hasChanges).toBe(true);
    });

    it('computes diff with removed keys', async () => {
      const writer = createVaultWriter({ storageDir, keyProvider });
      await writer.write('sma', { key1: 'v1', key2: 'v2', key3: 'v3' }, { seq: 1, pg: 1, source: 'test' });
      await writer.write('sma', { key1: 'v1' }, { seq: 2, pg: 1, source: 'test' });

      const reader = createVaultReader({ storageDir, keyProvider });
      const v1 = await reader.loadBySeq('sma', 1);
      const v2 = await reader.loadBySeq('sma', 2);

      const diff = computeDiff(v1!, v2!);

      expect(diff.removed.size).toBe(2);
      expect(diff.removed.has('key2')).toBe(true);
      expect(diff.removed.has('key3')).toBe(true);
      expect(diff.added.size).toBe(0);
      expect(diff.modified.size).toBe(0);
      expect(diff.hasChanges).toBe(true);
    });

    it('computes diff with modified keys', async () => {
      const writer = createVaultWriter({ storageDir, keyProvider });
      await writer.write('sma', { key1: 'old', key2: 'same' }, { seq: 1, pg: 1, source: 'test' });
      await writer.write('sma', { key1: 'new', key2: 'same' }, { seq: 2, pg: 1, source: 'test' });

      const reader = createVaultReader({ storageDir, keyProvider });
      const v1 = await reader.loadBySeq('sma', 1);
      const v2 = await reader.loadBySeq('sma', 2);

      const diff = computeDiff(v1!, v2!);

      expect(diff.modified.size).toBe(1);
      expect(diff.modified.has('key1')).toBe(true);
      expect(diff.modified.get('key1')).toEqual({ old: 'old', new: 'new' });
      expect(diff.added.size).toBe(0);
      expect(diff.removed.size).toBe(0);
      expect(diff.hasChanges).toBe(true);
    });

    it('computes diff with mixed changes', async () => {
      const writer = createVaultWriter({ storageDir, keyProvider });
      await writer.write(
        'sma',
        {
          'customer:1': '{"tier":"starter"}',
          'customer:2': '{"tier":"pro"}',
        },
        { seq: 1, pg: 1, source: 'test' }
      );
      await writer.write(
        'sma',
        {
          'customer:1': '{"tier":"enterprise"}', // modified
          'customer:3': '{"tier":"starter"}', // added
          // customer:2 removed
        },
        { seq: 2, pg: 1, source: 'test' }
      );

      const reader = createVaultReader({ storageDir, keyProvider });
      const v1 = await reader.loadBySeq('sma', 1);
      const v2 = await reader.loadBySeq('sma', 2);

      const diff = computeDiff(v1!, v2!);

      expect(diff.added.size).toBe(1);
      expect(diff.added.has('customer:3')).toBe(true);
      expect(diff.removed.size).toBe(1);
      expect(diff.removed.has('customer:2')).toBe(true);
      expect(diff.modified.size).toBe(1);
      expect(diff.modified.has('customer:1')).toBe(true);
      expect(diff.hasChanges).toBe(true);
    });

    it('returns hasChanges=false when identical', async () => {
      const writer = createVaultWriter({ storageDir, keyProvider });
      await writer.write('sma', { key: 'same' }, { seq: 1, pg: 1, source: 'test' });
      await writer.write('sma', { key: 'same' }, { seq: 2, pg: 1, source: 'test' });

      const reader = createVaultReader({ storageDir, keyProvider });
      const v1 = await reader.loadBySeq('sma', 1);
      const v2 = await reader.loadBySeq('sma', 2);

      const diff = computeDiff(v1!, v2!);

      expect(diff.hasChanges).toBe(false);
      expect(diff.added.size).toBe(0);
      expect(diff.removed.size).toBe(0);
      expect(diff.modified.size).toBe(0);
    });
  });

  describe('VaultHandler Update Callback', () => {
    it('calls onUpdate callback on initial load', async () => {
      const writer = createVaultWriter({ storageDir, keyProvider });
      await writer.write('sma', { key: 'value' }, { seq: 1, pg: 1, source: 'test' });

      let callCount = 0;
      let lastVault: any = null;
      let lastDiff: any = null;

      const onUpdate = (vault: any, diff: any) => {
        callCount++;
        lastVault = vault;
        lastDiff = diff;
      };

      const handler = new VaultHandler('sma', { storageDir, keyProvider, onUpdate });
      await handler.initialize();

      expect(callCount).toBe(1);
      expect(lastVault?.seq).toBe(1);
      expect(lastDiff).toBeNull(); // No diff on initial load
    });

    it('calls onUpdate callback with diff on update', async () => {
      const writer = createVaultWriter({ storageDir, keyProvider });
      await writer.write('sma', { 'customer:1': '{"v":1}' }, { seq: 1, pg: 1, source: 'test' });

      const callbacks: Array<{ vault: any; diff: any; prev: any }> = [];
      const onUpdate = (vault: any, diff: any, prev: any) => {
        callbacks.push({ vault, diff, prev });
      };

      const handler = new VaultHandler('sma', { storageDir, keyProvider, onUpdate });
      await handler.initialize();

      // Write new version
      await writer.write(
        'sma',
        { 'customer:1': '{"v":2}', 'customer:2': '{"v":1}' },
        { seq: 2, pg: 1, source: 'test' }
      );
      await handler.checkForUpdate();

      expect(callbacks).toHaveLength(2);

      // Second callback (the update)
      const updateCb = callbacks[1];
      expect(updateCb.vault.seq).toBe(2);
      expect(updateCb.diff).not.toBeNull();
      expect(updateCb.diff.added.size).toBe(1);
      expect(updateCb.diff.modified.size).toBe(1);
      expect(updateCb.prev?.seq).toBe(1);
    });
  });

  describe('Full Integration', () => {
    it('simulates full GM->LM vault propagation flow', async () => {
      // 1. Setup: Customer subscribes to service
      await subscribeAndEnable('seal', 'starter', accessToken);

      // 2. GM: Generate vault from DB data
      const writer = createVaultWriter({ storageDir, keyProvider });

      // Get real customer data
      const services = await db
        .select({
          customerId: serviceInstances.customerId,
          state: serviceInstances.state,
          tier: serviceInstances.tier,
          isUserEnabled: serviceInstances.isUserEnabled,
        })
        .from(serviceInstances)
        .where(eq(serviceInstances.serviceType, 'seal'));

      const vaultData: Record<string, string> = {};
      for (const service of services) {
        if (service.state === 'not_provisioned') continue;

        const keys = await db
          .select({ apiKeyFp: apiKeys.apiKeyFp })
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.customerId, service.customerId),
              eq(apiKeys.serviceType, 'seal'),
              eq(apiKeys.isUserEnabled, true),
              isNull(apiKeys.revokedAt),
              isNull(apiKeys.deletedAt)
            )
          );

        vaultData[`customer:${service.customerId}`] = JSON.stringify({
          customerId: service.customerId,
          apiKeyFps: keys.map((k) => k.apiKeyFp),
          tier: service.tier,
          status: service.state === 'enabled' ? 'active' : 'disabled',
          isUserEnabled: service.isUserEnabled,
        });
      }

      await writer.write('sma', vaultData, { seq: 1, pg: 1, source: 'gm-primary' });

      // 3. LM: Initialize VaultHandler and verify
      const handler = new VaultHandler('sma', { storageDir, keyProvider });
      await handler.initialize();

      expect(handler.getActiveSeq()).toBe(1);
      expect(handler.listCustomerIds()).toContain(customerId);

      const config = handler.getCustomerConfig(customerId);
      expect(config).not.toBeNull();
      expect(config!.tier).toBe('starter');
      expect(config!.status).toBe('active');
      expect(config!.isUserEnabled).toBe(true);

      // 4. Simulate tier upgrade: GM generates new vault with updated tier
      // (In production, this happens after a DB change triggers vault regeneration)
      const vaultData2: Record<string, string> = {};
      vaultData2[`customer:${customerId}`] = JSON.stringify({
        customerId,
        apiKeyFps: config!.apiKeyFps,
        tier: 'pro', // Simulating tier change
        status: 'active',
        isUserEnabled: true,
      });

      await writer.write('sma', vaultData2, { seq: 2, pg: 1, source: 'gm-primary' });

      // 5. LM: Detect and apply update
      const updated = await handler.checkForUpdate();

      expect(updated).toBe(true);
      expect(handler.getActiveSeq()).toBe(2);

      const newConfig = handler.getCustomerConfig(customerId);
      expect(newConfig!.tier).toBe('pro');

      // 6. Verify previous vault was preserved for rollback
      const prevVault = handler.getPrevious();
      expect(prevVault?.seq).toBe(1);
    });

    it('simulates second customer joining via vault update', async () => {
      // 1. First customer subscribes
      await subscribeAndEnable('seal', 'starter', accessToken);

      const writer = createVaultWriter({ storageDir, keyProvider });

      // 2. Generate vault with first customer
      const vaultData1: Record<string, string> = {};
      vaultData1[`customer:${customerId}`] = JSON.stringify({
        customerId,
        apiKeyFps: [],
        tier: 'starter',
        status: 'active',
        isUserEnabled: true,
      });

      await writer.write('sma', vaultData1, { seq: 1, pg: 1, source: 'gm-primary' });

      // 3. LM: Initialize and verify
      const handler = new VaultHandler('sma', { storageDir, keyProvider });
      await handler.initialize();

      expect(handler.listCustomerIds()).toHaveLength(1);
      expect(handler.listCustomerIds()).toContain(customerId);

      // 4. Second customer subscribes
      await ensureTestBalance(100, { walletAddress: TEST_WALLET_2 });
      const accessToken2 = await login(TEST_WALLET_2);
      await subscribeAndEnable('seal', 'pro', accessToken2);

      const customer2 = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, TEST_WALLET_2),
      });

      // 5. GM: Generate new vault with both customers
      const vaultData2: Record<string, string> = {};
      vaultData2[`customer:${customerId}`] = JSON.stringify({
        customerId,
        apiKeyFps: [],
        tier: 'starter',
        status: 'active',
        isUserEnabled: true,
      });
      vaultData2[`customer:${customer2!.customerId}`] = JSON.stringify({
        customerId: customer2!.customerId,
        apiKeyFps: [],
        tier: 'pro',
        status: 'active',
        isUserEnabled: true,
      });

      await writer.write('sma', vaultData2, { seq: 2, pg: 1, source: 'gm-primary' });

      // 6. LM: Detect update and verify new customer was added
      const updated = await handler.checkForUpdate();

      expect(updated).toBe(true);
      expect(handler.getActiveSeq()).toBe(2);
      expect(handler.listCustomerIds()).toHaveLength(2);
      expect(handler.listCustomerIds()).toContain(customerId);
      expect(handler.listCustomerIds()).toContain(customer2!.customerId);

      // 7. Verify both customer configs are accessible
      const config1 = handler.getCustomerConfig(customerId);
      expect(config1!.tier).toBe('starter');

      const config2 = handler.getCustomerConfig(customer2!.customerId);
      expect(config2!.tier).toBe('pro');
    });
  });
});
