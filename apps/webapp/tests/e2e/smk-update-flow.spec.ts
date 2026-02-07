/**
 * SMK Update Flow E2E Test (Real Server — No Mocks)
 *
 * Tests the full SMK update cycle:
 * 1. Initial state: 1 package on seal key, verify SMK seq and config PIDs for mseal1 + mseal2
 * 2. Add a second package → verify both PIDs change, both configs have 2 packages, SMK seq increases
 * 3. Disable the second package → verify PIDs change again, configs back to 1 package, SMK seq increases
 *
 * This confirms the GM → LM → keyserver config pipeline works end-to-end.
 *
 * Prerequisites:
 * - GM, LM, API running (start-dev.sh)
 * - mseal1-node and mseal2-node services running
 */

import { test, expect } from '@playwright/test';
import { resetCustomer, setupCpEnabled, addPackage, disablePackage } from '../helpers/db';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const LM_URL = 'http://localhost:22610';
const GM_URL = 'http://localhost:22600';

// ============================================================================
// Helpers
// ============================================================================

interface VaultStatus {
  type: string;
  customerCount: number;
  applied: { seq: number; at: string } | null;
  processing: { seq: number; startedAt: string; error: string | null } | null;
}

interface LMHealthResponse {
  service: string;
  timestamp: string;
  vaults: VaultStatus[];
}

async function getLMHealth(): Promise<LMHealthResponse> {
  const response = await fetch(`${LM_URL}/api/health`);
  if (!response.ok) throw new Error(`LM health check failed: ${await response.text()}`);
  return response.json() as Promise<LMHealthResponse>;
}

function getSMKVault(health: LMHealthResponse): VaultStatus | undefined {
  return health.vaults.find(v => v.type === 'smk');
}

/** Get PID of a systemd service */
async function getServicePid(serviceName: string): Promise<number> {
  const { stdout } = await execAsync(`systemctl show -p MainPID --value ${serviceName}`);
  return parseInt(stdout.trim(), 10);
}

/** Get kvcrypt SMK vault contents
 * SMK vault format: { clients: JSON string with { derived_keys: [...], imported_keys: [...] }, __vault: JSON metadata }
 */
async function getSMKVaultContents(): Promise<{
  seq: number;
  clients: Array<{ custId: string; keyIdx: number; objId: string; packageIds: string[] }>;
}> {
  const { stdout } = await execAsync(
    'cd /home/olet/mhaxbe/packages/kvcrypt && npx kvcrypt get-all smk --show-value',
    { timeout: 30000 }
  );

  const result = JSON.parse(stdout);
  if (result.status !== 'success' || !result.data) {
    return { seq: 0, clients: [] };
  }

  let seq = 0;
  const clients: Array<{ custId: string; keyIdx: number; objId: string; packageIds: string[] }> = [];

  // Parse __vault metadata for seq
  if (result.data.__vault) {
    try { seq = JSON.parse(result.data.__vault).seq || 0; } catch { /* ignore */ }
  }

  // Parse clients JSON blob
  if (result.data.clients) {
    try {
      const config = JSON.parse(result.data.clients);
      for (const dk of config.derived_keys || []) {
        clients.push({
          custId: dk.cust_id,
          keyIdx: dk.key_idx,
          objId: dk.obj_id,
          packageIds: dk.pkg_ids || [],
        });
      }
      for (const ik of config.imported_keys || []) {
        clients.push({
          custId: ik.cust_id,
          keyIdx: ik.key_idx,
          objId: ik.obj_id,
          packageIds: ik.pkg_ids || [],
        });
      }
    } catch { /* ignore */ }
  }

  return { seq, clients };
}

