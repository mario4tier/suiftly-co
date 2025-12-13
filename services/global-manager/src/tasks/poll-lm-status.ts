/**
 * Poll LM Status Task
 *
 * Polls all configured Local Managers (LMs) and stores their status in the database.
 * Used to track vault propagation and component sync status across the fleet.
 *
 * The GM uses this data to calculate customer sync status:
 * customer is synced when configChangeVaultSeq <= MIN(vaultSeq from all LMs where inSync=true)
 */

import { db, lmStatus } from '@suiftly/database';
import { getLMEndpoints, LM_HEALTH_CHECK_TIMEOUT, type LMEndpoint } from '../config/lm-config';
import { eq } from 'drizzle-orm';

/**
 * Per-vault status in the vaults array
 */
interface VaultStatus {
  type: string;
  seq: number;
  customerCount: number;
  inSync: boolean; // Vault loaded + HAProxy updated (service operational)
  fullSync: boolean; // All components confirmed including key-servers
  applied: {
    seq: number;
    startedAt: string;
    haproxy: { confirmedAt: string };
    keyServers: Record<string, { confirmedAt: string }>;
  } | null;
  processing: object | null;
  lastError: string | null;
}

/**
 * LM Health Response (new format with vaults array)
 */
interface LMHealthResponse {
  service: string;
  timestamp: string;
  vaults: VaultStatus[];
  inSync: boolean; // All vaults have HAProxy updated (service operational)
  fullSync: boolean; // All vaults have all components confirmed
}

/**
 * Poll a single LM endpoint
 */
async function pollLM(endpoint: LMEndpoint): Promise<{
  success: boolean;
  data?: LMHealthResponse;
  error?: string;
}> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LM_HEALTH_CHECK_TIMEOUT);

    const response = await fetch(`${endpoint.host}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}`,
      };
    }

    const data = await response.json() as LMHealthResponse;
    return { success: true, data };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error };
  }
}

/**
 * Update LM status in database
 */
async function updateLMStatus(
  endpoint: LMEndpoint,
  result: Awaited<ReturnType<typeof pollLM>>
): Promise<void> {
  const now = new Date();

  if (result.success && result.data) {
    // LM is reachable - extract first vault status (currently only 'sma')
    const smaVault = result.data.vaults.find((v) => v.type === 'sma');

    await db
      .insert(lmStatus)
      .values({
        lmId: endpoint.id,
        displayName: endpoint.name,
        host: endpoint.host,
        region: endpoint.region ?? null,
        vaultType: smaVault?.type ?? 'unknown',
        vaultSeq: smaVault?.seq ?? 0,
        inSync: result.data.inSync,
        fullSync: result.data.fullSync,
        customerCount: smaVault?.customerCount ?? 0,
        lastSeenAt: now,
        lastError: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: lmStatus.lmId,
        set: {
          displayName: endpoint.name,
          host: endpoint.host,
          region: endpoint.region ?? null,
          vaultType: smaVault?.type ?? 'unknown',
          vaultSeq: smaVault?.seq ?? 0,
          inSync: result.data.inSync,
          fullSync: result.data.fullSync,
          customerCount: smaVault?.customerCount ?? 0,
          lastSeenAt: now,
          lastError: null,
          updatedAt: now,
        },
      });
  } else {
    // LM is unreachable
    await db
      .insert(lmStatus)
      .values({
        lmId: endpoint.id,
        displayName: endpoint.name,
        host: endpoint.host,
        region: endpoint.region ?? null,
        inSync: false,
        fullSync: false,
        lastErrorAt: now,
        lastError: result.error ?? 'Unknown error',
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: lmStatus.lmId,
        set: {
          displayName: endpoint.name,
          host: endpoint.host,
          region: endpoint.region ?? null,
          inSync: false,
          fullSync: false,
          lastErrorAt: now,
          lastError: result.error ?? 'Unknown error',
          updatedAt: now,
        },
      });
  }
}

/**
 * Poll all LMs and update status
 *
 * Returns summary of polling results
 */
export async function pollLMStatus(): Promise<{
  polled: number;
  up: number;
  down: number;
  inSync: number;
  fullSync: number;
  minVaultSeq: number | null;
}> {
  const endpoints = getLMEndpoints();

  let up = 0;
  let down = 0;
  let inSync = 0;
  let fullSync = 0;
  let minVaultSeq: number | null = null;

  // Poll all LMs in parallel
  const results = await Promise.all(
    endpoints.map(async (endpoint) => {
      const result = await pollLM(endpoint);
      await updateLMStatus(endpoint, result);
      return { endpoint, result };
    })
  );

  // Calculate summary
  for (const { result } of results) {
    if (result.success && result.data) {
      up++;
      if (result.data.inSync) {
        inSync++;
      }
      if (result.data.fullSync) {
        fullSync++;
      }
      // Track minimum vault seq across all reachable LMs (from first vault)
      const smaVault = result.data.vaults.find((v) => v.type === 'sma');
      if (smaVault && (minVaultSeq === null || smaVault.seq < minVaultSeq)) {
        minVaultSeq = smaVault.seq;
      }
    } else {
      down++;
    }
  }

  console.log(
    `[LM-POLL] Polled ${endpoints.length} LMs: ${up} up, ${down} down, ${inSync} in-sync, ${fullSync} full-sync, minSeq=${minVaultSeq ?? 'N/A'}`
  );

  return {
    polled: endpoints.length,
    up,
    down,
    inSync,
    fullSync,
    minVaultSeq,
  };
}

/**
 * Get all LM statuses from database
 */
export async function getLMStatuses(): Promise<Array<typeof lmStatus.$inferSelect>> {
  return db.select().from(lmStatus);
}

/**
 * Get minimum vault seq from all reachable LMs
 *
 * Returns null if no LMs are reachable
 */
export async function getMinLMVaultSeq(): Promise<number | null> {
  const statuses = await db.select().from(lmStatus);

  let minSeq: number | null = null;
  for (const status of statuses) {
    // Only consider LMs that have been seen recently (lastSeenAt not null and no recent error)
    if (status.lastSeenAt && !status.lastError && status.vaultSeq !== null) {
      if (minSeq === null || (status.vaultSeq ?? 0) < minSeq) {
        minSeq = status.vaultSeq ?? 0;
      }
    }
  }

  return minSeq;
}

/**
 * Check if all LMs are in-sync (service operational)
 */
export async function areAllLMsInSync(): Promise<boolean> {
  const statuses = await db.select().from(lmStatus);

  if (statuses.length === 0) {
    return false; // No LMs configured
  }

  // All LMs must be reachable and in-sync
  return statuses.every((s) => s.lastSeenAt && !s.lastError && s.inSync);
}
