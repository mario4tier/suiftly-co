/**
 * Production-Like Vault Sync E2E Tests
 *
 * These tests use the REAL /opt/syncf directories and sync-files.service
 * to test the full vault propagation flow as it works in production.
 *
 * Uses 'sma' (seal mainnet API) vault type for production-like testing.
 *
 * PREREQUISITES:
 * 1. Run: sudo python3 ~/walrus/scripts/setup-user.py (creates keys and directories)
 * 2. Ensure sync-files.timer is running: systemctl status sync-files.timer
 *
 * Test flow:
 * 1. GM writes vault to /opt/syncf/data_tx/sma/
 * 2. Trigger sync-files.service (or wait for timer)
 * 3. LM reads vault from /opt/syncf/data/sma/
 * 4. Verify diff computation works across synced versions
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import { readdir, stat, readFile, writeFile, mkdir, rm, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  createVaultReader,
  createVaultWriter,
  computeDiff,
} from '@mhaxbe/vault-codec';
import { VaultHandler } from '@mhaxbe/local-manager';
import { createTestKeyProvider, createKeyProvider } from '@mhaxbe/kvcrypt';

// Production directories
const DATA_TX_DIR = '/opt/syncf/data_tx';
const DATA_RX_DIR = '/opt/syncf/data';
const VAULT_TYPE = 'sma'; // Seal mainnet API vault (production-like)

// Key location (created by setup-user.py for test deployments)
const KEY_DIR = '/opt/coord/.sys';

// Timeout for sync operations (ms)
const SYNC_TIMEOUT = 10000;
const SYNC_POLL_INTERVAL = 500;

/**
 * Check if production test prerequisites are met
 */
async function checkPrerequisites(): Promise<{ ready: boolean; issues: string[] }> {
  const issues: string[] = [];

  // Check data_tx/skk directory exists and is writable
  try {
    await access(join(DATA_TX_DIR, VAULT_TYPE), constants.W_OK);
  } catch {
    issues.push(`Cannot write to ${DATA_TX_DIR}/${VAULT_TYPE} - run setup commands from test file header`);
  }

  // Check data/skk directory exists and is readable
  try {
    await access(join(DATA_RX_DIR, VAULT_TYPE), constants.R_OK);
  } catch {
    issues.push(`Cannot read from ${DATA_RX_DIR}/${VAULT_TYPE} - run setup commands from test file header`);
  }

  // Check test key exists
  try {
    await access(join(KEY_DIR, `${VAULT_TYPE}.key`), constants.R_OK);
  } catch {
    issues.push(`Vault key not found at ${KEY_DIR}/${VAULT_TYPE}.key - run: sudo python3 ~/walrus/scripts/setup-user.py`);
  }

  // Check sync-files.timer is active
  try {
    const status = execSync('systemctl is-active sync-files.timer 2>/dev/null', { encoding: 'utf8' }).trim();
    if (status !== 'active') {
      issues.push('sync-files.timer is not active - run: sudo systemctl start sync-files.timer');
    }
  } catch {
    issues.push('sync-files.timer is not active - run: sudo systemctl start sync-files.timer');
  }

  return { ready: issues.length === 0, issues };
}

/**
 * Trigger sync-files.service and wait for completion
 */