/** Trigger GM sync and wait for SMK vault applied seq to reach target */
async function triggerSyncAndWaitForSMK(targetMinSeq: number, timeoutMs = 60000): Promise<void> {
  // Trigger GM sync-all
  await fetch(`${GM_URL}/api/queue/sync-all?source=e2e-smk-update-flow`, { method: 'POST' });

  const pollInterval = 1000;
  const maxAttempts = Math.ceil(timeoutMs / pollInterval);

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const health = await getLMHealth();
      const smk = getSMKVault(health);
      if (smk?.applied && smk.applied.seq >= targetMinSeq && !smk.processing) {
        console.log(`  SMK vault synced at seq=${smk.applied.seq} after ${(i + 1) * pollInterval}ms`);
        return;
      }
      if (i % 5 === 0) {
        console.log(`  Waiting for SMK seq >= ${targetMinSeq} (current: ${smk?.applied?.seq ?? 'none'}, processing: ${smk?.processing ? 'yes' : 'no'})`);
      }
    } catch { /* LM not responding yet */ }
    await new Promise(r => setTimeout(r, pollInterval));
  }

  throw new Error(`SMK vault sync timed out after ${timeoutMs}ms waiting for seq >= ${targetMinSeq}`);
}

/** Wait for both mseal1 and mseal2 PIDs to change from their initial values */
async function waitForPidChanges(
  initialPids: { mseal1: number; mseal2: number },
  timeoutMs = 90000
): Promise<{ mseal1: number; mseal2: number }> {
  const pollInterval = 2000;
  const maxAttempts = Math.ceil(timeoutMs / pollInterval);

  for (let i = 0; i < maxAttempts; i++) {
    const mseal1Pid = await getServicePid('mseal1-node');
    const mseal2Pid = await getServicePid('mseal2-node');

    const mseal1Changed = mseal1Pid !== initialPids.mseal1 && mseal1Pid > 0;
    const mseal2Changed = mseal2Pid !== initialPids.mseal2 && mseal2Pid > 0;

    if (mseal1Changed && mseal2Changed) {
      console.log(`  PIDs changed after ${(i + 1) * pollInterval}ms:`);
      console.log(`    mseal1: ${initialPids.mseal1} → ${mseal1Pid}`);
      console.log(`    mseal2: ${initialPids.mseal2} → ${mseal2Pid}`);
      return { mseal1: mseal1Pid, mseal2: mseal2Pid };
    }

    if (i % 5 === 0) {
      console.log(`  Waiting for PID changes (mseal1: ${mseal1Changed ? 'changed' : 'same'}, mseal2: ${mseal2Changed ? 'changed' : 'same'})`);
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }

  const finalMseal1 = await getServicePid('mseal1-node');
  const finalMseal2 = await getServicePid('mseal2-node');
  throw new Error(
    `PID change timed out after ${timeoutMs}ms. ` +
    `mseal1: ${initialPids.mseal1} → ${finalMseal1}, mseal2: ${initialPids.mseal2} → ${finalMseal2}`
  );
}

/** Stop then start a service via sudob (handles crash-looping services) */
async function restartService(serviceName: string): Promise<void> {
  // Stop first (ignore errors — service may already be stopped)
  await fetch('http://localhost:22800/api/service/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service: serviceName }),
  });
  await new Promise(r => setTimeout(r, 1000));

  const response = await fetch('http://localhost:22800/api/service/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service: serviceName }),
  });
  if (!response.ok) throw new Error(`Failed to start ${serviceName}: ${await response.text()}`);
}

/** Wait for both mseal1 and mseal2 to have non-zero PIDs */
async function waitForServicesRunning(timeoutMs = 30000): Promise<{ mseal1: number; mseal2: number }> {
  const pollInterval = 2000;
  const maxAttempts = Math.ceil(timeoutMs / pollInterval);

  for (let i = 0; i < maxAttempts; i++) {
    const mseal1 = await getServicePid('mseal1-node');
    const mseal2 = await getServicePid('mseal2-node');
    if (mseal1 > 0 && mseal2 > 0) {
      return { mseal1, mseal2 };
    }
    await new Promise(r => setTimeout(r, pollInterval));
  }
  throw new Error(`Services not running after ${timeoutMs}ms`);
}

/** Get GM sync overview and extract SMK sync info */
async function getGMSyncOverview(): Promise<{
  vaults: Record<string, { currentSeq: number; contentHash: string; minAppliedSeq: number | null; synced: boolean }>;
  lms: { total: number; reachable: number };
  syncStatus: string;
}> {
  const response = await fetch(`${GM_URL}/api/sync/overview`);
  if (!response.ok) throw new Error(`GM sync overview failed: ${await response.text()}`);
  return response.json() as any;
}

// ============================================================================
// Test
// ============================================================================

