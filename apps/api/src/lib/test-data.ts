/**
 * Test data management
 * Provides utilities to reset test data for reliable E2E testing
 *
 * IMPORTANT: Only active in test/development environments
 */

import { db } from '@suiftly/database';
import {
  customers, serviceInstances, serviceCancellationHistory, ledgerEntries, apiKeys, sealKeys,
  refreshTokens, billingRecords, escrowTransactions, usageRecords,
  haproxyRawLogs, userActivityLogs, mockSuiTransactions,
  invoicePayments, customerCredits, billingIdempotency, adminNotifications
} from '@suiftly/database/schema';
import { eq } from 'drizzle-orm';
import { decryptSecret } from './encryption';
import { suiMockConfig } from '@suiftly/database/sui-mock';
import { dbClock } from '@suiftly/shared/db-clock';

const MOCK_WALLET_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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
  const customer = await db.query.customers.findFirst({
    where: eq(customers.walletAddress, walletAddress),
  });

  if (!customer) {
    console.log(`[TEST DATA] Customer not found (will be created on next auth): ${walletAddress}`);
    return {
      success: true,
      message: 'Customer does not exist - will be created with production defaults on next auth',
    };
  }

  const customerId = customer.customerId;

  // Delete all related data and update customer in transaction
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

    // 4. Delete Seal keys
    const deletedSealKeys = await tx
      .delete(sealKeys)
      .where(eq(sealKeys.customerId, customerId))
      .returning();

    // 5. Delete all other related data (in correct order for foreign keys)
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

    // 6. Clear Sui mock config (reset delays and failure injections)
    suiMockConfig.clearConfig();

    // 7. DELETE the customer record entirely
    // This ensures a fresh customer ID is generated on next auth
    // (fixes issues where old customer IDs might be invalid/negative)
    await tx.delete(customers).where(eq(customers.customerId, customerId));

    console.log(`[TEST DATA] Deleted customer ${customerId}:`);
    console.log(`  - Deleted ${deletedServices.length} service instances`);
    console.log(`  - Deleted ${deletedApiKeys.length} API keys`);
    console.log(`  - Deleted ${deletedSealKeys.length} Seal keys`);
    console.log(`  - Deleted all related data (ledger, tokens, billing, logs)`);
    console.log(`  - Customer will be recreated with fresh ID on next auth`);
  });

  return {
    success: true,
    message: 'Customer deleted - will be recreated on next auth',
    deletedCustomerId: customerId,
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

/**
 * Clear vault files via sudob
 *
 * Calls sudob to delete vault files from both tx (GM) and rx (LM) directories.
 * Order: tx first (stops sync-files propagation), then rx.
 *
 * @param vaultTypes - Array of vault type codes to clear (default: ['sma'])
 * @param sudodHost - Host of the sudob service (default: http://localhost:22612)
 */
export async function clearVaultFiles(
  vaultTypes: string[] = ['sma'],
  sudodHost: string = 'http://localhost:22612'
): Promise<{ success: boolean; deleted: string[]; errors: string[] }> {
  const deleted: string[] = [];
  const errors: string[] = [];

  for (const vaultType of vaultTypes) {
    try {
      const response = await fetch(`${sudodHost}/api/vault/clear`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vaultType, dir: 'both' }),
      });

      if (response.ok) {
        const result = await response.json() as { deletedFiles?: string[] };
        if (result.deletedFiles) {
          deleted.push(...result.deletedFiles);
        }
        console.log(`[VAULT CLEAR] ${vaultType}: ${result.deletedFiles?.length ?? 0} files deleted`);
      } else {
        const error = await response.text();
        errors.push(`${vaultType}: ${error}`);
        console.error(`[VAULT CLEAR] ${vaultType}: HTTP ${response.status} - ${error}`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      errors.push(`${vaultType}: ${errorMsg}`);
      console.error(`[VAULT CLEAR] ${vaultType}: ${errorMsg}`);
    }
  }

  return {
    success: errors.length === 0,
    deleted,
    errors,
  };
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
