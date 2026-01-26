/**
 * Test data management
 * Provides utilities to reset test data for reliable E2E testing
 *
 * IMPORTANT: Only active in test/development environments
 */

import { randomInt } from 'node:crypto';
import { db } from '@suiftly/database';
import {
  customers, serviceInstances, serviceCancellationHistory, ledgerEntries, apiKeys, sealKeys, sealPackages,
  refreshTokens, billingRecords, escrowTransactions, usageRecords,
  haproxyRawLogs, userActivityLogs, mockSuiTransactions,
  invoicePayments, customerCredits, billingIdempotency, adminNotifications
} from '@suiftly/database/schema';
import { eq } from 'drizzle-orm';
import { decryptSecret } from './encryption';
import { suiMockConfig } from '@suiftly/database/sui-mock';
import { dbClock } from '@suiftly/shared/db-clock';

// =============================================================================
// Mock Test Customers
// =============================================================================
// Two test customers with different address styles:
// - MOCK_WALLET_ADDRESS_0: Obvious test pattern (0xaaa...) - used by unit tests
// - MOCK_WALLET_ADDRESS_1: Realistic-looking addresses - for demos/screenshots

// Test customer 0: Obvious test pattern (legacy, heavily used in tests)
export const MOCK_WALLET_ADDRESS_0 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const MOCK_OBJECT_ID_0 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const MOCK_PACKAGE_ID_0 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// Test customer 1: Realistic-looking addresses (for demos/screenshots)
// These look like real Sui addresses but are fixed for reproducibility
export const MOCK_WALLET_ADDRESS_1 = '0x7a3f8c2e5d91b6a4f0e82c3d9b7a5f1e6c8d2a4b9e3f7c1d5a8b2e6f0c4d8a2b';
export const MOCK_OBJECT_ID_1 = '0x4e8b2c6a9f1d5e3b7a0c4f8e2d6b9a3c5f1e7d0b8a4c2e6f9d3b5a1c7e0f4d8a';
export const MOCK_PACKAGE_IDS_1 = [
  '0x9c3a7e1f5b2d8a6c0e4f9b3d7a1c5e8f2b6d0a4c8e2f6b9d3a7c1e5f0b4d8a2c',
  '0x2f8e4b6d1a9c5e3f7b0d4a8c2e6f1b5d9a3c7e0f4b8d2a6c1e5f9b3d7a0c4e8f',
];

// Legacy alias (for backward compatibility)
const MOCK_WALLET_ADDRESS = MOCK_WALLET_ADDRESS_0;

interface TestDataResetOptions {
  walletAddress?: string;
  balanceUsdCents?: number;
  spendingLimitUsdCents?: number;
  clearEscrowAccount?: boolean;
}

/**
 * Reset a customer to production defaults by deleting services/keys and recreating customer
 *
 * This ensures tests validate production behavior, not test-specific code paths.
 *
 * Process:
 * 1. Delete all services, keys, and related data
 * 2. Recreate customer with specified balance/spending limit
 *
 * Options:
 * - balanceUsdCents: Set customer balance (default: 0)
 * - spendingLimitUsdCents: Set spending limit (default: 25000 = $250)
 * - clearEscrowAccount: Remove escrow contract ID (default: false)
 */