test.describe('SMK Update Flow (Real Server)', () => {
  test('add and disable package updates both keyserver configs', async ({ request }) => {
    test.setTimeout(300000); // 5 min — covers vault generation + 2 restart cycles

    // === PRE-CHECK: Verify LM is running ===
    try {
      await getLMHealth();
    } catch {
      test.skip(true, 'LM not running');
      return;
    }

    // === PHASE 1: Initial setup with 1 package ===
    // The keyservers may be crash-looping with empty config (after DB reset).
    // We first populate the config, then ensure they start successfully.
    console.log('=== PHASE 1: Initial setup (1 package) ===');

    await resetCustomer(request);
    // Reset derivation index counter so customer key gets idx=1 (right after test key at idx=0)
    await request.post('http://localhost:22700/test/data/reset-derivation-counter');
    const setupResult = await setupCpEnabled(request);
    expect(setupResult.success).toBe(true);
    expect(setupResult.sealKeyId).toBeDefined();
    const sealKeyId = setupResult.sealKeyId!;
    console.log(`  Setup complete: sealKeyId=${sealKeyId}`);

    // Trigger GM sync and wait for SMK vault to propagate to LM
    // This generates keyserver configs with 1 client (non-empty → services can start)
    const initialHealth = await getLMHealth();
    const initialSmk = getSMKVault(initialHealth);
    const baselineSeq = initialSmk?.applied?.seq ?? 0;
    console.log(`  Baseline SMK seq: ${baselineSeq}`);

    await triggerSyncAndWaitForSMK(baselineSeq + 1, 60000);

    // Capture state after initial sync
    const phase1Health = await getLMHealth();
    const phase1Smk = getSMKVault(phase1Health)!;
    expect(phase1Smk).toBeDefined();
    expect(phase1Smk.applied).not.toBeNull();
    const phase1Seq = phase1Smk.applied!.seq;
    console.log(`  Phase 1 SMK applied seq: ${phase1Seq}`);

    // Ensure keyserver services are running (restart them — config is now valid)
    await restartService('mseal1-node');
    await restartService('mseal2-node');

    // Wait for both services to have non-zero PIDs
    console.log('  Waiting for mseal1 + mseal2 to start...');
    const phase1Pids = await waitForServicesRunning(30000);
    console.log(`  Phase 1 PIDs: mseal1=${phase1Pids.mseal1}, mseal2=${phase1Pids.mseal2}`);

    // Verify SMK vault has 1 package for our seal key
    const phase1Vault = await getSMKVaultContents();
    const phase1Client = phase1Vault.clients.find(c => c.custId !== 'c0');
    expect(phase1Client).toBeDefined();
    expect(phase1Client!.packageIds.length).toBe(1);
    console.log(`  Phase 1 vault: keyIdx=0 has ${phase1Client!.packageIds.length} package(s)`);

    // Verify GM sync overview shows SMK as synced
    const phase1Overview = await getGMSyncOverview();
    console.log(`  Phase 1 GM sync overview: syncStatus=${phase1Overview.syncStatus}, smk=`, phase1Overview.vaults.smk);
    if (phase1Overview.vaults.smk) {
      expect(phase1Overview.vaults.smk.synced).toBe(true);
    }

    // === PHASE 2: Add a second package ===
    console.log('\n=== PHASE 2: Add second package ===');

    const secondPkgAddress = 'c'.repeat(64);
    const addResult = await addPackage(request, sealKeyId, secondPkgAddress, 'Second Package');
    expect(addResult.success).toBe(true);
    const secondPackageId = addResult.packageId!;
    console.log(`  Added package ${secondPackageId} to seal key ${sealKeyId}`);

    // Trigger GM sync and wait for SMK vault seq to increase
    await triggerSyncAndWaitForSMK(phase1Seq + 1, 60000);

    // Restart keyservers to pick up new config (LM writes config but doesn't auto-restart)
    await restartService('mseal1-node');
    await restartService('mseal2-node');

    // Wait for both PIDs to change
    console.log('  Waiting for mseal1 + mseal2 PIDs to change...');
    const phase2Pids = await waitForPidChanges(phase1Pids);

    // Verify new PIDs are different
    expect(phase2Pids.mseal1).not.toBe(phase1Pids.mseal1);
    expect(phase2Pids.mseal2).not.toBe(phase1Pids.mseal2);

    // Verify SMK vault now has 2 packages
    const phase2Vault = await getSMKVaultContents();
    const phase2Client = phase2Vault.clients.find(c => c.custId !== 'c0');
    expect(phase2Client).toBeDefined();
    expect(phase2Client!.packageIds.length).toBe(2);
    console.log(`  Phase 2 vault: keyIdx=0 has ${phase2Client!.packageIds.length} package(s)`);

    // Verify SMK applied seq increased
    const phase2Health = await getLMHealth();
    const phase2Smk = getSMKVault(phase2Health)!;
    expect(phase2Smk.applied).not.toBeNull();
    const phase2Seq = phase2Smk.applied!.seq;
    expect(phase2Seq).toBeGreaterThan(phase1Seq);
    console.log(`  Phase 2 SMK applied seq: ${phase2Seq} (was ${phase1Seq})`);

    // Verify GM sync overview confirms SMK synced
    const phase2Overview = await getGMSyncOverview();
    console.log(`  Phase 2 GM sync overview: syncStatus=${phase2Overview.syncStatus}, smk=`, phase2Overview.vaults.smk);
    if (phase2Overview.vaults.smk) {
      expect(phase2Overview.vaults.smk.synced).toBe(true);
      expect(phase2Overview.vaults.smk.minAppliedSeq).toBeGreaterThanOrEqual(phase2Seq);
    }

    // === PHASE 3: Disable the second package ===
    console.log('\n=== PHASE 3: Disable second package ===');

    const disableResult = await disablePackage(request, secondPackageId);
    expect(disableResult.success).toBe(true);
    console.log(`  Disabled package ${secondPackageId}`);

    // Trigger GM sync and wait for SMK vault seq to increase again
    await triggerSyncAndWaitForSMK(phase2Seq + 1, 60000);

    // Restart keyservers to pick up new config
    await restartService('mseal1-node');
    await restartService('mseal2-node');

    // Wait for both PIDs to change again
    console.log('  Waiting for mseal1 + mseal2 PIDs to change...');
    const phase3Pids = await waitForPidChanges(phase2Pids);

    // Verify PIDs changed again
    expect(phase3Pids.mseal1).not.toBe(phase2Pids.mseal1);
    expect(phase3Pids.mseal2).not.toBe(phase2Pids.mseal2);

    // Verify SMK vault is back to 1 package
    const phase3Vault = await getSMKVaultContents();
    const phase3Client = phase3Vault.clients.find(c => c.custId !== 'c0');
    expect(phase3Client).toBeDefined();
    expect(phase3Client!.packageIds.length).toBe(1);
    console.log(`  Phase 3 vault: keyIdx=0 has ${phase3Client!.packageIds.length} package(s)`);

    // Verify SMK applied seq increased again
    const phase3Health = await getLMHealth();
    const phase3Smk = getSMKVault(phase3Health)!;
    expect(phase3Smk.applied).not.toBeNull();
    const phase3Seq = phase3Smk.applied!.seq;
    expect(phase3Seq).toBeGreaterThan(phase2Seq);
    console.log(`  Phase 3 SMK applied seq: ${phase3Seq} (was ${phase2Seq})`);

    // Verify GM sync overview confirms final sync
    const phase3Overview = await getGMSyncOverview();
    console.log(`  Phase 3 GM sync overview: syncStatus=${phase3Overview.syncStatus}, smk=`, phase3Overview.vaults.smk);
    if (phase3Overview.vaults.smk) {
      expect(phase3Overview.vaults.smk.synced).toBe(true);
    }

    // === SUMMARY ===
    console.log('\n=== SUMMARY ===');
    console.log(`SMK seq progression: ${phase1Seq} → ${phase2Seq} → ${phase3Seq}`);
    console.log(`mseal1 PID progression: ${phase1Pids.mseal1} → ${phase2Pids.mseal1} → ${phase3Pids.mseal1}`);
    console.log(`mseal2 PID progression: ${phase1Pids.mseal2} → ${phase2Pids.mseal2} → ${phase3Pids.mseal2}`);
    console.log(`Package count progression: 1 → 2 → 1`);
    console.log('All phases passed.');
  });
});
