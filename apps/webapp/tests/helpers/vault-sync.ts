/**
 * Vault Sync Utilities
 *
 * Provides reliable vault synchronization verification for E2E tests.
 *
 * The vault sync pipeline is: API mutation → GM (generates vault) → LM (applies vault) → HAProxy
 *
 * Key concepts:
 * - GM `vaultSeq`: Current vault version (updated when vault is generated)
 * - GM `maxConfigChangeSeq`: High-water mark of config change requests
 * - GM `hasPending`: True when maxConfigChangeSeq > vaultSeq
 * - LM `applied.seq`: The vault seq that LM has successfully applied
 *
 * Pattern for testing mutations:
 * 1. BEFORE mutation: `const baseline = await waitForStabilization()` - capture baseline
 * 2. Do mutation (API call, UI click, etc.)
 * 3. AFTER mutation: `await waitForVaultUpdate(baseline.vaultSeq)` - wait for propagation
 * 4. Verify the change took effect
 *
 * Seq mismatch detection:
 * If GM's vaultSeq < LM's applied seq, old vault files on disk have higher seq than
 * what GM is generating (typically caused by DB reset without vault file cleanup).
 * When detected, we call sudob's reset-all to clean-slate the environment.
 */

import { PORT } from '@suiftly/shared/constants';

const LM_URL = `http://localhost:${PORT.LM}`;
const GM_URL = `http://localhost:${PORT.GM}`;
const SUDOB_URL = `http://localhost:${PORT.SUDOB}`;

export interface LMHealthResponse {
  vaults: Array<{
    type: string;
    customerCount: number;
    applied: { seq: number; at: string } | null;
    processing: object | null;
  }>;
}

export interface GMHealthResponse {
  vaults: {
    sma: {
      vaultSeq: number;
      maxConfigChangeSeq: number;
      hasPending: boolean;
    };
    smk: {
      vaultSeq: number;
    };
  };
}

/**
 * Fetch LM health status with timeout.
 */
export async function getLMHealth(): Promise<LMHealthResponse | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${LM_URL}/api/health`, { signal: controller.signal });
    return response.ok ? ((await response.json()) as LMHealthResponse) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch GM health status with timeout.
 */
export async function getGMHealth(): Promise<GMHealthResponse | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${GM_URL}/api/health`, { signal: controller.signal });
    return response.ok ? ((await response.json()) as GMHealthResponse) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Detect and recover from seq mismatch between GM and LM.
 *
 * This happens when:
 * - DB was reset (vaultSeq → 0) but old vault files remain on disk
 * - LM's loadLatest() picks the highest-seq file from disk (old, stale)
 * - LM's applied seq is higher than GM's vaultSeq
 * - LM ignores new vault files because they have lower seq
 *
 * Recovery: Call sudob's reset-all to clean-slate everything
 * (vault files, DB, restart LM + HAProxy).
 *
 * @returns true if recovery was performed, false if no mismatch detected
 */
