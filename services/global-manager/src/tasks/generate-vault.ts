/**
 * Generate Vault Task
 *
 * Generates versioned vault files for HAProxy configuration.
 * Uses @walrus/vault-codec for content management and @walrus/kvcrypt for encryption.
 *
 * Vault types generated:
 * - sma: Seal Mainnet API (customer API keys, rate limits, HAProxy config)
 *
 * Process:
 * 1. Fetch current seq from system_control (DB-authoritative version)
 * 2. Build vault data from customers, services, and API keys
 * 3. Check content hash for changes (skip if unchanged)
 * 4. Increment seq and write vault using VaultWriter
 * 5. Update DB with new seq and content hash
 */

import { db, systemControl, customers, serviceInstances, apiKeys } from '@suiftly/database';
import { SERVICE_TYPE, SERVICE_STATE, type ServiceType } from '@suiftly/shared/constants';
import { createVaultWriter, computeContentHash } from '@walrus/vault-codec';
import { eq, and, isNull } from 'drizzle-orm';

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
 * Customer configuration stored in vault
 * This is the structure HAProxy uses for rate limiting and access control
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
}

/**
 * Build vault data for a specific service type
 */
async function buildVaultData(serviceType: ServiceType): Promise<Record<string, string>> {
  const vaultData: Record<string, string> = {};

  // Get all enabled/suspended services for this service type
  // (not_provisioned and disabled services don't need HAProxy config)
  const services = await db
    .select({
      customerId: serviceInstances.customerId,
      state: serviceInstances.state,
      tier: serviceInstances.tier,
      isUserEnabled: serviceInstances.isUserEnabled,
    })
    .from(serviceInstances)
    .where(
      and(
        eq(serviceInstances.serviceType, serviceType),
        // Include any state except not_provisioned (need to track disabled for access denial)
      )
    );

  // Get API keys for each customer
  for (const service of services) {
    // Skip not_provisioned services entirely
    if (service.state === SERVICE_STATE.NOT_PROVISIONED) {
      continue;
    }

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

    // Store as JSON string with customer: prefix
    vaultData[`customer:${service.customerId}`] = JSON.stringify(config);
  }

  return vaultData;
}

/**
 * Generate vault for a specific type
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
}> {
  const columns = VAULT_COLUMNS[vaultType];
  if (!columns) {
    throw new Error(`Unknown vault type: ${vaultType}`);
  }

  // 1. Get current seq from system_control
  const [control] = await db
    .select()
    .from(systemControl)
    .where(eq(systemControl.id, 1))
    .limit(1);

  const currentSeq = (control?.[columns.seq] as number) ?? 0;
  const currentHash = (control?.[columns.hash] as string) ?? null;

  // 2. Determine service type from vault code
  // sma/smm/sms/smo = seal mainnet, sta/stm/sts/sto = seal testnet, skk = seal test
  // First letter: s=seal, r=grpc, g=graphql
  // Second letter: m=mainnet, t=testnet, k=test
  // Third letter: a=api, m=master, s=seed, o=open
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

  // 3. Build vault data
  const vaultData = await buildVaultData(serviceType);
  const customerCount = Object.keys(vaultData).length;

  // 4. Compute content hash
  const contentHash = computeContentHash(vaultData);

  // 5. Check if content changed
  if (contentHash === currentHash) {
    console.log(`[VAULT] ${vaultType} unchanged (seq=${currentSeq}, hash=${contentHash}, customers=${customerCount})`);
    return {
      generated: false,
      seq: currentSeq,
      contentHash,
      customerCount,
      reason: 'unchanged',
    };
  }

  // 6. Content changed - increment seq and write
  const newSeq = currentSeq + 1;

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

  // 7. Update DB with new seq and content hash
  await db
    .update(systemControl)
    .set({
      [columns.seq]: newSeq,
      [columns.hash]: contentHash,
      updatedAt: new Date(),
    })
    .where(eq(systemControl.id, 1));

  console.log(`[VAULT] ${vaultType} generated (seq=${newSeq}, hash=${contentHash}, customers=${customerCount}, file=${result.filename})`);

  return {
    generated: true,
    seq: newSeq,
    contentHash,
    customerCount,
    filename: result.filename,
  };
}

/**
 * Generate Seal Mainnet API vault (sma)
 * This is the primary vault for HAProxy customer configuration
 */
export async function generateSMAVault(storageDir?: string) {
  return generateVault('sma', storageDir);
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
