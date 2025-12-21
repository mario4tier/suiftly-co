/**
 * Generate Vault Task
 *
 * Generates versioned vault files for HAProxy configuration.
 * Uses @walrus/vault-codec for content management and @walrus/kvcrypt for encryption.
 *
 * Vault types generated:
 * - sma: Seal Mainnet API (customer API keys, rate limits, HAProxy config)
 * - sta: Seal Testnet API (future)
 *
 * Two scenarios trigger vault generation:
 *
 * Scenario 1 (Reactive): Customer config change
 * - API reads nextVaultSeq and sets configChangeVaultSeq to that value
 * - API atomically updates maxConfigChangeSeq = GREATEST(maxConfigChangeSeq, nextVaultSeq)
 * - GM detects pending when maxConfigChangeSeq > currentVaultSeq (O(1) check)
 *
 * Scenario 2 (Drift Detection): Periodic check
 * - Compare what vault SHOULD contain (from DB) vs what it DOES contain (data_tx)
 * - If different, increment seq and create new vault
 * - Catches file corruption, manual changes, DB/file desync
 *
 * Race condition prevention:
 * - GM bumps nextSeq to currentSeq+2 BEFORE building vault data
 * - Any API changes during vault build get assigned currentSeq+2
 * - These changes won't be in the vault (built before they happened)
 * - But configChangeSeq = currentSeq+2 > newSeq, so they appear "not synced"
 * - Next generation cycle will include them
 *
 * Process:
 * 1. Read currentSeq and maxPendingSeq from system_control
 * 2. Bump nextSeq to currentSeq+2 (reserves slot, prevents race conditions)
 * 3. Build vault data from DB
 * 4. Check drift against cached data_tx content
 * 5. If no changes, return early
 * 6. Calculate newSeq (max of maxPendingSeq and currentSeq+1)
 * 7. Write vault to data_tx
 * 8. Update DB with new seq, content hash, reset nextSeq to newSeq+1
 *
 * Sync status determination:
 * - API compares service.configChangeVaultSeq vs LM.minAppliedSeq
 * - If configChangeVaultSeq > minAppliedSeq → service is "pending" (not synced)
 * - If configChangeVaultSeq <= minAppliedSeq → service is "synced"
 * - No reset of configChangeVaultSeq needed - the comparison handles it
 */

import { db, systemControl, serviceInstances, apiKeys, sealKeys, sealPackages } from '@suiftly/database';
import { SERVICE_TYPE, SERVICE_STATE, type ServiceType } from '@suiftly/shared/constants';
import { createVaultWriter, createVaultReader, computeContentHash, type VaultInstance } from '@walrus/vault-codec';
import { eq, and, isNull } from 'drizzle-orm';

// ============================================================================
// HAProxy Map Encoding - Tier Configuration
// ============================================================================

/**
 * Tier configuration for HAProxy rate limiting
 * See: HAPROXY_CONTROLS.md for format details
 *
 * - ilim: Per-IP rate limit (ILIM × 4 req/sec)
 * - glim: Guaranteed rate limit (GLIM × 4 req/sec)
 * - blim: Burst rate limit (BLIM × 4 req/sec, 0 = no burst)
 * - bqos: Burst QoS priority (0-15, 0 = burst disabled)
 */
const TIER_CONFIG: Record<string, { ilim: number; glim: number; blim: number; bqos: number }> = {
  starter: { ilim: 0x02, glim: 0x02, blim: 0x00, bqos: 0x0 },    // 8 req/sec, no burst
  pro: { ilim: 0x10, glim: 0x06, blim: 0x06, bqos: 0x2 },        // 24 req/sec + burst
  enterprise: { ilim: 0x40, glim: 0x18, blim: 0x18, bqos: 0x3 }, // 96 req/sec + burst
};

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
type VaultNextSeqColumn = keyof Pick<typeof systemControl.$inferSelect,
  'smaNextVaultSeq' | 'smmNextVaultSeq' | 'smsNextVaultSeq' | 'smoNextVaultSeq' |
  'staNextVaultSeq' | 'stmNextVaultSeq' | 'stsNextVaultSeq' | 'stoNextVaultSeq' | 'skkNextVaultSeq'
>;

