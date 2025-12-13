/**
 * Generate Vault Task
 *
 * Generates versioned vault files for HAProxy configuration.
 * Uses @walrus/vault-codec for content management and @walrus/kvcrypt for encryption.
 *
 * Vault types generated:
 * - sma: Seal Mainnet API (customer API keys, rate limits, HAProxy config)
 *
 * Two scenarios trigger vault generation:
 *
 * Scenario 1 (Reactive): Customer config change
 * - User action sets configChangeVaultSeq = currentVaultSeq + 1
 * - If any customer has configChangeVaultSeq > currentVaultSeq, MUST create new vault
 * - No content comparison needed - the higher seq is the signal
 *
 * Scenario 2 (Drift Detection): Periodic check
 * - Compare what vault SHOULD contain (from DB) vs what it DOES contain (data_tx)
 * - If different, increment seq and create new vault
 * - Catches file corruption, manual changes, DB/file desync
 *
 * Process:
 * 1. Check for pending customer changes (scenario 1)
 * 2. Build vault data from DB
 * 3. Compare against actual data_tx content (scenario 2)
 * 4. If changes detected, increment seq and write vault
 * 5. Update DB with new seq and content hash
 * 6. Reset configChangeVaultSeq for customers now synced
 */

import { db, systemControl, serviceInstances, apiKeys, sealKeys, sealPackages } from '@suiftly/database';
import { SERVICE_TYPE, SERVICE_STATE, type ServiceType } from '@suiftly/shared/constants';
import { createVaultWriter, createVaultReader, computeContentHash, type VaultInstance } from '@walrus/vault-codec';
import { eq, and, isNull, gt, lte } from 'drizzle-orm';

// Type for vault type codes
type VaultTypeCode = 'sma' | 'smm' | 'sms' | 'smo' | 'sta' | 'stm' | 'sts' | 'sto' | 'skk';

// Column mapping for vault types in system_control
type VaultSeqColumn = keyof Pick<typeof systemControl.$inferSelect,
  'smaVaultSeq' | 'smmVaultSeq' | 'smsVaultSeq' | 'smoVaultSeq' |
  'staVaultSeq' | 'stmVaultSeq' | 'stsVaultSeq' | 'stoVaultSeq' | 'skkVaultSeq'
>;
type VaultHashColumn = keyof Pick<typeof systemControl.$inferSelect,
  'smaVaultContentHash' | 'smmVaultContentHash' | 'smsVaultContentHash' | 'smoVaultContentHash' |
  'staVaultContentHash' | 'stmVaultContentHash' | 'stsVaultContentHash' | 'stoVaultContentHash' | 'skkVaultContentHash'
>;

const VAULT_COLUMNS: Record<VaultTypeCode, { seq: VaultSeqColumn; hash: VaultHashColumn }> = {
  sma: { seq: 'smaVaultSeq', hash: 'smaVaultContentHash' },
  smm: { seq: 'smmVaultSeq', hash: 'smmVaultContentHash' },
  sms: { seq: 'smsVaultSeq', hash: 'smsVaultContentHash' },
  smo: { seq: 'smoVaultSeq', hash: 'smoVaultContentHash' },
  sta: { seq: 'staVaultSeq', hash: 'staVaultContentHash' },
  stm: { seq: 'stmVaultSeq', hash: 'stmVaultContentHash' },
  sts: { seq: 'stsVaultSeq', hash: 'stsVaultContentHash' },
  sto: { seq: 'stoVaultSeq', hash: 'stoVaultContentHash' },
  skk: { seq: 'skkVaultSeq', hash: 'skkVaultContentHash' },
};

// ============================================================================
// Vault Cache
// ============================================================================

// Cache of loaded vaults from data_tx (keyed by vaultType)
// Stores the latest vault instance to avoid re-reading from disk on every check
const vaultCache = new Map<VaultTypeCode, VaultInstance | null>();

/**
 * Get cached vault or load from data_tx
 * Returns null if no vault exists in data_tx
 */
async function getCachedVault(
  vaultType: VaultTypeCode,
  storageDir: string
): Promise<VaultInstance | null> {
  // Check cache first
  if (vaultCache.has(vaultType)) {
    return vaultCache.get(vaultType) ?? null;
  }

  // Load from data_tx
  const reader = createVaultReader({ storageDir });
  const vault = await reader.loadLatest(vaultType);

  // Cache the result (even if null)
  vaultCache.set(vaultType, vault);
  return vault;
}

// ============================================================================
// Scenario 1: Check for Pending Customer Changes
// ============================================================================

