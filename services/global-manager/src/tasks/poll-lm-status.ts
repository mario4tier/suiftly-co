/**
 * Poll LM Status Task
 *
 * Polls all configured Local Managers (LMs) and stores their status in the database.
 * Used to track vault propagation across the fleet.
 *
 * Sequence-based sync tracking:
 * - Extracts appliedSeq (vaults[].applied.seq) and processingSeq (vaults[].processing.seq)
 * - API calculates MIN(appliedSeq) across all LMs for each vault type
 * - Service is synced when configChangeVaultSeq <= MIN(appliedSeq for all relevant vaults)
 */

import { db, lmStatus } from '@suiftly/database';
import { getLMEndpoints, LM_HEALTH_CHECK_TIMEOUT, type LMEndpoint } from '../config/lm-config';
import { eq } from 'drizzle-orm';

/**
 * Applied state from LM health response
 */
interface AppliedState {
  seq: number;
  at: string; // ISO timestamp
}

/**
 * Processing state from LM health response
 */
interface ProcessingState {
  seq: number;
  startedAt: string;
  error: string | null;
}

/**
 * Per-vault status in the vaults array (actual LM response format)
 */
interface VaultStatus {
  type: string;
  customerCount: number;
  applied: AppliedState | null;
  processing: ProcessingState | null;
}

/**
 * LM Health Response (actual format from LM)
 */
interface LMHealthResponse {
  service: string;
  timestamp: string;
  vaults: VaultStatus[];
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

    // Extract applied and processing sequences
    const appliedSeq = smaVault?.applied?.seq ?? 0;
    const processingSeq = smaVault?.processing?.seq ?? null;

    await db
      .insert(lmStatus)
      .values({
        lmId: endpoint.id,
        displayName: endpoint.name,
        host: endpoint.host,
        region: endpoint.region ?? null,
        vaultType: smaVault?.type ?? 'unknown',
        appliedSeq,
        processingSeq,
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
          appliedSeq,
          processingSeq,
          customerCount: smaVault?.customerCount ?? 0,
          lastSeenAt: now,
          lastError: null,
          updatedAt: now,
        },
      });
  } else {
    // LM is unreachable - only update error status, preserve existing seq values
    await db
      .insert(lmStatus)
      .values({
        lmId: endpoint.id,
        displayName: endpoint.name,
        host: endpoint.host,
        region: endpoint.region ?? null,
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
  minAppliedSeq: number | null;
}> {
  const endpoints = getLMEndpoints();

  let up = 0;
  let down = 0;
  let minAppliedSeq: number | null = null;

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

      // Track minimum applied seq across all reachable LMs
      const smaVault = result.data.vaults.find((v) => v.type === 'sma');
      const appliedSeq = smaVault?.applied?.seq ?? 0;
      if (smaVault && smaVault.applied && (minAppliedSeq === null || appliedSeq < minAppliedSeq)) {
        minAppliedSeq = appliedSeq;
      }
    } else {
      down++;
    }
  }

  console.log(
    `[LM-POLL] Polled ${endpoints.length} LMs: ${up} up, ${down} down, minAppliedSeq=${minAppliedSeq ?? 'N/A'}`
  );

  return {
    polled: endpoints.length,
    up,
    down,
    minAppliedSeq,
  };
}

/**
 * Get all LM statuses from database
 */
export async function getLMStatuses(): Promise<Array<typeof lmStatus.$inferSelect>> {
  return db.select().from(lmStatus);
}

/**
 * Get minimum applied seq from all reachable LMs for a specific vault type
 *
 * Returns null if no LMs are reachable for that vault type
 */
export async function getMinAppliedSeq(vaultType: string): Promise<number | null> {
  const statuses = await db.select().from(lmStatus);

  // LM must have been seen within last 30 seconds to be considered reachable
  const freshnessThreshold = new Date(Date.now() - 30000);

  let minSeq: number | null = null;
  for (const status of statuses) {
    // Only consider LMs that:
    // - Match the vault type
    // - Have been seen recently (within 30s, no error)
    // - Have applied at least one vault (appliedSeq > 0)
    const isRecent = status.lastSeenAt && status.lastSeenAt > freshnessThreshold;
    if (
      status.vaultType === vaultType &&
      isRecent &&
      !status.lastError &&
      status.appliedSeq !== null &&
      status.appliedSeq > 0
    ) {
      if (minSeq === null || status.appliedSeq < minSeq) {
        minSeq = status.appliedSeq;
      }
    }
  }

  return minSeq;
}
