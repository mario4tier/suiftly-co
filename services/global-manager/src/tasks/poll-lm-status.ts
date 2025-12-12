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
 * LM Health Response (matches LM server response format)
 */
interface LMHealthResponse {
  status: 'up' | 'degraded' | 'down';
  service: string;
  timestamp: string;
  vault: {
    type: string;
    seq: number;
    customerCount: number;
  };
  components: {
    vault: boolean;
    haproxy: boolean;
    keyServer: boolean;
  };
  inSync: boolean;
  debug?: {
    vaultLoadedAt: string | null;
    haproxyUpdatedAt: string | null;
    keyServerCheckedAt: string | null;
    lastError: string | null;
  };
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
    // LM is reachable - update status
    await db
      .insert(lmStatus)
      .values({
        lmId: endpoint.id,
        displayName: endpoint.name,
        host: endpoint.host,
        region: endpoint.region ?? null,
        vaultType: result.data.vault.type,
        vaultSeq: result.data.vault.seq,
        inSync: result.data.inSync,
        componentVault: result.data.components.vault,
        componentHaproxy: result.data.components.haproxy,
        componentKeyServer: result.data.components.keyServer,
        status: result.data.status,
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
          vaultType: result.data.vault.type,
          vaultSeq: result.data.vault.seq,
          inSync: result.data.inSync,
          componentVault: result.data.components.vault,
          componentHaproxy: result.data.components.haproxy,
          componentKeyServer: result.data.components.keyServer,
          status: result.data.status,
          lastSeenAt: now,
          lastError: null,
          updatedAt: now,
        },
      });
  } else {
    // LM is unreachable - mark as down
    await db
      .insert(lmStatus)
      .values({
        lmId: endpoint.id,
        displayName: endpoint.name,
        host: endpoint.host,
        region: endpoint.region ?? null,
        status: 'down',
        inSync: false,
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
          status: 'down',
          inSync: false,
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
  minVaultSeq: number | null;
}> {
  const endpoints = getLMEndpoints();

  let up = 0;
  let down = 0;
  let inSync = 0;
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
      // Track minimum vault seq across all reachable LMs
      if (minVaultSeq === null || result.data.vault.seq < minVaultSeq) {
        minVaultSeq = result.data.vault.seq;
      }
    } else {
      down++;
    }
  }

  console.log(
    `[LM-POLL] Polled ${endpoints.length} LMs: ${up} up, ${down} down, ${inSync} in-sync, minSeq=${minVaultSeq ?? 'N/A'}`
  );

  return {
    polled: endpoints.length,
    up,
    down,
    inSync,
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
 * Get minimum vault seq from all reachable LMs that are in-sync
 *
 * Returns null if no LMs are in-sync
 */
export async function getMinLMVaultSeq(): Promise<number | null> {
  const statuses = await db.select().from(lmStatus);

  let minSeq: number | null = null;
  for (const status of statuses) {
    // Only consider LMs that are up (not down) - we include degraded
    if (status.status !== 'down' && status.vaultSeq !== null) {
      if (minSeq === null || (status.vaultSeq ?? 0) < minSeq) {
        minSeq = status.vaultSeq ?? 0;
      }
    }
  }

  return minSeq;
}

/**
 * Check if all LMs are in-sync
 */
export async function areAllLMsInSync(): Promise<boolean> {
  const statuses = await db.select().from(lmStatus);

  if (statuses.length === 0) {
    return false; // No LMs configured
  }

  // All LMs must be up and in-sync
  return statuses.every((s) => s.status !== 'down' && s.inSync);
}
