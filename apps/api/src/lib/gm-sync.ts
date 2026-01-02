/**
 * GM Sync Helper
 *
 * Triggers vault regeneration via the Global Manager.
 * Used when API mutations change data that affects vault content.
 *
 * ============================================================================
 * COMPLETE PATTERN FOR CONFIG CHANGES THAT NEED VAULT SYNC
 * ============================================================================
 *
 * Each service type has ONE vault containing ALL configuration. The Local
 * Manager (LM) determines which components (HAProxy, Key-Server) need updates
 * and only reports "applied" when ALL affected components are updated.
 *
 * BACKEND (API mutation):
 * 1. Inside transaction: call markConfigChanged() to get expectedVaultSeq
 * 2. Inside transaction: update service with smaConfigChangeVaultSeq = expectedVaultSeq
 * 3. Outside transaction: call triggerVaultSync() (fire-and-forget)
 *
 * FRONTEND (React component):
 * 4. In mutation's onSuccess: call utils.services.getServicesStatus.invalidate()
 *    This triggers immediate status refetch so "Updating..." appears instantly.
 *
 * Without step 4, the UI waits up to 15 seconds (next polling cycle) to show
 * the "Updating..." indicator, which appears delayed to users.
 *
 * ============================================================================
 *
 * Reusable for all service types that need vault sync:
 * - Seal mainnet (seal + mainnet) → sma vault
 * - Seal testnet (seal + testnet) → sta vault
 * - Future services (grpc, graphql) → their respective vaults
 */

import { db, systemControl, serviceInstances, type LockedTransaction } from '@suiftly/database';
import { SERVICE_TYPE, type ServiceType } from '@suiftly/shared/constants';
import { eq, sql } from 'drizzle-orm';

// GM endpoint (internal network only)
const GM_HOST = process.env.GM_HOST || 'http://localhost:22600';

/**
 * Vault type codes (3-letter: {service}{network}{purpose})
 * - First letter: service (s=seal, r=grpc, g=graphql)
 * - Second letter: network (m=mainnet, t=testnet)
 * - Third letter: purpose (a=api, m=master, s=seed, o=open)
 */
export type VaultType = 'sma' | 'sta' | 'rma' | 'rta' | 'gma' | 'gta';

/**
 * Network type for vault determination
 */
export type NetworkType = 'mainnet' | 'testnet';

/**
 * Get the vault type for a given service and network
 *
 * This is the single source of truth for service-to-vault mapping.
 * All config changes that need HAProxy sync should use this.
 *
 * @param serviceType - Service type (seal, grpc, graphql)
 * @param network - Network (mainnet, testnet), defaults to mainnet
 * @returns Vault type code
 */
export function getVaultType(serviceType: ServiceType, network: NetworkType = 'mainnet'): VaultType {
  const networkChar = network === 'mainnet' ? 'm' : 't';

  switch (serviceType) {
    case SERVICE_TYPE.SEAL:
      return `s${networkChar}a` as VaultType;  // sma or sta
    case SERVICE_TYPE.GRPC:
      return `r${networkChar}a` as VaultType;  // rma or rta (future)
    case SERVICE_TYPE.GRAPHQL:
      return `g${networkChar}a` as VaultType;  // gma or gta (future)
    default:
      // Default to seal mainnet for backward compatibility
      return 'sma';
  }
}

/**
 * Get the column names for a vault type in system_control and service_instances
 *
 * This abstracts the column naming convention so callers don't need to know it.
 */
function getVaultColumns(vaultType: VaultType): {
  nextSeqColumn: 'smaNextVaultSeq' | 'staNextVaultSeq';
  maxChangeSeqColumn: 'smaMaxConfigChangeSeq' | 'staMaxConfigChangeSeq';
  serviceChangeSeqColumn: 'smaConfigChangeVaultSeq';  // Only sma exists in schema currently
} {
  // Currently only sma and sta are implemented in the schema
  // When new vault types are added, update the schema first, then add them here
  switch (vaultType) {
    case 'sta':
      return {
        nextSeqColumn: 'staNextVaultSeq',
        maxChangeSeqColumn: 'staMaxConfigChangeSeq',
        serviceChangeSeqColumn: 'smaConfigChangeVaultSeq',  // TODO: Add staConfigChangeVaultSeq to schema
      };
    case 'sma':
    default:
      return {
        nextSeqColumn: 'smaNextVaultSeq',
        maxChangeSeqColumn: 'smaMaxConfigChangeSeq',
        serviceChangeSeqColumn: 'smaConfigChangeVaultSeq',
      };
  }
}

/**
 * Mark a config change as pending for vault regeneration
 *
 * Call this INSIDE a transaction when making any config change that
 * needs to propagate to HAProxy (IP allowlist, burst config, service toggle, etc.)
 *
 * This does three things:
 * 1. Reads the next vault sequence number
 * 2. Updates the global max configChangeSeq (for GM's O(1) pending check)
 * 3. Returns the expectedVaultSeq to set on the service
 *
 * After the transaction, call triggerVaultSync() to notify GM.
 *
 * @param tx - Drizzle transaction
 * @param serviceType - Type of service (determines vault type)
 * @param network - Network (mainnet/testnet), defaults to mainnet
 * @returns expectedVaultSeq to set on the service's configChangeVaultSeq column
 *
 * @example
 * // For Seal mainnet service config change:
 * await withCustomerLock(customerId, async (tx) => {
 *   const expectedVaultSeq = await markConfigChanged(tx, SERVICE_TYPE.SEAL, 'mainnet');
 *   await tx.update(serviceInstances)
 *     .set({ config: newConfig, smaConfigChangeVaultSeq: expectedVaultSeq })
 *     .where(eq(serviceInstances.instanceId, instanceId));
 * });
 * void triggerVaultSync(); // Outside transaction, fire-and-forget
 */
