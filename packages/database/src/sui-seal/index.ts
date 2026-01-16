/**
 * Sui Transaction Service for Seal Key Registration
 *
 * This module handles the interaction with the Sui blockchain for registering
 * and updating KeyServer objects for Seal keys.
 *
 * PRODUCTION: Calls actual Sui RPC to create/update KeyServer objects.
 * DEVELOPMENT: Uses mock implementation with configurable delays and failure injection.
 *
 * Sui Move Contract Reference:
 * - Testnet: 0x927a54e9ae803f82ebf480136a9bcfe45101ccbe28b13f433c89f5181069d682
 * - Mainnet: 0xa212c4c6c7183b911d0be8768f4cb1df7a383025b5d0ba0c014009f0f30f5f8d
 *
 * entry fun create_and_transfer_v1(
 *   name: String,
 *   url: String,
 *   key_type: u8,      // 0 = BLS12-381 G1, 1 = BLS12-381 G2
 *   pk: vector<u8>,    // Public key bytes
 *   ctx: &mut TxContext,
 * )
 */

import { createHash } from 'crypto';
import { isProduction } from '@walrus/system-config';

// ============================================================================
// Types
// ============================================================================

/**
 * Parameters for registering a new KeyServer object on Sui
 */
export interface RegisterKeyParams {
  /** Display name for the key server (max 64 chars) */
  name: string;
  /** URL for the key server endpoint */
  url: string;
  /** Key type: 0 = BLS12-381 G1, 1 = BLS12-381 G2 */
  keyType: number;
  /** BLS12-381 public key bytes (48 bytes for G1, 96 bytes for G2) */
  publicKey: Buffer;
  /** Target network */
  network: 'mainnet' | 'testnet';
  /** Existing object ID (for idempotency check) */
  existingObjectId?: string;
}

/**
 * Parameters for updating a KeyServer's packages
 */
export interface UpdateKeyParams {
  /** Sui object ID of the KeyServer (0x-prefixed) */
  objectId: string;
  /** Updated list of package addresses (0x-prefixed) */
  packages: string[];
  /** Target network */
  network: 'mainnet' | 'testnet';
}

/**
 * Result of a Sui transaction for key registration
 */
export interface RegisterKeyResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** KeyServer object ID (0x-prefixed, 64 hex chars) */
  objectId?: string;
  /** Transaction digest (0x-prefixed, 64 hex chars) */
  txDigest?: string;
  /** True if object already existed (idempotency hit) */
  alreadyExists?: boolean;
  /** Error message if failed */
  error?: string;
}

// ============================================================================
// Mock Configuration
// ============================================================================

/**
 * Configuration for mock Sui transaction service behavior
 */
export interface SuiTxMockConfig {
  /** Delay in milliseconds before returning (default: 2000) */
  registerDelayMs?: number;
  /** Delay for update operations (default: 2000) */
  updateDelayMs?: number;
  /** Force registration to fail with this message */
  forceRegisterFailure?: string;
  /** Force update to fail with this message */
  forceUpdateFailure?: string;
  /** Failure probability (0-1) for random failures in tests */
  failureProbability?: number;
}

// Singleton mock configuration
let mockConfig: SuiTxMockConfig = {};

/**
 * Set mock configuration (test/development only)
 */
export function setSuiTxMockConfig(config: SuiTxMockConfig): void {
  mockConfig = { ...mockConfig, ...config };
  console.log('[SUI TX MOCK] Config updated:', mockConfig);
}

/**
 * Clear mock configuration
 */
export function clearSuiTxMockConfig(): void {
  mockConfig = {};
  console.log('[SUI TX MOCK] Config cleared');
}

/**
 * Get current mock configuration
 */
export function getSuiTxMockConfig(): SuiTxMockConfig {
  return { ...mockConfig };
}

// ============================================================================
// Deterministic ID Generation (for mock reproducibility)
// ============================================================================

/**
 * Generate a deterministic object ID from input parameters.
 * This ensures the same inputs always produce the same object ID,
 * which is crucial for test reproducibility and idempotency testing.
 *
 * @param publicKey - The public key bytes
 * @param network - The network ('mainnet' | 'testnet')
 * @returns A 0x-prefixed 64 hex character object ID
 */
function generateDeterministicObjectId(publicKey: Buffer, network: string): string {
  const hash = createHash('sha256')
    .update(publicKey)
    .update(network)
    .update('keyserver-object-id')
    .digest('hex');
  return `0x${hash}`;
}

/**
 * Generate a deterministic transaction digest from input parameters.
 *
 * @param publicKey - The public key bytes
 * @param network - The network
 * @param timestamp - Optional timestamp for uniqueness
 * @returns A 0x-prefixed 64 hex character transaction digest
 */
function generateDeterministicTxDigest(publicKey: Buffer, network: string, timestamp?: number): string {
  const hash = createHash('sha256')
    .update(publicKey)
    .update(network)
    .update('tx-digest')
    .update(String(timestamp ?? Date.now()))
    .digest('hex');
  return `0x${hash}`;
}

// ============================================================================
// Mock Service Implementation
// ============================================================================