async function triggerSyncAndWait(expectedFilename?: string): Promise<void> {
  // Trigger the sync service
  try {
    execSync('sudo systemctl start sync-files.service', { encoding: 'utf8' });
  } catch (error) {
    // Service might already be running or just finished
    console.log('Note: sync-files.service trigger returned non-zero (may be normal)');
  }

  // Wait for sync to complete (poll for file or timeout)
  if (expectedFilename) {
    const targetPath = join(DATA_RX_DIR, VAULT_TYPE, expectedFilename);
    const startTime = Date.now();

    while (Date.now() - startTime < SYNC_TIMEOUT) {
      try {
        await access(targetPath, constants.R_OK);
        // File exists, give a bit more time for sync to fully complete
        await new Promise((r) => setTimeout(r, 500));
        return;
      } catch {
        await new Promise((r) => setTimeout(r, SYNC_POLL_INTERVAL));
      }
    }

    throw new Error(`Sync timeout: ${expectedFilename} not found in ${DATA_RX_DIR}/${VAULT_TYPE} after ${SYNC_TIMEOUT}ms`);
  } else {
    // Just wait a fixed time for sync to process
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/**
 * Clean up test vault files from both directories
 */
async function cleanupTestFiles(): Promise<void> {
  const txDir = join(DATA_TX_DIR, VAULT_TYPE);
  const rxDir = join(DATA_RX_DIR, VAULT_TYPE);

  for (const dir of [txDir, rxDir]) {
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (file.endsWith('.enc')) {
          try {
            await rm(join(dir, file));
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    } catch {
      // Directory might not exist
    }
  }
}

describe('Production Vault Sync E2E', () => {
  let keyProvider: ReturnType<typeof createTestKeyProvider>;
  let testSeqBase: number;

  beforeAll(async () => {
    // Check prerequisites
    const { ready, issues } = await checkPrerequisites();

    if (!ready) {
      console.log('\n⚠️  Production E2E test prerequisites not met:');
      issues.forEach((issue) => console.log(`   - ${issue}`));
      console.log('\nSkipping production sync tests.\n');
      return;
    }

    // Load key from file
    const keyData = await readFile(join(KEY_DIR, `${VAULT_TYPE}.key`));
    keyProvider = createTestKeyProvider({ [VAULT_TYPE]: keyData } as any);

    // Use a unique seq base for this test run to avoid conflicts
    testSeqBase = Date.now() % 100000000; // Use timestamp mod to get unique starting seq
  });

  beforeEach(async () => {
    const { ready } = await checkPrerequisites();
    if (!ready) {
      return;
    }

    // Clean up any existing test files
    await cleanupTestFiles();
  });

  afterAll(async () => {
    // Clean up test files
    await cleanupTestFiles();
  });

  it.skipIf(async () => !(await checkPrerequisites()).ready)(
    'writes vault to data_tx and syncs to data',
    async () => {
      const seq = testSeqBase + 1;

      // 1. GM: Write vault to data_tx
      const writer = createVaultWriter({
        storageDir: DATA_TX_DIR,
        keyProvider,
      });

      const vaultData = {
        'customer:12345': JSON.stringify({
          customerId: 12345,
          apiKeyFps: [100, 200],
          tier: 'starter',
          status: 'active',
          isUserEnabled: true,
        }),
      };

      const writeResult = await writer.write(VAULT_TYPE, vaultData, {
        seq,
        pg: 1,
        source: 'e2e-test',
      });

      console.log(`Wrote vault: ${writeResult.filename}`);

      // Verify file exists in data_tx
      const txFiles = await readdir(join(DATA_TX_DIR, VAULT_TYPE));
      expect(txFiles).toContain(writeResult.filename);

      // 2. Trigger sync and wait for file to appear in data/
      await triggerSyncAndWait(writeResult.filename);

      // 3. LM: Verify file synced to data/
      const rxFiles = await readdir(join(DATA_RX_DIR, VAULT_TYPE));
      expect(rxFiles).toContain(writeResult.filename);

      // 4. Read and verify vault content
      const reader = createVaultReader({
        storageDir: DATA_RX_DIR,
        keyProvider,
      });

      const vault = await reader.loadLatest(VAULT_TYPE);
      expect(vault).not.toBeNull();
      expect(vault!.seq).toBe(seq);
      expect(vault!.data['customer:12345']).toBeDefined();

      const customerConfig = JSON.parse(vault!.data['customer:12345']);
      expect(customerConfig.tier).toBe('starter');
    }
  );

  it.skipIf(async () => !(await checkPrerequisites()).ready)(
    'VaultHandler detects synced updates',
    async () => {
      const seq1 = testSeqBase + 10;
      const seq2 = testSeqBase + 11;

      // 1. Write first vault version
      const writer = createVaultWriter({
        storageDir: DATA_TX_DIR,
        keyProvider,
      });

      const vaultData1 = {
        'customer:1': JSON.stringify({ customerId: 1, tier: 'starter' }),
      };

      const result1 = await writer.write(VAULT_TYPE, vaultData1, {
        seq: seq1,
        pg: 1,
        source: 'e2e-test',
      });

      // Sync and initialize handler
      await triggerSyncAndWait(result1.filename);

      const handler = new VaultHandler(VAULT_TYPE, {
        storageDir: DATA_RX_DIR,
        keyProvider,
      });
      await handler.initialize();

      expect(handler.getActiveSeq()).toBe(seq1);
      expect(handler.listCustomerIds()).toContain(1);

      // 2. Write second vault version with changes
      const vaultData2 = {
        'customer:1': JSON.stringify({ customerId: 1, tier: 'pro' }), // Modified
        'customer:2': JSON.stringify({ customerId: 2, tier: 'enterprise' }), // Added
      };

      const result2 = await writer.write(VAULT_TYPE, vaultData2, {
        seq: seq2,
        pg: 1,
        source: 'e2e-test',
      });

      // Sync and check for update
      await triggerSyncAndWait(result2.filename);

      const updated = await handler.checkForUpdate();

      expect(updated).toBe(true);
      expect(handler.getActiveSeq()).toBe(seq2);
      expect(handler.listCustomerIds()).toHaveLength(2);

      // Verify previous vault preserved
      const prev = handler.getPrevious();
      expect(prev?.seq).toBe(seq1);

      // Verify customer configs
      const config1 = handler.getCustomerConfig(1);
      expect(config1?.tier).toBe('pro');

      const config2 = handler.getCustomerConfig(2);
      expect(config2?.tier).toBe('enterprise');
    }
  );

  it.skipIf(async () => !(await checkPrerequisites()).ready)(
    'computes diff correctly across synced versions',
    async () => {
      const seq1 = testSeqBase + 20;
      const seq2 = testSeqBase + 21;

      const writer = createVaultWriter({
        storageDir: DATA_TX_DIR,
        keyProvider,
      });

      // Write v1
      await writer.write(
        VAULT_TYPE,
        {
          'customer:100': JSON.stringify({ tier: 'starter' }),
          'customer:200': JSON.stringify({ tier: 'pro' }),
        },
        { seq: seq1, pg: 1, source: 'e2e-test' }
      );

      // Write v2 with changes
      const result2 = await writer.write(
        VAULT_TYPE,
        {
          'customer:100': JSON.stringify({ tier: 'enterprise' }), // Modified
          'customer:300': JSON.stringify({ tier: 'starter' }), // Added
          // customer:200 removed
        },
        { seq: seq2, pg: 1, source: 'e2e-test' }
      );

      // Sync
      await triggerSyncAndWait(result2.filename);

      // Read both versions
      const reader = createVaultReader({
        storageDir: DATA_RX_DIR,
        keyProvider,
      });

      const v1 = await reader.loadBySeq(VAULT_TYPE, seq1);
      const v2 = await reader.loadBySeq(VAULT_TYPE, seq2);

      expect(v1).not.toBeNull();
      expect(v2).not.toBeNull();

      // Compute and verify diff
      const diff = computeDiff(v1!, v2!);

      expect(diff.fromSeq).toBe(seq1);
      expect(diff.toSeq).toBe(seq2);
      expect(diff.added.has('customer:300')).toBe(true);
      expect(diff.removed.has('customer:200')).toBe(true);
      expect(diff.modified.has('customer:100')).toBe(true);
      expect(diff.hasChanges).toBe(true);
    }
  );

  it.skipIf(async () => !(await checkPrerequisites()).ready)(
    'handles rapid sequential writes',
    async () => {
      const baseSeq = testSeqBase + 30;
      const numVersions = 5;

      const writer = createVaultWriter({
        storageDir: DATA_TX_DIR,
        keyProvider,
      });

      // Write multiple versions rapidly
      const filenames: string[] = [];
      for (let i = 0; i < numVersions; i++) {
        const result = await writer.write(
          VAULT_TYPE,
          { [`customer:${i}`]: JSON.stringify({ version: i }) },
          { seq: baseSeq + i, pg: 1, source: 'e2e-test' }
        );
        filenames.push(result.filename);
      }

      // Sync all files
      await triggerSyncAndWait(filenames[filenames.length - 1]);

      // Verify all versions synced
      const reader = createVaultReader({
        storageDir: DATA_RX_DIR,
        keyProvider,
      });

      const versions = await reader.listVersions(VAULT_TYPE);
      const seqs = versions.map((v) => v.seq);

      for (let i = 0; i < numVersions; i++) {
        expect(seqs).toContain(baseSeq + i);
      }

      // Latest should be the highest seq
      const latest = await reader.loadLatest(VAULT_TYPE);
      expect(latest?.seq).toBe(baseSeq + numVersions - 1);
    }
  );
});