export async function resetCustomerTestData(options: TestDataResetOptions = {}) {
  const walletAddress = options.walletAddress || MOCK_WALLET_ADDRESS;
  const balanceUsdCents = options.balanceUsdCents ?? 0;
  const spendingLimitUsdCents = options.spendingLimitUsdCents ?? 25000; // $250 default
  const clearEscrowAccount = options.clearEscrowAccount ?? false;

  // Find customer
  let customer = await db.query.customers.findFirst({
    where: eq(customers.walletAddress, walletAddress),
  });

  // Create customer if doesn't exist (for first-time test runs)
  if (!customer) {
    console.log(`[TEST DATA] Customer not found, creating with specified balance: ${walletAddress}`);

    // Generate random customer ID with collision retry (matching auth.ts pattern)
    const MAX_RETRIES = 10;
    let newCustomer: typeof customers.$inferSelect | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES && !newCustomer; attempt++) {
      const customerId = randomInt(1, 2147483648);

      try {
        const [inserted] = await db.insert(customers).values({
          customerId,
          walletAddress,
          status: 'active',
          currentBalanceUsdCents: balanceUsdCents,
          spendingLimitUsdCents: spendingLimitUsdCents,
          currentPeriodChargedUsdCents: 0,
          currentPeriodStart: (() => {
            const now = dbClock.now();
            return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().split('T')[0];
          })(),
        }).returning();
        newCustomer = inserted;
      } catch (error: any) {
        if (error.code === '23505' && error.constraint === 'customers_pkey') {
          continue; // Collision - retry with new ID
        }
        throw error; // Other error - rethrow
      }
    }

    if (!newCustomer) {
      throw new Error('Failed to create customer after max retries (ID collision)');
    }

    console.log(`[TEST DATA] Created customer ${newCustomer.customerId} with $${(balanceUsdCents / 100).toFixed(2)} balance`);
    return {
      success: true,
      message: `Customer created with $${(balanceUsdCents / 100).toFixed(2)} balance`,
      customerId: newCustomer.customerId,
    };
  }

  const customerId = customer.customerId;

  // Delete all related data and update customer in transaction
  // Use retry logic to handle deadlocks (PostgreSQL error code 40P01)
  const MAX_RETRIES = 5;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await db.transaction(async (tx) => {
        // 1. Delete service cancellation history first (references customerId)
        await tx
          .delete(serviceCancellationHistory)
          .where(eq(serviceCancellationHistory.customerId, customerId));

        // 2. Delete service instances
        const deletedServices = await tx
          .delete(serviceInstances)
          .where(eq(serviceInstances.customerId, customerId))
          .returning();

        // 3. Delete API keys
        const deletedApiKeys = await tx
          .delete(apiKeys)
          .where(eq(apiKeys.customerId, customerId))
          .returning();

        // 4. Delete Seal packages first (FK constraint: seal_packages -> seal_keys)
        // Get seal key IDs for this customer, then delete their packages
        const customerSealKeys = await tx
          .select({ sealKeyId: sealKeys.sealKeyId })
          .from(sealKeys)
          .where(eq(sealKeys.customerId, customerId));

        let deletedPackagesCount = 0;
        for (const key of customerSealKeys) {
          const deleted = await tx
            .delete(sealPackages)
            .where(eq(sealPackages.sealKeyId, key.sealKeyId))
            .returning();
          deletedPackagesCount += deleted.length;
        }

        // 5. Delete Seal keys (now safe - packages deleted first)
        const deletedSealKeys = await tx
          .delete(sealKeys)
          .where(eq(sealKeys.customerId, customerId))
          .returning();

        // 6. Delete all other related data (in correct order for foreign keys)
        // New billing tables (Phase 1A/2) - delete before billing_records
        await tx.delete(adminNotifications).where(eq(adminNotifications.customerId, String(customerId)));
        await tx.delete(billingIdempotency); // No customer_id column, delete all for simplicity
        await tx.delete(invoicePayments); // References billing_records, so delete first
        await tx.delete(customerCredits).where(eq(customerCredits.customerId, customerId));

        // Original tables
        await tx.delete(ledgerEntries).where(eq(ledgerEntries.customerId, customerId));
        await tx.delete(refreshTokens).where(eq(refreshTokens.customerId, customerId));
        await tx.delete(billingRecords).where(eq(billingRecords.customerId, customerId)); // Now safe to delete
        await tx.delete(escrowTransactions).where(eq(escrowTransactions.customerId, customerId));
        await tx.delete(usageRecords).where(eq(usageRecords.customerId, customerId));
        await tx.delete(haproxyRawLogs).where(eq(haproxyRawLogs.customerId, customerId));
        await tx.delete(userActivityLogs).where(eq(userActivityLogs.customerId, customerId));
        await tx.delete(mockSuiTransactions).where(eq(mockSuiTransactions.customerId, customerId));

        // 7. Clear Sui mock config (reset delays and failure injections)
        suiMockConfig.clearConfig();

        // 8. Reset customer to clean state with specified balance
        // (Keep customer to preserve wallet address association)
        await tx.update(customers)
          .set({
            currentBalanceUsdCents: balanceUsdCents,
            spendingLimitUsdCents: spendingLimitUsdCents,
            currentPeriodChargedUsdCents: 0,
            ...(clearEscrowAccount ? { escrowContractId: null } : {}),
          })
          .where(eq(customers.customerId, customerId));

        console.log(`[TEST DATA] Reset customer ${customerId}:`);
        console.log(`  - Deleted ${deletedServices.length} service instances`);
        console.log(`  - Deleted ${deletedApiKeys.length} API keys`);
        console.log(`  - Deleted ${deletedPackagesCount} Seal packages`);
        console.log(`  - Deleted ${deletedSealKeys.length} Seal keys`);
        console.log(`  - Deleted all related data (ledger, tokens, billing, logs)`);
        console.log(`  - Set balance to $${(balanceUsdCents / 100).toFixed(2)}`);
        console.log(`  - Set spending limit to $${(spendingLimitUsdCents / 100).toFixed(2)}`);
      });

      // Success - exit retry loop
      lastError = null;
      break;
    } catch (error: any) {
      lastError = error;

      // Check if this is a deadlock error (PostgreSQL error code 40P01)
      const isDeadlock = error?.cause?.code === '40P01' ||
                         error?.message?.includes('deadlock detected');

      if (isDeadlock && attempt < MAX_RETRIES) {
        // Exponential backoff with jitter: 50-150ms, 100-300ms, 200-600ms, 400-1200ms
        const baseDelay = 50 * Math.pow(2, attempt - 1);
        const jitter = Math.random() * baseDelay;
        const delay = Math.floor(baseDelay + jitter);
        console.log(`[TEST DATA] Deadlock detected for customer ${customerId}, retry ${attempt}/${MAX_RETRIES} after ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // Not a deadlock or max retries exceeded - rethrow
      throw error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return {
    success: true,
    message: `Customer reset with $${(balanceUsdCents / 100).toFixed(2)} balance`,
    customerId: customerId,
  };
}

/**
 * Get current customer state (for debugging tests)
 */
export async function getCustomerTestData(walletAddress: string = MOCK_WALLET_ADDRESS) {
  const customer = await db.query.customers.findFirst({
    where: eq(customers.walletAddress, walletAddress),
  });

  if (!customer) {
    return {
      found: false,
      message: `Customer not found with wallet: ${walletAddress}`,
    };
  }

  const services = await db.query.serviceInstances.findMany({
    where: eq(serviceInstances.customerId, customer.customerId),
  });

  const keys = await db.query.apiKeys.findMany({
    where: eq(apiKeys.customerId, customer.customerId),
  });

  const sealKeysData = await db.query.sealKeys.findMany({
    where: eq(sealKeys.customerId, customer.customerId),
  });

  const credits = await db.query.customerCredits.findMany({
    where: eq(customerCredits.customerId, customer.customerId),
  });

  return {
    found: true,
    customer: {
      customerId: customer.customerId,
      walletAddress: customer.walletAddress,
      balanceUsd: (customer.currentBalanceUsdCents ?? 0) / 100,
      spendingLimitUsd: (customer.spendingLimitUsdCents ?? 0) / 100,
      currentPeriodChargedUsd: (customer.currentPeriodChargedUsdCents ?? 0) / 100,
    },
    services: services.map(s => ({
      serviceType: s.serviceType,
      tier: s.tier,
      state: s.state,
      isUserEnabled: s.isUserEnabled,
      subPendingInvoiceId: s.subPendingInvoiceId,
      subscriptionChargePending: s.subPendingInvoiceId !== null, // Convenience boolean for tests
    })),
    apiKeysCount: keys.length,
    sealKeysCount: sealKeysData.length,
    credits: credits.map(c => ({
      creditId: c.creditId,
      originalAmountUsdCents: Number(c.originalAmountUsdCents),
      remainingAmountUsdCents: Number(c.remainingAmountUsdCents),
      reason: c.reason,
      description: c.description,
      expiresAt: c.expiresAt?.toISOString() || null,
    })),
  };
}

/**
 * Get all API keys for current mock wallet user
 */
export async function getApiKeysTestData(walletAddress: string = MOCK_WALLET_ADDRESS) {
  const customer = await db.query.customers.findFirst({
    where: eq(customers.walletAddress, walletAddress),
  });

  if (!customer) {
    return {
      found: false,
      message: `Customer not found with wallet: ${walletAddress}`,
      apiKeys: [],
    };
  }

  const keys = await db.query.apiKeys.findMany({
    where: eq(apiKeys.customerId, customer.customerId),
  });

  return {
    found: true,
    customerId: customer.customerId,
    apiKeys: keys.map(k => ({
      apiKeyId: decryptSecret(k.apiKeyId), // Decrypt for tests (they expect plain text)
      apiKeyFp: k.apiKeyFp, // Include fingerprint for reference
      serviceType: k.serviceType,
      metadata: k.metadata,
      isUserEnabled: k.isUserEnabled,
      createdAt: k.createdAt,
      revokedAt: k.revokedAt,
    })),
  };
}

/**
 * Get all seal keys for current mock wallet user
 */
export async function getSealKeysTestData(walletAddress: string = MOCK_WALLET_ADDRESS) {
  const customer = await db.query.customers.findFirst({
    where: eq(customers.walletAddress, walletAddress),
  });

  if (!customer) {
    return {
      found: false,
      message: `Customer not found with wallet: ${walletAddress}`,
      sealKeys: [],
    };
  }

  const keys = await db.query.sealKeys.findMany({
    where: eq(sealKeys.customerId, customer.customerId),
    with: {
      packages: true,
    },
  });

  return {
    found: true,
    customerId: customer.customerId,
    sealKeys: keys.map(k => ({
      sealKeyId: k.sealKeyId,
      publicKey: k.publicKey,
      isUserEnabled: k.isUserEnabled,
      createdAt: k.createdAt,
      packages: k.packages,
    })),
  };
}

interface SetupSealOptions {
  walletAddress?: string;
  /** Object ID for the seal key (hex string without 0x, 64 chars) */
  objectIdHex?: string;
  /** Package addresses (hex strings without 0x, 64 chars each) */
  packageAddressesHex?: string[];
}

/**
 * Setup seal service with cpEnabled=true (for control plane sync tests)
 *
 * Creates the minimum setup needed to trigger vault generation:
 * 1. Subscribe to seal service (creates service instance)
 * 2. Enable the service (isUserEnabled=true)
 * 3. Create a seal key
 * 4. Add a package to the seal key (triggers cpEnabled=true)
 *
 * This is a common setup for many tests that need to verify vault sync.
 *
 * @param options.walletAddress - Wallet address (default: MOCK_WALLET_ADDRESS_0)
 * @param options.objectIdHex - Object ID hex (default: 'a' * 64)
 * @param options.packageAddressesHex - Package addresses (default: ['b' * 64])
 */
export async function setupSealWithCpEnabled(options: SetupSealOptions | string = {}) {
  // Support legacy string parameter for backward compatibility
  const opts: SetupSealOptions = typeof options === 'string'
    ? { walletAddress: options }
    : options;

  const walletAddress = opts.walletAddress || MOCK_WALLET_ADDRESS;
  const objectIdHex = opts.objectIdHex || 'a'.repeat(64);
  const packageAddressesHex = opts.packageAddressesHex || ['b'.repeat(64)];
  const customer = await db.query.customers.findFirst({
    where: eq(customers.walletAddress, walletAddress),
  });

  if (!customer) {
    return {
      success: false,
      error: `Customer not found with wallet: ${walletAddress}`,
    };
  }

  const customerId = customer.customerId;

  // Step 1: Create or update service instance (subscribe + enable)
  let service = await db.query.serviceInstances.findFirst({
    where: eq(serviceInstances.customerId, customerId),
  });

  if (!service) {
    // Create new service instance (simulating subscription)
    const [newService] = await db.insert(serviceInstances).values({
      customerId,
      serviceType: 'seal',
      state: 'enabled',
      tier: 'starter',
      isUserEnabled: true,
      paidOnce: true, // Skip payment requirement for tests
      enabledAt: dbClock.now(),
    }).returning();
    service = newService;
    console.log(`[TEST DATA] Created seal service instance for customer ${customerId}`);
  } else if (!service.isUserEnabled) {
    // Enable existing service
    await db.update(serviceInstances)
      .set({ isUserEnabled: true, enabledAt: dbClock.now() })
      .where(eq(serviceInstances.customerId, customerId));
    console.log(`[TEST DATA] Enabled existing seal service for customer ${customerId}`);
  }

  // Step 2: Create seal key
  const existingSealKeys = await db.query.sealKeys.findMany({
    where: eq(sealKeys.customerId, customerId),
  });

  // Need the service instance ID for the seal key
  const currentService = await db.query.serviceInstances.findFirst({
    where: eq(serviceInstances.customerId, customerId),
  });
  const instanceId = currentService?.instanceId;

  let sealKeyId: number;
  if (existingSealKeys.length === 0) {
    // Generate a test public key (48 bytes for BLS12-381 G1 compressed point)
    // Use Buffer.from with hex encoding (96 hex chars = 48 bytes)
    const testPublicKey = Buffer.from('0'.repeat(96), 'hex');

    // Use provided object ID or default - simulates completed on-chain registration
    // This allows the key to appear in SMK vault (keyserver config)
    const testObjectId = Buffer.from(objectIdHex, 'hex');

    const [newSealKey] = await db.insert(sealKeys).values({
      customerId,
      instanceId: instanceId ?? null,
      publicKey: testPublicKey,
      objectId: testObjectId, // Set mock objectId to simulate completed registration
      derivationIndex: 0, // Required for derived keys
      registrationStatus: 'registered', // Mark as registered
      isUserEnabled: true,
    }).returning();
    sealKeyId = newSealKey.sealKeyId;
    console.log(`[TEST DATA] Created seal key ${sealKeyId} for customer ${customerId} (objectId: 0x${objectIdHex.slice(0, 8)}...)`);
  } else {
    sealKeyId = existingSealKeys[0].sealKeyId;
    console.log(`[TEST DATA] Using existing seal key ${sealKeyId}`);
  }

  // Step 3: Create packages for the seal key
  const existingPackages = await db.query.sealPackages.findMany({
    where: eq(sealPackages.sealKeyId, sealKeyId),
  });

  if (existingPackages.length === 0) {
    // Create packages with provided addresses
    for (let i = 0; i < packageAddressesHex.length; i++) {
      const packageAddress = Buffer.from(packageAddressesHex[i], 'hex');
      await db.insert(sealPackages).values({
        sealKeyId,
        packageAddress,
        name: packageAddressesHex.length > 1 ? `Package ${i + 1}` : 'Test Package',
        isUserEnabled: true,
      });
    }
    console.log(`[TEST DATA] Created ${packageAddressesHex.length} package(s) for seal key ${sealKeyId}`);
  } else {
    console.log(`[TEST DATA] Using existing ${existingPackages.length} package(s) for seal key ${sealKeyId}`);
  }

  // Step 4: Set cpEnabled=true (this is what triggers vault generation)
  // This should be set automatically by the trigger/logic, but we set it explicitly for tests
  await db.update(serviceInstances)
    .set({ cpEnabled: true })
    .where(eq(serviceInstances.customerId, customerId));
  console.log(`[TEST DATA] Set cpEnabled=true for customer ${customerId}`);

  // Get final state
  const finalService = await db.query.serviceInstances.findFirst({
    where: eq(serviceInstances.customerId, customerId),
  });

  return {
    success: true,
    customerId,
    sealKeyId,
    cpEnabled: finalService?.cpEnabled ?? false,
    smaConfigChangeVaultSeq: finalService?.smaConfigChangeVaultSeq ?? 0,
  };
}

/**
 * Create an API key for testing (returns plain key for E2E tests)
 *
 * This creates a real API key using the production code path,
 * which is needed for testing HAProxy authentication.
 *
 * The plain key is returned so tests can use it in X-API-Key headers.
 * Note: This key uses the test SECRET_KEY for encryption.
 */
export async function createApiKeyForTesting(walletAddress: string = MOCK_WALLET_ADDRESS) {
  const customer = await db.query.customers.findFirst({
    where: eq(customers.walletAddress, walletAddress),
  });

  if (!customer) {
    return {
      success: false,
      error: `Customer not found with wallet: ${walletAddress}`,
    };
  }

  const customerId = customer.customerId;

  // Import API key generation module
  const { storeApiKey } = await import('./api-keys');

  try {
    const result = await storeApiKey({
      customerId,
      serviceType: 'seal',
      sealType: {
        network: 'mainnet',
        access: 'permission',
        source: 'derived',
      },
      procGroup: 1,
      metadata: {
        name: 'Test API Key',
        createdBy: 'test-data',
      },
    });

    console.log(`[TEST DATA] Created API key for customer ${customerId}`);

    return {
      success: true,
      customerId,
      apiKeyFp: result.record.apiKeyFp,
      plainKey: result.plainKey, // Return plain key for tests
    };
  } catch (error: any) {
    console.error(`[TEST DATA] Failed to create API key:`, error);
    return {
      success: false,
      error: error.message || 'Failed to create API key',
    };
  }
}

/**
 * Get service instance by type for current mock wallet user
 */
export async function getServiceInstanceTestData(
  serviceType: string,
  walletAddress: string = MOCK_WALLET_ADDRESS
) {
  const customer = await db.query.customers.findFirst({
    where: eq(customers.walletAddress, walletAddress),
  });

  if (!customer) {
    return {
      found: false,
      message: `Customer not found with wallet: ${walletAddress}`,
    };
  }

  const service = await db.query.serviceInstances.findFirst({
    where: eq(serviceInstances.customerId, customer.customerId),
  });

  if (!service) {
    return {
      found: false,
      message: `Service not found for customer ${customer.customerId}`,
    };
  }

  return {
    found: true,
    ...service,
    subscriptionChargePending: service.subPendingInvoiceId !== null, // Convenience boolean for tests
  };
}

// =============================================================================
// Convenience Functions for Mock Customers
// =============================================================================

/**
 * Setup mock customer 1 with realistic-looking addresses (for demos/screenshots)
 *
 * Uses MOCK_WALLET_ADDRESS_1, MOCK_OBJECT_ID_1, and MOCK_PACKAGE_IDS_1
 * which look like real Sui addresses but are fixed for reproducibility.
 *
 * @param balanceUsdCents - Initial balance (default: 10000 = $100)
 */
export async function setupMockCustomer1(balanceUsdCents: number = 10000) {
  // First reset/create the customer
  await resetCustomerTestData({
    walletAddress: MOCK_WALLET_ADDRESS_1,
    balanceUsdCents,
  });

  // Then setup seal service with realistic addresses
  // Strip 0x prefix from addresses for the hex parameters
  const objectIdHex = MOCK_OBJECT_ID_1.replace('0x', '');
  const packageAddressesHex = MOCK_PACKAGE_IDS_1.map(p => p.replace('0x', ''));

  return setupSealWithCpEnabled({
    walletAddress: MOCK_WALLET_ADDRESS_1,
    objectIdHex,
    packageAddressesHex,
  });
}

/**
 * Setup mock customer 0 with test pattern addresses (legacy helper)
 *
 * Uses MOCK_WALLET_ADDRESS_0 (0xaaa...) with simple test addresses.
 * This is the default behavior of setupSealWithCpEnabled().
 *
 * @param balanceUsdCents - Initial balance (default: 10000 = $100)
 */
export async function setupMockCustomer0(balanceUsdCents: number = 10000) {
  // First reset/create the customer
  await resetCustomerTestData({
    walletAddress: MOCK_WALLET_ADDRESS_0,
    balanceUsdCents,
  });

  // Then setup seal service with default test addresses
  return setupSealWithCpEnabled({
    walletAddress: MOCK_WALLET_ADDRESS_0,
  });
}