async function detectAndRecoverSeqMismatch(
  gmVaultSeq: number,
  lmAppliedSeq: number | undefined
): Promise<boolean> {
  if (lmAppliedSeq === undefined) return false;

  // GM should always be >= LM (GM generates, LM applies).
  // If GM < LM, we have stale vault files on disk.
  if (gmVaultSeq >= lmAppliedSeq) return false;

  console.error(
    `\n⚠️  SEQ MISMATCH DETECTED: GM vaultSeq=${gmVaultSeq} < LM applied seq=${lmAppliedSeq}\n` +
      `   Old vault files on disk have higher seq than what GM is generating.\n` +
      `   Calling sudob reset-all to clean-slate the environment...\n`
  );

  try {
    const controller = new AbortController();
    // 60s timeout: reset-all stops 3 services, clears files, truncates DB, starts 3 services
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const response = await fetch(`${SUDOB_URL}/api/test/reset-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`sudob reset-all failed: HTTP ${response.status} - ${text}`);
    }

    const result = (await response.json()) as { ok: boolean; message: string };
    console.log(`✅ Reset-all complete: ${result.message}`);

    // Wait for services to come back up after restart
    console.log('Waiting for services to come back up...');
    const maxWait = 30000;
    const pollInterval = 1000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      const [gm, lm] = await Promise.all([getGMHealth(), getLMHealth()]);
      if (gm && lm) {
        console.log('✅ Services are back up');

        // Trigger a sync so GM generates fresh vault for LM
        try {
          await fetch(`${GM_URL}/api/queue/sync-all?source=post-reset`, { method: 'POST' });
          // Wait a bit for the vault to be generated and applied
          await new Promise((resolve) => setTimeout(resolve, 3000));
        } catch {
          // Not critical - GM will eventually generate on its own
        }

        return true;
      }
    }

    throw new Error('Services did not come back up after reset-all');
  } catch (error) {
    console.error(`❌ Recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error(
      `Seq mismatch detected (GM=${gmVaultSeq} < LM=${lmAppliedSeq}) and recovery failed. ` +
        `Manual fix: curl -X POST http://localhost:22800/api/test/reset-all`
    );
  }
}

/**
 * Wait for vault sync stabilization.
 *
 * Stabilization means:
 * 1. Both GM and LM are healthy
 * 2. LM is not currently processing
 * 3. LM has applied the current GM vault seq (GM == LM)
 *
 * If a seq mismatch is detected (GM < LM), automatically triggers
 * a full environment reset via sudob and retries.
 *
 * @param timeoutMs - Maximum time to wait (default: 60 seconds)
 * @returns The current stable vault seq
 */
export async function waitForStabilization(timeoutMs: number = 60000): Promise<{ vaultSeq: number }> {
  const pollInterval = 500;
  const maxAttempts = Math.ceil(timeoutMs / pollInterval);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const [gmHealth, lmHealth] = await Promise.all([getGMHealth(), getLMHealth()]);

    if (!gmHealth || !lmHealth) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      continue;
    }

    const gmVault = gmHealth.vaults.sma;
    const lmVault = lmHealth.vaults.find((v) => v.type === 'sma');
    const lmAppliedSeq = lmVault?.applied?.seq;

    // Detect seq mismatch and auto-recover
    if (lmAppliedSeq !== undefined && gmVault.vaultSeq < lmAppliedSeq) {
      const recovered = await detectAndRecoverSeqMismatch(gmVault.vaultSeq, lmAppliedSeq);
      if (recovered) {
        // Restart stabilization with fresh state
        return waitForStabilization(timeoutMs);
      }
    }

    // Check stabilization conditions:
    // 1. LM is not currently processing
    // 2. LM has applied the current GM vault seq
    const lmIdle = !lmVault?.processing;
    const lmSynced = lmAppliedSeq !== undefined && lmAppliedSeq >= gmVault.vaultSeq;

    if (lmIdle && lmSynced) {
      return { vaultSeq: gmVault.vaultSeq };
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  // Log diagnostic info on timeout
  const [gmHealth, lmHealth] = await Promise.all([getGMHealth(), getLMHealth()]);
  const gmSeq = gmHealth?.vaults.sma.vaultSeq ?? '?';
  const lmSeq = lmHealth?.vaults.find((v) => v.type === 'sma')?.applied?.seq ?? '?';
  throw new Error(`Vault stabilization timed out (GM seq=${gmSeq}, LM seq=${lmSeq})`);
}

/**
 * Wait for vault seq to exceed baseline and stabilize.
 *
 * This is called AFTER a mutation to wait for the changes to propagate:
 * 1. Wait for GM vault seq > baseline (proves mutation was processed)
 * 2. Wait for LM to apply the new vault seq
 *
 * @param baselineSeq - The vault seq before the mutation
 * @param options - Configuration options
 * @param options.timeoutMs - Maximum time to wait (default: 60 seconds)
 * @param options.waitForHAProxy - Whether to add delay for HAProxy reload (default: true)
 * @returns The new stable vault seq
 */
export async function waitForVaultUpdate(
  baselineSeq: number,
  options: { timeoutMs?: number; waitForHAProxy?: boolean } = {}
): Promise<{ vaultSeq: number }> {
  const { timeoutMs = 60000, waitForHAProxy = true } = options;
  const pollInterval = 500;
  const maxAttempts = Math.ceil(timeoutMs / pollInterval);

  console.log(`Waiting for vault seq > ${baselineSeq}...`);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const [gmHealth, lmHealth] = await Promise.all([getGMHealth(), getLMHealth()]);

    if (!gmHealth || !lmHealth) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      continue;
    }

    const gmVault = gmHealth.vaults.sma;
    const lmVault = lmHealth.vaults.find((v) => v.type === 'sma');

    // Check conditions:
    // 1. GM vault seq must be greater than baseline (mutation was processed)
    // 2. LM has applied the current GM vault seq
    // 3. LM is not currently processing
    const seqIncreased = gmVault.vaultSeq > baselineSeq;
    const lmApplied = lmVault?.applied?.seq === gmVault.vaultSeq;
    const lmIdle = !lmVault?.processing;

    if (seqIncreased && lmApplied && lmIdle) {
      console.log(`Vault updated: seq ${baselineSeq} -> ${gmVault.vaultSeq}`);

      if (waitForHAProxy) {
        // Give HAProxy time to reload the map after LM applies
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      return { vaultSeq: gmVault.vaultSeq };
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Vault update timed out waiting for seq > ${baselineSeq}`);
}

/**
 * Trigger GM sync and wait for vault to update from baseline.
 *
 * Usage pattern:
 * 1. BEFORE mutation: `const baseline = await waitForStabilization()` - capture baseline
 * 2. Do mutation (API call, UI click, etc.)
 * 3. AFTER mutation: `await triggerSyncAndWait(baseline.vaultSeq)` - wait for propagation
 *
 * @param baselineSeq - The vault seq before the mutation
 * @param options - Configuration options
 */
export async function triggerSyncAndWait(
  baselineSeq: number,
  options: { source?: string; timeoutMs?: number; waitForHAProxy?: boolean } = {}
): Promise<{ vaultSeq: number }> {
  const { source = 'e2e-test', timeoutMs = 60000, waitForHAProxy = true } = options;

  // Trigger GM sync to process any pending changes
  const controller = new AbortController();
  const triggerTimeout = setTimeout(() => controller.abort(), 30000);

  try {
    await fetch(`${GM_URL}/api/queue/sync-all?source=${source}`, {
      method: 'POST',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(triggerTimeout);
  }

  // Wait for vault seq to increment (proves mutation was processed)
  return waitForVaultUpdate(baselineSeq, { timeoutMs, waitForHAProxy });
}