export async function markConfigChanged(
  tx: LockedTransaction,
  serviceType: ServiceType,
  network: NetworkType = 'mainnet'
): Promise<number> {
  const vaultType = getVaultType(serviceType, network);
  const columns = getVaultColumns(vaultType);

  // Read nextVaultSeq - the seq to use for pending changes
  // GM bumps this to currentSeq+2 when processing, preventing collisions
  const [control] = await tx
    .select({
      nextSeq: systemControl[columns.nextSeqColumn],
    })
    .from(systemControl)
    .where(eq(systemControl.id, 1))
    .limit(1);

  const expectedVaultSeq = control?.nextSeq ?? 1;

  // Atomically update global max configChangeSeq (for GM's O(1) pending check)
  await tx
    .update(systemControl)
    .set({
      [columns.maxChangeSeqColumn]: sql`GREATEST(${systemControl[columns.maxChangeSeqColumn]}, ${expectedVaultSeq})`,
    })
    .where(eq(systemControl.id, 1));

  return expectedVaultSeq;
}

/**
 * Helper to update a service's config with proper sync tracking
 *
 * This is a convenience wrapper that:
 * 1. Gets current service config
 * 2. Calls markConfigChanged() to get expected vault seq
 * 3. Merges config updates with existing config
 * 4. Updates service with new config and configChangeVaultSeq
 *
 * Call triggerVaultSync() after the transaction completes.
 *
 * @param tx - Drizzle transaction
 * @param instanceId - Service instance ID
 * @param serviceType - Type of service (for vault type determination)
 * @param configUpdates - Partial config object to merge with existing config
 * @param network - Network (mainnet/testnet), defaults to mainnet
 * @returns Updated service instance
 *
 * @example
 * // Update IP allowlist for Seal mainnet service:
 * const updated = await withCustomerLock(customerId, async (tx) => {
 *   return updateServiceConfigWithSync(tx, instanceId, SERVICE_TYPE.SEAL, {
 *     ipAllowlistEnabled: true,
 *     ipAllowlist: ['1.2.3.4', '5.6.7.8'],
 *   });
 * });
 * void triggerVaultSync(); // Outside transaction, fire-and-forget
 */
export async function updateServiceConfigWithSync<T extends Record<string, unknown>>(
  tx: LockedTransaction,
  instanceId: number,
  serviceType: ServiceType,
  configUpdates: Partial<T>,
  network: NetworkType = 'mainnet'
): Promise<typeof serviceInstances.$inferSelect> {
  const vaultType = getVaultType(serviceType, network);
  const columns = getVaultColumns(vaultType);

  // Get current service config
  const [service] = await tx
    .select()
    .from(serviceInstances)
    .where(eq(serviceInstances.instanceId, instanceId))
    .limit(1);

  if (!service) {
    throw new Error(`Service instance ${instanceId} not found`);
  }

  // Get expected vault seq for sync tracking
  const expectedVaultSeq = await markConfigChanged(tx, serviceType, network);

  // Merge config updates with existing config
  const currentConfig = (service.config as Record<string, unknown>) || {};
  const newConfig = { ...currentConfig, ...configUpdates };

  // Update service with new config and sync tracking
  const [updated] = await tx
    .update(serviceInstances)
    .set({
      config: newConfig,
      [columns.serviceChangeSeqColumn]: expectedVaultSeq,
    })
    .where(eq(serviceInstances.instanceId, instanceId))
    .returning();

  return updated;
}

/**
 * Trigger vault regeneration via GM
 *
 * Calls the GM's sync-all endpoint to regenerate vaults.
 * Uses async mode by default (returns immediately without waiting).
 *
 * @param waitForCompletion - If true, waits for sync to complete (for tests)
 * @returns Result object with success status
 */
export async function triggerVaultSync(waitForCompletion = false): Promise<{
  success: boolean;
  queued?: boolean;
  completed?: boolean;
  taskId?: string;
  error?: string;
}> {
  try {
    const asyncParam = waitForCompletion ? '' : '?async=true';
    const response = await fetch(`${GM_HOST}/api/queue/sync-all${asyncParam}`, {
      method: 'POST',
    });

    if (!response.ok) {
      const text = await response.text();
      console.warn('[GM-SYNC] Failed to trigger vault sync:', response.status, text);
      return { success: false, error: `HTTP ${response.status}: ${text}` };
    }

    const result = await response.json() as {
      success: boolean;
      queued?: boolean;
      completed?: boolean;
      taskId?: string;
      reason?: string;
    };

    if (result.reason === 'deduplicated') {
      // Sync already in progress - this is fine
      return { success: true, queued: false };
    }

    return {
      success: result.success,
      queued: result.queued,
      completed: result.completed,
      taskId: result.taskId,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    console.warn('[GM-SYNC] Error triggering vault sync:', error);
    // Don't fail the API mutation if GM is unreachable
    // The periodic sync will eventually pick up the changes
    return { success: false, error };
  }
}
