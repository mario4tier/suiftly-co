/**
 * Test data management
 * Provides utilities to reset test data for reliable E2E testing
 *
 * IMPORTANT: Only active in test/development environments
 */

import { randomInt } from 'node:crypto';
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

    // 7. Reset customer to clean state with specified balance
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
    console.log(`  - Deleted ${deletedSealKeys.length} Seal keys`);
    console.log(`  - Deleted all related data (ledger, tokens, billing, logs)`);
    console.log(`  - Set balance to $${(balanceUsdCents / 100).toFixed(2)}`);
    console.log(`  - Set spending limit to $${(spendingLimitUsdCents / 100).toFixed(2)}`);
  });

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