/**
 * Check if any customer has a pending config change that requires vault regeneration.
 * Returns true if any customer's configChangeVaultSeq > currentVaultSeq.
 */
async function hasPendingCustomerChanges(
  serviceType: ServiceType,
  currentVaultSeq: number
): Promise<{ hasPending: boolean; maxPendingSeq: number }> {
  try {
    // Find any service with configChangeVaultSeq > current vault seq
    const pendingServices = await db
      .select({
        customerId: serviceInstances.customerId,
        configChangeVaultSeq: serviceInstances.configChangeVaultSeq,
      })
      .from(serviceInstances)
      .where(
        and(
          eq(serviceInstances.serviceType, serviceType),
          eq(serviceInstances.cpEnabled, true),
          gt(serviceInstances.configChangeVaultSeq, currentVaultSeq)
        )
      );

    if (pendingServices.length === 0) {
      return { hasPending: false, maxPendingSeq: 0 };
    }

    // Find the maximum pending seq
    const maxPendingSeq = Math.max(...pendingServices.map(s => s.configChangeVaultSeq ?? 0));

    console.log(
      `[VAULT] ${pendingServices.length} customers have pending changes (max seq=${maxPendingSeq}, current=${currentVaultSeq})`
    );

    return { hasPending: true, maxPendingSeq };
  } catch (error) {
    console.error(`[VAULT] ERROR: hasPendingCustomerChanges query failed:`, error);
    throw error; // Re-throw to propagate to caller
  }
}

/**
 * Reset configChangeVaultSeq for customers that are now synced.
 * Called after successful vault generation.
 */
async function resetSyncedCustomers(
  serviceType: ServiceType,
  newVaultSeq: number
): Promise<number> {
  // Reset configChangeVaultSeq to 0 for all services where configChangeVaultSeq <= newVaultSeq
  const result = await db
    .update(serviceInstances)
    .set({ configChangeVaultSeq: 0 })
    .where(
      and(
        eq(serviceInstances.serviceType, serviceType),
        gt(serviceInstances.configChangeVaultSeq, 0),
        lte(serviceInstances.configChangeVaultSeq, newVaultSeq)
      )
    );

  // Drizzle doesn't return rowCount directly, so we can't easily count affected rows
  // Just return 0 for now (the operation still works)
  return 0;
}

// ============================================================================
// Scenario 2: Drift Detection
// ============================================================================

/**
 * Compare built vault data against actual data_tx content.
 * Returns true if they differ (drift detected).
 */
function detectDrift(
  builtData: Record<string, string>,
  cachedVault: VaultInstance | null
): { hasDrift: boolean; reason?: string } {
  // If no vault exists in data_tx, we have drift (need to create initial vault)
  if (!cachedVault) {
    if (Object.keys(builtData).length > 0) {
      return { hasDrift: true, reason: 'no_vault_in_data_tx' };
    }
    // Both empty - no drift
    return { hasDrift: false };
  }

  const cachedData = cachedVault.data;
  const builtKeys = Object.keys(builtData).sort();
  const cachedKeys = Object.keys(cachedData).sort();

  // Check key count
  if (builtKeys.length !== cachedKeys.length) {
    return {
      hasDrift: true,
      reason: `key_count_mismatch: built=${builtKeys.length}, cached=${cachedKeys.length}`,
    };
  }

  // Check each key
  for (const key of builtKeys) {
    if (!(key in cachedData)) {
      return { hasDrift: true, reason: `missing_key: ${key}` };
    }
    if (builtData[key] !== cachedData[key]) {
      return { hasDrift: true, reason: `value_mismatch: ${key}` };
    }
  }

  // No drift detected
  return { hasDrift: false };
}

// Service state to status mapping for vault
// Only 'enabled' state is operational in HAProxy
function getVaultStatus(state: string): 'active' | 'suspended' | 'disabled' {
  switch (state) {
    case SERVICE_STATE.ENABLED:
      return 'active';
    case SERVICE_STATE.SUSPENDED_MAINTENANCE:
    case SERVICE_STATE.SUSPENDED_NO_PAYMENT:
      return 'suspended';
    default:
      return 'disabled';
  }
}

/**
 * Seal key with packages for vault
 */
interface SealKeyVaultConfig {
  /** Seal key ID */
  sealKeyId: number;
  /** Public key (hex-encoded BLS12-381 G1 point) */
  publicKey: string;
  /** Package addresses (hex-encoded 32-byte addresses) */
  packages: string[];
  /** Is user-enabled flag */
  isUserEnabled: boolean;
}

/**
 * Customer configuration stored in vault
 * This is the structure HAProxy/key-server uses for rate limiting and access control
 */