// In-memory storage for registered keys (simulates on-chain state)
const mockRegisteredKeys = new Map<string, { objectId: string; network: string }>();

/**
 * Mock delay helper
 */
async function mockDelay(operation: 'register' | 'update'): Promise<void> {
  const delayKey = operation === 'register' ? 'registerDelayMs' : 'updateDelayMs';
  const delay = mockConfig[delayKey] ?? 2000; // Default 2 second delay
  if (delay > 0) {
    console.log(`[SUI TX MOCK] Sleeping ${delay}ms for ${operation}`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

/**
 * Check if mock should fail
 */
function checkMockFailure(operation: 'register' | 'update'): string | undefined {
  // Check forced failure
  const forcedKey = operation === 'register' ? 'forceRegisterFailure' : 'forceUpdateFailure';
  if (mockConfig[forcedKey]) {
    return mockConfig[forcedKey];
  }

  // Check probabilistic failure
  if (mockConfig.failureProbability && Math.random() < mockConfig.failureProbability) {
    return `Random mock failure (probability: ${mockConfig.failureProbability})`;
  }

  return undefined;
}

// ============================================================================
// SuiTransactionService Class
// ============================================================================

/**
 * Service for Sui blockchain transactions related to Seal key registration.
 *
 * In development/test, uses mock implementation with configurable delays.
 * In production, calls actual Sui RPC (to be implemented).
 */
export class SuiTransactionService {
  private readonly isMockMode: boolean;

  constructor() {
    // Use mock in non-production (development/test)
    // Environment is determined by /etc/walrus/system.conf, NOT NODE_ENV
    this.isMockMode = !isProduction();
    console.log(`[SUI TX SERVICE] Mock mode: ${this.isMockMode} (isProduction: ${isProduction()})`);
  }

  /**
   * Check if running in mock mode
   */
  isMock(): boolean {
    return this.isMockMode;
  }

  /**
   * Register a new KeyServer object on Sui blockchain.
   *
   * This method is IDEMPOTENT:
   * - If existingObjectId is provided, checks if it exists first
   * - If publicKey already has an associated object, returns that
   * - Only creates new object if neither exists
   *
   * @param params - Registration parameters
   * @returns Registration result with objectId and txDigest
   */
  async registerKey(params: RegisterKeyParams): Promise<RegisterKeyResult> {
    if (this.isMockMode) {
      return this.mockRegisterKey(params);
    }

    // PRODUCTION IMPLEMENTATION (TODO)
    // This will call actual Sui RPC
    //
    // 1. If existingObjectId provided, check if object exists on-chain
    // 2. Query on-chain for existing KeyServer with matching public key
    // 3. If found, return existing object (idempotency)
    // 4. Otherwise, build and execute create_and_transfer_v1 transaction
    //
    // const suiClient = new SuiClient({ url: getNetworkRpcUrl(params.network) });
    // const txb = new TransactionBlock();
    // txb.moveCall({
    //   target: `${SEAL_PACKAGE_ID[params.network]}::seal::create_and_transfer_v1`,
    //   arguments: [
    //     txb.pure(params.name),
    //     txb.pure(params.url),
    //     txb.pure(params.keyType),
    //     txb.pure(Array.from(params.publicKey)),
    //   ],
    // });
    // const result = await suiClient.signAndExecuteTransactionBlock({...});

    throw new Error('Production Sui integration not yet implemented');
  }

  /**
   * Update a KeyServer's package list on Sui blockchain.
   *
   * NOTE: The actual Seal contract may not require on-chain updates for package
   * changes - this depends on Mysten's implementation. Package authorization
   * might be handled off-chain by the Seal server.
   *
   * @param params - Update parameters
   * @returns Update result
   */
  async updateKey(params: UpdateKeyParams): Promise<RegisterKeyResult> {
    if (this.isMockMode) {
      return this.mockUpdateKey(params);
    }

    // PRODUCTION IMPLEMENTATION (TODO)
    // Check Seal contract for update mechanism
    // May be a no-op if packages are authorized off-chain

    throw new Error('Production Sui integration not yet implemented');
  }

  /**
   * Check if a KeyServer object exists on-chain
   *
   * @param objectId - The object ID to check (0x-prefixed)
   * @param network - Target network
   * @returns true if object exists
   */
  async checkObjectExists(objectId: string, network: 'mainnet' | 'testnet'): Promise<boolean> {
    if (this.isMockMode) {
      // Check mock registry
      const publicKeyHex = Array.from(mockRegisteredKeys.entries())
        .find(([_key, value]) => value.objectId === objectId && value.network === network);
      return publicKeyHex !== undefined;
    }

    // PRODUCTION: Call sui_getObject RPC
    throw new Error('Production Sui integration not yet implemented');
  }

  /**
   * Find an existing KeyServer by public key
   *
   * @param publicKey - The public key to search for
   * @param network - Target network
   * @returns Object ID if found, undefined otherwise
   */
  async findKeyServerByPublicKey(
    publicKey: Buffer,
    network: 'mainnet' | 'testnet'
  ): Promise<{ objectId: string; txDigest?: string } | undefined> {
    if (this.isMockMode) {
      const publicKeyHex = publicKey.toString('hex');
      const key = `${publicKeyHex}-${network}`;
      const existing = mockRegisteredKeys.get(key);
      if (existing) {
        return { objectId: existing.objectId };
      }
      return undefined;
    }

    // PRODUCTION: Query Sui for owned KeyServer objects matching public key
    // This requires an indexer or owned object query
    throw new Error('Production Sui integration not yet implemented');
  }

  // =========================================================================
  // Mock Implementation
  // =========================================================================

  private async mockRegisterKey(params: RegisterKeyParams): Promise<RegisterKeyResult> {
    // Apply configured delay
    await mockDelay('register');

    // Check for forced/random failure
    const failureMessage = checkMockFailure('register');
    if (failureMessage) {
      console.log(`[SUI TX MOCK] Forced failure: ${failureMessage}`);
      return {
        success: false,
        error: failureMessage,
      };
    }

    // Parameter validation (mimics production contract validation)
    // This catches bugs early in development
    const expectedKeyType = params.publicKey.length === 48 ? 0 : params.publicKey.length === 96 ? 1 : -1;
    if (expectedKeyType === -1) {
      return {
        success: false,
        error: `Invalid public key length: ${params.publicKey.length} bytes (expected 48 for G1 or 96 for G2)`,
      };
    }
    if (params.keyType !== expectedKeyType) {
      return {
        success: false,
        error: `Key type mismatch: keyType=${params.keyType} but public key is ${params.publicKey.length} bytes ` +
          `(expected keyType=${expectedKeyType} for ${expectedKeyType === 0 ? 'G1' : 'G2'})`,
      };
    }
    if (!params.name || params.name.length > 64) {
      return {
        success: false,
        error: `Invalid name: must be 1-64 characters (got ${params.name?.length ?? 0})`,
      };
    }
    if (!params.url || !params.url.startsWith('https://')) {
      return {
        success: false,
        error: `Invalid URL: must be HTTPS (got ${params.url})`,
      };
    }

    // Idempotency check 1: If we have an existing object ID, verify it
    if (params.existingObjectId) {
      const exists = await this.checkObjectExists(params.existingObjectId, params.network);
      if (exists) {
        console.log(`[SUI TX MOCK] Idempotency hit: existing object ${params.existingObjectId}`);
        return {
          success: true,
          objectId: params.existingObjectId,
          alreadyExists: true,
        };
      }
    }

    // Idempotency check 2: Look for existing object by public key
    const existingByPubKey = await this.findKeyServerByPublicKey(params.publicKey, params.network);
    if (existingByPubKey) {
      console.log(`[SUI TX MOCK] Idempotency hit: found by public key ${existingByPubKey.objectId}`);
      return {
        success: true,
        objectId: existingByPubKey.objectId,
        alreadyExists: true,
      };
    }

    // Generate deterministic IDs for reproducibility
    const objectId = generateDeterministicObjectId(params.publicKey, params.network);
    const txDigest = generateDeterministicTxDigest(params.publicKey, params.network);

    // Store in mock registry
    const publicKeyHex = params.publicKey.toString('hex');
    const key = `${publicKeyHex}-${params.network}`;
    mockRegisteredKeys.set(key, { objectId, network: params.network });

    console.log(`[SUI TX MOCK] Registered new KeyServer: ${objectId}`);
    return {
      success: true,
      objectId,
      txDigest,
      alreadyExists: false,
    };
  }

  private async mockUpdateKey(params: UpdateKeyParams): Promise<RegisterKeyResult> {
    // Apply configured delay
    await mockDelay('update');

    // Check for forced/random failure
    const failureMessage = checkMockFailure('update');
    if (failureMessage) {
      console.log(`[SUI TX MOCK] Forced failure: ${failureMessage}`);
      return {
        success: false,
        error: failureMessage,
      };
    }

    // Verify object exists
    const exists = await this.checkObjectExists(params.objectId, params.network);
    if (!exists) {
      return {
        success: false,
        error: `KeyServer object not found: ${params.objectId}`,
      };
    }

    // Generate deterministic tx digest for the update
    const hash = createHash('sha256')
      .update(params.objectId)
      .update(params.packages.join(','))
      .update('update-tx')
      .digest('hex');
    const txDigest = `0x${hash}`;

    console.log(`[SUI TX MOCK] Updated KeyServer ${params.objectId} with ${params.packages.length} packages`);
    return {
      success: true,
      objectId: params.objectId,
      txDigest,
    };
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let serviceInstance: SuiTransactionService | null = null;

/**
 * Get the Sui transaction service instance (singleton)
 */
export function getSuiTransactionService(): SuiTransactionService {
  if (!serviceInstance) {
    serviceInstance = new SuiTransactionService();
  }
  return serviceInstance;
}

/**
 * Reset the service instance (for testing)
 */
export function resetSuiTransactionService(): void {
  serviceInstance = null;
  mockRegisteredKeys.clear();
  clearSuiTxMockConfig();
  console.log('[SUI TX MOCK] Service reset');
}