const VAULT_COLUMNS: Record<VaultTypeCode, { seq: VaultSeqColumn; hash: VaultHashColumn; nextSeq: VaultNextSeqColumn }> = {
  sma: { seq: 'smaVaultSeq', hash: 'smaVaultContentHash', nextSeq: 'smaNextVaultSeq' },
  smm: { seq: 'smmVaultSeq', hash: 'smmVaultContentHash', nextSeq: 'smmNextVaultSeq' },
  sms: { seq: 'smsVaultSeq', hash: 'smsVaultContentHash', nextSeq: 'smsNextVaultSeq' },
  smo: { seq: 'smoVaultSeq', hash: 'smoVaultContentHash', nextSeq: 'smoNextVaultSeq' },
  sta: { seq: 'staVaultSeq', hash: 'staVaultContentHash', nextSeq: 'staNextVaultSeq' },
  stm: { seq: 'stmVaultSeq', hash: 'stmVaultContentHash', nextSeq: 'stmNextVaultSeq' },
  sts: { seq: 'stsVaultSeq', hash: 'stsVaultContentHash', nextSeq: 'stsNextVaultSeq' },
  sto: { seq: 'stoVaultSeq', hash: 'stoVaultContentHash', nextSeq: 'stoNextVaultSeq' },
  skk: { seq: 'skkVaultSeq', hash: 'skkVaultContentHash', nextSeq: 'skkNextVaultSeq' },
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

// Column mapping for global max configChangeSeq per vault type
type VaultMaxConfigChangeColumn = keyof Pick<typeof systemControl.$inferSelect,
  'smaMaxConfigChangeSeq' | 'staMaxConfigChangeSeq'
>;

const VAULT_MAX_CONFIG_COLUMNS: Partial<Record<VaultTypeCode, VaultMaxConfigChangeColumn>> = {
  sma: 'smaMaxConfigChangeSeq',
  sta: 'staMaxConfigChangeSeq',
};

/**
 * Check if any customer has a pending config change that requires vault regeneration.
 * Uses O(1) global max check instead of O(n) MAX query on all services.
 * Returns { hasPending: true, maxPendingSeq } if maxConfigChangeSeq > currentVaultSeq.
 */
async function hasPendingCustomerChanges(
  vaultType: VaultTypeCode,
  currentVaultSeq: number
): Promise<{ hasPending: boolean; maxPendingSeq: number }> {
  try {
    const maxColumn = VAULT_MAX_CONFIG_COLUMNS[vaultType];
    if (!maxColumn) {
      // This vault type doesn't track config changes (e.g., master/seed vaults)
      return { hasPending: false, maxPendingSeq: 0 };
    }

    // O(1) read of global max from system_control
    const [control] = await db
      .select({ maxSeq: systemControl[maxColumn] })
      .from(systemControl)
      .where(eq(systemControl.id, 1))
      .limit(1);

    const maxPendingSeq = control?.maxSeq ?? 0;

    if (maxPendingSeq <= currentVaultSeq) {
      return { hasPending: false, maxPendingSeq: 0 };
    }

    console.log(
      `[VAULT] Pending changes detected (max configChangeSeq=${maxPendingSeq}, currentVaultSeq=${currentVaultSeq})`
    );

    return { hasPending: true, maxPendingSeq };
  } catch (error) {
    console.error(`[VAULT] ERROR: hasPendingCustomerChanges query failed:`, error);
    throw error; // Re-throw to propagate to caller
  }
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
 * Service-specific configuration within a customer vault entry
 * Each customer can have multiple services (seal, grpc, graphql)
 */
interface ServiceVaultConfig {
  /** Service type */
  serviceType: 'seal' | 'grpc' | 'graphql';
  /** Network (mainnet or testnet) */
  network: 'mainnet' | 'testnet';
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
  /** IP allowlist CIDRs (for control bit 1) */
  ipAllowlist?: string[];
  /** Pre-encoded HAProxy map config (67 chars CSV format) */
  mapConfigHex: string;
  /** Extra API key fingerprints for extra_keys.map (when >2 keys) */
  extraApiKeyFps?: number[];
}

/**
 * Customer configuration stored in vault
 * Top-level structure with customerId and services array
 */
interface CustomerVaultConfig {
  /** Customer ID */
  customerId: number;
  /** Services for this customer */
  services: ServiceVaultConfig[];
}

// ============================================================================
// HAProxy Map Encoding Functions
// ============================================================================

/**
 * Encode IP filter field from allowlist
 * Extracts first 2 /32 IPv4 addresses from CIDR list
 *
 * @param allowlist - Array of CIDR strings
 * @returns 16-char hex string for IP filter field
 */
function encodeIpFilterField(allowlist?: string[]): string {
  if (!allowlist || allowlist.length === 0) {
    return '0000000000000000';
  }

  // Extract first 2 /32 IPv4 addresses
  const ipv4s: number[] = [];
  for (const cidr of allowlist) {
    if (ipv4s.length >= 2) break;
    const match = cidr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/32$/);
    if (match) {
      const ip =
        (parseInt(match[1], 10) << 24) |
        (parseInt(match[2], 10) << 16) |
        (parseInt(match[3], 10) << 8) |
        parseInt(match[4], 10);
      ipv4s.push(ip >>> 0); // Convert to unsigned
    }
  }

  const ip1 = (ipv4s[0] ?? 0).toString(16).padStart(8, '0');
  const ip2 = (ipv4s[1] ?? 0).toString(16).padStart(8, '0');
  return ip1 + ip2;
}

/**
 * Encode customer map configuration for HAProxy
 * Produces 67-char CSV format: header,api_keys,ip_filter,extra
 *
 * Header format (16 hex): 00000ILGLBLQCCCC
 * - Positions 5-6: ILIM (per-IP limit)
 * - Positions 7-8: GLIM (guaranteed limit)
 * - Positions 9-10: BLIM (burst limit)
 * - Position 11: BQoS (0-F)
 * - Positions 12-15: Control flags
 *
 * @param tier - Service tier (starter, pro, enterprise)
 * @param status - Service status (active, suspended, disabled)
 * @param isUserEnabled - User toggle state
 * @param apiKeyFps - Array of API key fingerprints
 * @param ipAllowlist - Optional array of CIDR strings
 */
function encodeCustomerMapConfig(
  tier: string,
  status: 'active' | 'suspended' | 'disabled',
  isUserEnabled: boolean,
  apiKeyFps: number[],
  ipAllowlist?: string[]
): {
  mapConfigHex: string;
  extraApiKeyFps?: number[];
  controlFlags: number;
} {
  const tierCfg = TIER_CONFIG[tier] ?? TIER_CONFIG.starter;
  const isActive = status === 'active' && isUserEnabled;

  // Compute effective limits (0 if disabled/suspended)
  const ilim = isActive ? tierCfg.ilim : 0;
  const glim = isActive ? tierCfg.glim : 0;
  const blim = isActive ? tierCfg.blim : 0;
  const bqos = isActive ? tierCfg.bqos : 0;

  // Compute control flags
  let control = 0x0000;
  const hasIpAllowlist = (ipAllowlist?.length ?? 0) > 0;
  const hasExtraKeys = apiKeyFps.length > 2;

  if (hasIpAllowlist) control |= 0x0002; // Bit 1: IP_ALLOWLIST_ENABLED
  if (hasExtraKeys) control |= 0x0004; // Bit 2: EXTRA_KEYS_ENABLED

  // Header: 00000ILGLBLQCCCC (16 hex chars)
  const headerHex =
    '00000' +
    ilim.toString(16).padStart(2, '0') +
    glim.toString(16).padStart(2, '0') +
    blim.toString(16).padStart(2, '0') +
    bqos.toString(16) +
    control.toString(16).padStart(4, '0');

  // API Keys: first 2 fingerprints (16 hex chars)
  // Use unsigned right shift to convert signed int32 to unsigned for hex encoding
  const fp1 = ((apiKeyFps[0] ?? 0) >>> 0).toString(16).padStart(8, '0');
  const fp2 = ((apiKeyFps[1] ?? 0) >>> 0).toString(16).padStart(8, '0');
  const apiKeysHex = fp1 + fp2;

  // IP Filter: first 2 IPv4 /32 addresses (16 hex chars)
  const ipFilterHex = encodeIpFilterField(ipAllowlist);

  // Extra: reserved (16 hex chars, all zeros)
  const extraHex = '0000000000000000';

  return {
    mapConfigHex: `${headerHex},${apiKeysHex},${ipFilterHex},${extraHex}`,
    extraApiKeyFps: hasExtraKeys ? apiKeyFps.slice(2) : undefined,
    controlFlags: control,
  };
}

/**
 * Get network from vault type code
 */
function getNetworkFromVaultType(vaultType: string): 'mainnet' | 'testnet' {
  // Second character: m = mainnet, t = testnet
  return vaultType[1] === 'm' ? 'mainnet' : 'testnet';
}

/**
 * Get service type string for ServiceVaultConfig
 */
function getServiceTypeString(serviceType: ServiceType): 'seal' | 'grpc' | 'graphql' {
  switch (serviceType) {
    case SERVICE_TYPE.SEAL:
      return 'seal';
    case SERVICE_TYPE.GRPC:
      return 'grpc';
    case SERVICE_TYPE.GRAPHQL:
      return 'graphql';
    default:
      return 'seal'; // Default fallback
  }
}

/**
 * Build vault data for a specific service type
 * Only includes services where cpEnabled=true (provisioned to control plane)
 *
 * New structure: CustomerVaultConfig with services[] array
 * Each service contains pre-encoded mapConfigHex for HAProxy
 */
async function buildVaultData(
  serviceType: ServiceType,
  vaultType: string
): Promise<Record<string, string>> {
  const vaultData: Record<string, string> = {};
  const network = getNetworkFromVaultType(vaultType);
  const serviceTypeStr = getServiceTypeString(serviceType);

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

      const apiKeyFps = keys.map((k) => k.apiKeyFp);
      const status = getVaultStatus(service.state);

      // TODO: Get IP allowlist from database when implemented
      // For now, ipAllowlist is undefined (no IP restrictions)
      const ipAllowlist: string[] | undefined = undefined;

      // Encode HAProxy map config
      const { mapConfigHex, extraApiKeyFps } = encodeCustomerMapConfig(
        service.tier,
        status,
        service.isUserEnabled,
        apiKeyFps,
        ipAllowlist
      );

      // Build service config
      const serviceConfig: ServiceVaultConfig = {
        serviceType: serviceTypeStr,
        network,
        apiKeyFps,
        tier: service.tier,
        status,
        isUserEnabled: service.isUserEnabled,
        mapConfigHex,
      };

      // Add extra API key fingerprints if >2 keys
      if (extraApiKeyFps && extraApiKeyFps.length > 0) {
        serviceConfig.extraApiKeyFps = extraApiKeyFps;
      }

      // Add IP allowlist if configured
      // TODO: Enable when IP allowlist is implemented in database
      // if (ipAllowlist && ipAllowlist.length > 0) {
      //   serviceConfig.ipAllowlist = ipAllowlist;
      // }

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
              and(eq(sealPackages.sealKeyId, sk.sealKeyId), eq(sealPackages.isUserEnabled, true))
            );

          sealKeysConfig.push({
            sealKeyId: sk.sealKeyId,
            publicKey: Buffer.from(sk.publicKey).toString('hex'),
            packages: packages.map((p) => Buffer.from(p.packageAddress).toString('hex')),
            isUserEnabled: sk.isUserEnabled,
          });
        }

        if (sealKeysConfig.length > 0) {
          serviceConfig.sealKeys = sealKeysConfig;
        }
      }

      // Build customer vault config with services array
      const config: CustomerVaultConfig = {
        customerId: service.customerId,
        services: [serviceConfig],
      };

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
  const currentNextSeq = (control?.[columns.nextSeq] as number) ?? 1;

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
  // Read maxPendingSeq BEFORE bumping nextSeq (snapshot for newSeq calculation)
  const { hasPending, maxPendingSeq } = await hasPendingCustomerChanges(vaultType, currentSeq);

  // 4. Bump nextSeq to currentSeq+2 BEFORE building vault data
  // This is critical for preventing race conditions:
  // - Any API changes that happen during buildVaultData will get assigned currentSeq+2
  // - Those changes won't be in this vault (built before they happened)
  // - But they'll have configChangeSeq = currentSeq+2 > newSeq, so they appear "not synced"
  // - Next generation cycle will include them
  //
  // If we bump AFTER buildVaultData, a concurrent change would:
  // - Use the OLD nextSeq (currentSeq+1)
  // - Not be in the vault (happened during build)
  // - But configChangeSeq would match vault seq → appears synced when it's NOT!
  //
  // Skip write if already at target value (reduces DB writes during idle periods)
  const targetNextSeq = currentSeq + 2;
  if (currentNextSeq !== targetNextSeq) {
    await db
      .update(systemControl)
      .set({ [columns.nextSeq]: targetNextSeq })
      .where(eq(systemControl.id, 1));
  }

  // 5. Build vault data from DB (needed for both scenarios)
  // Any API changes from this point forward will use currentSeq+2
  const vaultData = await buildVaultData(serviceType, vaultType);
  const customerCount = Object.keys(vaultData).length;
  const contentHash = computeContentHash(vaultData);

  // 6. Check Scenario 2: Drift detection (only if no pending changes)
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

  // 7. Determine if we need to generate
  // Note: nextSeq was already bumped in step 4 - this is intentional.
  // Even if we return early here, the bump is acceptable (one extra write per cycle)
  // vs the alternative of a race condition causing false "synced" status.
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

  // 8. Calculate new seq number
  // For pending changes: use the max pending seq (ensures we satisfy all pending requests)
  // For drift: increment current seq by 1
  const newSeq = hasPending ? Math.max(currentSeq + 1, maxPendingSeq) : currentSeq + 1;

  // 9. Write vault to data_tx
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

  // 10. Update DB with new seq, content hash, and reset nextSeq
  await db
    .update(systemControl)
    .set({
      [columns.seq]: newSeq,
      [columns.hash]: contentHash,
      [columns.nextSeq]: newSeq + 1, // Reset for next cycle
      updatedAt: new Date(),
    })
    .where(eq(systemControl.id, 1));

  // 11. Clear vault cache to force reload on next access
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