interface CustomerVaultConfig {
  /** Customer ID */
  customerId: number;
  /** API key fingerprints (32-bit integers) */
  apiKeyFps: number[];
  /** Service tier */
  tier: string;
  /** Customer status for this service */
  status: 'active' | 'suspended' | 'disabled';
  /** Is user-enabled flag */
  isUserEnabled: boolean;
  /** Seal keys with their packages (for seal service only) */
  sealKeys?: SealKeyVaultConfig[];
}

/**
 * Build vault data for a specific service type
 * Only includes services where cpEnabled=true (provisioned to control plane)
 */
async function buildVaultData(serviceType: ServiceType): Promise<Record<string, string>> {
  const vaultData: Record<string, string> = {};

  // Get all cpEnabled services for this service type
  // cpEnabled=true means the service has been provisioned to gateways
  let services;
  try {
    services = await db
      .select({
        customerId: serviceInstances.customerId,
        instanceId: serviceInstances.instanceId,
        state: serviceInstances.state,
        tier: serviceInstances.tier,
        isUserEnabled: serviceInstances.isUserEnabled,
        cpEnabled: serviceInstances.cpEnabled,
      })
      .from(serviceInstances)
      .where(
        and(
          eq(serviceInstances.serviceType, serviceType),
          eq(serviceInstances.cpEnabled, true)
        )
      );
  } catch (error) {
    console.error(`[VAULT] ERROR: buildVaultData services query failed:`, error);
    throw error;
  }

  // Build config for each cpEnabled customer
  for (const service of services) {
    try {
      // Get active API keys for this customer and service type
      const keys = await db
        .select({
          apiKeyFp: apiKeys.apiKeyFp,
        })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.customerId, service.customerId),
            eq(apiKeys.serviceType, serviceType),
            eq(apiKeys.isUserEnabled, true),
            isNull(apiKeys.revokedAt),
            isNull(apiKeys.deletedAt)
          )
        );

      const config: CustomerVaultConfig = {
        customerId: service.customerId,
        apiKeyFps: keys.map(k => k.apiKeyFp),
        tier: service.tier,
        status: getVaultStatus(service.state),
        isUserEnabled: service.isUserEnabled,
      };

      // For seal services, include seal keys with their packages
      if (serviceType === SERVICE_TYPE.SEAL) {
        const sealKeysData = await db
          .select({
            sealKeyId: sealKeys.sealKeyId,
            publicKey: sealKeys.publicKey,
            isUserEnabled: sealKeys.isUserEnabled,
          })
          .from(sealKeys)
          .where(eq(sealKeys.instanceId, service.instanceId));

        const sealKeysConfig: SealKeyVaultConfig[] = [];

        for (const sk of sealKeysData) {
          // Get packages for this seal key
          const packages = await db
            .select({
              packageAddress: sealPackages.packageAddress,
            })
            .from(sealPackages)
            .where(
              and(
                eq(sealPackages.sealKeyId, sk.sealKeyId),
                eq(sealPackages.isUserEnabled, true)
              )
            );

          sealKeysConfig.push({
            sealKeyId: sk.sealKeyId,
            publicKey: Buffer.from(sk.publicKey).toString('hex'),
            packages: packages.map(p => Buffer.from(p.packageAddress).toString('hex')),
            isUserEnabled: sk.isUserEnabled,
          });
        }

        if (sealKeysConfig.length > 0) {
          config.sealKeys = sealKeysConfig;
        }
      }

      // Store as JSON string with customer: prefix
      vaultData[`customer:${service.customerId}`] = JSON.stringify(config);
    } catch (error) {
      console.error(`[VAULT] ERROR: buildVaultData failed for customer ${service.customerId}:`, error);
      throw error; // Re-throw - one customer failure should fail the whole vault
    }
  }

  return vaultData;
}

/**
 * Generate vault for a specific type
 *
 * Implements two scenarios:
 * - Scenario 1 (Reactive): Customer has configChangeVaultSeq > currentVaultSeq
 * - Scenario 2 (Drift): DB content differs from data_tx content
 *
 * @param vaultType - The vault type code (e.g., 'sma' for seal mainnet api)
 * @param storageDir - Directory to write vault files (default: /opt/syncf/data_tx)
 * @returns Result object with generation details
 */
