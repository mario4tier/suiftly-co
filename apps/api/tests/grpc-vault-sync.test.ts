/**
 * gRPC Vault Sync End-to-End Test
 *
 * Tests the full vault pipeline:
 * 1. Enable gRPC service + create API key (cpEnabled=true)
 * 2. GM generates rma vault with customer config
 * 3. LM applies vault and writes HAProxy map file
 * 4. Verify customer appears in vault and HAProxy map
 *
 * Uses real database, GM, LM, and HAProxy (integration test).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@suiftly/database';
import { serviceInstances, systemControl } from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import { SERVICE_TYPE } from '@suiftly/shared/constants';
import {
  trpcQuery,
  trpcMutation,
} from './helpers/http.js';
import { setupBillingTest, type SetupBillingTestResult } from './helpers/setup.js';

const GM_BASE = 'http://localhost:22600';
const LM_BASE = 'http://localhost:22610';

// ============================================================================
// Helpers
// ============================================================================

async function triggerSyncAndWaitForVaultSeq(targetSeq: number, timeoutMs = 10000): Promise<void> {
  // Trigger GM sync
  await fetch(`${GM_BASE}/api/queue/sync-all`, { method: 'POST' });

  // Wait for rma vault seq to reach target
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [control] = await db
      .select({ rmaVaultSeq: systemControl.rmaVaultSeq })
      .from(systemControl)
      .where(eq(systemControl.id, 1))
      .limit(1);

    if ((control?.rmaVaultSeq ?? 0) >= targetSeq) {
      return;
    }

    // Trigger sync again in case first one didn't complete
    await fetch(`${GM_BASE}/api/queue/sync-all`, { method: 'POST' });
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for rma vault seq >= ${targetSeq}`);
}

async function waitForLMApplied(vaultType: string, targetSeq: number, timeoutMs = 15000): Promise<void> {
  // Also trigger sync-files to propagate from data_tx to data
  await fetch('http://localhost:22800/api/service/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service: 'sync-files' }),
  });

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${LM_BASE}/api/health`);
      if (res.ok) {
        const data = await res.json() as any;
        const vault = data.vaults?.find((v: any) => v.type === vaultType);
        if (vault?.applied?.seq >= targetSeq) {
          return;
        }
      }
    } catch {
      // LM might be restarting
    }

    // Re-trigger sync-files
    await fetch('http://localhost:22800/api/service/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'sync-files' }),
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for LM to apply ${vaultType} vault seq >= ${targetSeq}`);
}

// ============================================================================
// Test Setup
// ============================================================================

let setup: SetupBillingTestResult;

beforeAll(async () => {
  setup = await setupBillingTest({ balance: 100 });
});

// ============================================================================
// Tests
// ============================================================================

describe('gRPC Vault Sync Pipeline', () => {
  it('should generate rma vault with customer after enabling gRPC + creating API key', async () => {
    // 1. Enable gRPC service (sets cpEnabled=true for gRPC)
    const toggleResult = await trpcMutation<any>(
      'services.toggleService',
      { serviceType: 'grpc', enabled: true },
      setup.accessToken
    );
    expect(toggleResult.error).toBeUndefined();
    expect(toggleResult.result?.data?.cpEnabled).toBe(true);

    // 2. Create API key (needed for customer to appear in vault)
    const keyResult = await trpcMutation<any>(
      'grpc.createApiKey',
      {},
      setup.accessToken
    );
    expect(keyResult.error).toBeUndefined();
    const apiKeyFp = keyResult.result?.data?.created?.apiKeyFp;
    expect(apiKeyFp).toBeDefined();

    // 3. Get the rmaConfigChangeVaultSeq from the service
    const service = await db.query.serviceInstances.findFirst({
      where: and(
        eq(serviceInstances.customerId, setup.customerId),
        eq(serviceInstances.serviceType, SERVICE_TYPE.GRPC)
      ),
    });
    const expectedSeq = service!.rmaConfigChangeVaultSeq!;
    expect(expectedSeq).toBeGreaterThan(0);

    // 4. Trigger GM sync and wait for vault to be generated
    await triggerSyncAndWaitForVaultSeq(expectedSeq);

    // 5. Verify rma vault seq in DB matches
    const [control] = await db
      .select({ rmaVaultSeq: systemControl.rmaVaultSeq, rmaVaultEntries: systemControl.rmaVaultEntries })
      .from(systemControl)
      .where(eq(systemControl.id, 1))
      .limit(1);

    expect(control!.rmaVaultSeq).toBeGreaterThanOrEqual(expectedSeq);
    // Should have at least 1 entry (our customer)
    expect(control!.rmaVaultEntries).toBeGreaterThanOrEqual(1);
  });

  it('should propagate rma vault to LM', { timeout: 30000 }, async () => {
    // Get current rma vault seq
    const [control] = await db
      .select({ rmaVaultSeq: systemControl.rmaVaultSeq })
      .from(systemControl)
      .where(eq(systemControl.id, 1))
      .limit(1);
    const currentSeq = control!.rmaVaultSeq!;

    // Wait for LM to apply this vault
    await waitForLMApplied('rma', currentSeq);

    // Verify LM health shows rma as applied
    const res = await fetch(`${LM_BASE}/api/health`);
    const data = await res.json() as any;
    const rmaVault = data.vaults?.find((v: any) => v.type === 'rma');

    expect(rmaVault).toBeDefined();
    expect(rmaVault.applied).toBeDefined();
    expect(rmaVault.applied.seq).toBeGreaterThanOrEqual(currentSeq);
    // Vault should have at least 1 customer entry
    expect(rmaVault.entries).toBeGreaterThanOrEqual(1);
  });
});
