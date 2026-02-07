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
  entries: number;
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LM_HEALTH_CHECK_TIMEOUT);

  try {
    const response = await fetch(`${endpoint.host}/api/health`, {
      signal: controller.signal,
    });

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
  } finally {
    clearTimeout(timeout);
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
    // LM is reachable - upsert one row per vault type
    for (const vault of result.data.vaults) {
      const appliedSeq = vault.applied?.seq ?? 0;
      const processingSeq = vault.processing?.seq ?? null;

      await db
        .insert(lmStatus)
        .values({
          lmId: endpoint.id,
          displayName: endpoint.name,
          host: endpoint.host,
          region: endpoint.region ?? null,
          vaultType: vault.type,
          appliedSeq,
          processingSeq,
          entries: vault.entries ?? 0,
          lastSeenAt: now,
          lastError: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [lmStatus.lmId, lmStatus.vaultType],
          set: {
            displayName: endpoint.name,
            host: endpoint.host,
            region: endpoint.region ?? null,
            appliedSeq,
            processingSeq,
            entries: vault.entries ?? 0,
            lastSeenAt: now,
            lastError: null,
            updatedAt: now,
          },
        });
    }
  } else {
    // LM is unreachable - update error status on all existing rows for this LM
    await db
      .update(lmStatus)
      .set({
        lastErrorAt: now,
        lastError: result.error ?? 'Unknown error',
        updatedAt: now,
      })
      .where(eq(lmStatus.lmId, endpoint.id));
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
  minAppliedSeqByVault: Record<string, number>;
}> {
  const endpoints = getLMEndpoints();

  let up = 0;
  let down = 0;
  const minAppliedSeqByVault: Record<string, number> = {};

  // Poll all LMs in parallel
  const results = await Promise.all(
    endpoints.map(async (endpoint) => {
      const result = await pollLM(endpoint);
      await updateLMStatus(endpoint, result);
      return { endpoint, result };
    })
  );

  // Calculate summary — track min applied seq per vault type
  for (const { result } of results) {
    if (result.success && result.data) {
      up++;

      for (const vault of result.data.vaults) {
        if (vault.applied) {
          const current = minAppliedSeqByVault[vault.type];
          if (current === undefined || vault.applied.seq < current) {
            minAppliedSeqByVault[vault.type] = vault.applied.seq;
          }
        }
      }
    } else {
      down++;
    }
  }

  const seqSummary = Object.entries(minAppliedSeqByVault)
    .map(([type, seq]) => `${type}=${seq}`)
    .join(', ') || 'N/A';

  console.log(
    `[LM-POLL] Polled ${endpoints.length} LMs: ${up} up, ${down} down, minAppliedSeq: ${seqSummary}`
  );

  return {
    polled: endpoints.length,
    up,
    down,
    minAppliedSeqByVault,
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