export async function generateVault(
  vaultType: VaultTypeCode,
  storageDir: string = '/opt/syncf/data_tx'
): Promise<{
  generated: boolean;
  seq: number;
  contentHash: string;
  customerCount: number;
  filename?: string;
  reason?: string;
  trigger?: 'pending_changes' | 'drift' | 'none';
}> {
  const columns = VAULT_COLUMNS[vaultType];
  if (!columns) {
    throw new Error(`Unknown vault type: ${vaultType}`);
  }

  // 1. Get current seq from system_control (DB authoritative)
  const [control] = await db
    .select()
    .from(systemControl)
    .where(eq(systemControl.id, 1))
    .limit(1);

  const currentSeq = (control?.[columns.seq] as number) ?? 0;

  // 2. Determine service type from vault code
  const serviceTypeChar = vaultType[0];
  let serviceType: ServiceType;
  switch (serviceTypeChar) {
    case 's':
      serviceType = SERVICE_TYPE.SEAL;
      break;
    case 'r':
      serviceType = SERVICE_TYPE.GRPC;
      break;
    case 'g':
      serviceType = SERVICE_TYPE.GRAPHQL;
      break;
    default:
      throw new Error(`Invalid service type character in vault type: ${vaultType}`);
  }

  // 3. Check Scenario 1: Pending customer changes
  const { hasPending, maxPendingSeq } = await hasPendingCustomerChanges(serviceType, currentSeq);

  // 4. Build vault data from DB (needed for both scenarios)
  const vaultData = await buildVaultData(serviceType);
  const customerCount = Object.keys(vaultData).length;
  const contentHash = computeContentHash(vaultData);

  // 5. Check Scenario 2: Drift detection (only if no pending changes)
  let hasDrift = false;
  let driftReason: string | undefined;

  if (!hasPending) {
    // Load cached vault from data_tx
    const cachedVault = await getCachedVault(vaultType, storageDir);
    const driftResult = detectDrift(vaultData, cachedVault);
    hasDrift = driftResult.hasDrift;
    driftReason = driftResult.reason;

    if (hasDrift) {
      console.log(`[VAULT] ${vaultType} drift detected: ${driftReason}`);
    }
  }

  // 6. Determine if we need to generate
  const shouldGenerate = hasPending || hasDrift;

  if (!shouldGenerate) {
    console.log(`[VAULT] ${vaultType} unchanged (seq=${currentSeq}, hash=${contentHash}, customers=${customerCount})`);
    return {
      generated: false,
      seq: currentSeq,
      contentHash,
      customerCount,
      reason: 'unchanged',
      trigger: 'none',
    };
  }

  // 7. Determine new seq number
  // For pending changes: use the max pending seq (ensures we satisfy all pending requests)
  // For drift: increment current seq by 1
  const newSeq = hasPending ? Math.max(currentSeq + 1, maxPendingSeq) : currentSeq + 1;

  // 8. Write vault
  const writer = createVaultWriter({
    storageDir,
    // TODO: Add keyProvider and emergencyPublicKey from config
  });

  const result = await writer.write(vaultType, vaultData, {
    seq: newSeq,
    pg: 1, // Process group 1 (single GM for MVP)
    source: 'gm-primary',
    enableEmergencyBackup: false, // TODO: Enable when emergency keys are configured
  });

  // 9. Update DB with new seq and content hash
  await db
    .update(systemControl)
    .set({
      [columns.seq]: newSeq,
      [columns.hash]: contentHash,
      updatedAt: new Date(),
    })
    .where(eq(systemControl.id, 1));

  // 10. Reset configChangeVaultSeq for synced customers
  if (hasPending) {
    await resetSyncedCustomers(serviceType, newSeq);
  }

  // 11. Update cache with new vault (construct a VaultInstance-like object)
  // Clear cache to force reload on next access (simpler than constructing full instance)
  vaultCache.delete(vaultType);

  const trigger = hasPending ? 'pending_changes' : 'drift';
  console.log(
    `[VAULT] ${vaultType} generated (seq=${newSeq}, hash=${contentHash}, customers=${customerCount}, ` +
    `trigger=${trigger}, file=${result.filename})`
  );

  return {
    generated: true,
    seq: newSeq,
    contentHash,
    customerCount,
    filename: result.filename,
    trigger,
  };
}

/**
 * Generate all API vaults for a network
 * Currently only generates 'sma' (seal mainnet api)
 *
 * Future: Add grpc (rma) and graphql (gma) when services are implemented
 */
export async function generateAllVaults(storageDir?: string) {
  const results: Record<string, Awaited<ReturnType<typeof generateVault>>> = {};

  // Generate seal mainnet api vault
  results.sma = await generateVault('sma', storageDir);

  // Future: Add other vaults
  // results.rma = await generateVault('rma', storageDir);
  // results.gma = await generateVault('gma', storageDir);

  return results;
}
