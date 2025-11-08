/**
 * Test data management
 * Provides utilities to reset test data for reliable E2E testing
 *
 * IMPORTANT: Only active in test/development environments
 */

import { db } from '@suiftly/database';
import { customers, serviceInstances, ledgerEntries, apiKeys, sealKeys } from '@suiftly/database/schema';
import { eq } from 'drizzle-orm';

const MOCK_WALLET_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DEFAULT_BALANCE_USD_CENTS = 100000; // $1000
const DEFAULT_SPENDING_LIMIT_USD_CENTS = 25000; // $250

interface TestDataResetOptions {
  walletAddress?: string;
  balanceUsdCents?: number;
  spendingLimitUsdCents?: number;
  clearEscrowAccount?: boolean; // If true, removes escrowContractId (for testing "no account" state)
}

/**
 * Reset a customer to default test state
 * - Deletes all service instances
 * - Deletes all API keys
 * - Deletes all Seal keys
 * - Resets balance and limits
 * - Clears monthly charges
 * - Optionally clears escrow account (for testing "no account exists" scenarios)
 */
export async function resetCustomerTestData(options: TestDataResetOptions = {}) {
  const walletAddress = options.walletAddress || MOCK_WALLET_ADDRESS;
  const balanceUsdCents = options.balanceUsdCents ?? DEFAULT_BALANCE_USD_CENTS;
  const spendingLimitUsdCents = options.spendingLimitUsdCents ?? DEFAULT_SPENDING_LIMIT_USD_CENTS;
  const clearEscrowAccount = options.clearEscrowAccount ?? false;

  // Find customer
  const customer = await db.query.customers.findFirst({
    where: eq(customers.walletAddress, walletAddress),
  });

  if (!customer) {
    console.log(`[TEST DATA] Customer not found: ${walletAddress}`);
    return {
      success: false,
      message: `Customer not found with wallet: ${walletAddress}`,
    };
  }

  const customerId = customer.customerId;

  // Delete all related data in transaction
  await db.transaction(async (tx) => {
    // 1. Delete service instances
    const deletedServices = await tx
      .delete(serviceInstances)
      .where(eq(serviceInstances.customerId, customerId))
      .returning();

    // 2. Delete API keys
    const deletedApiKeys = await tx
      .delete(apiKeys)
      .where(eq(apiKeys.customerId, customerId))
      .returning();

    // 3. Delete Seal keys
    const deletedSealKeys = await tx
      .delete(sealKeys)
      .where(eq(sealKeys.customerId, customerId))
      .returning();

    // 4. Delete ledger entries (for clean test state)
    await tx.delete(ledgerEntries).where(eq(ledgerEntries.customerId, customerId));

    // 5. Reset customer balance and limits
    // NOTE: By default we do NOT clear escrowContractId - once created, it persists (like blockchain)
    // However, tests can request to clear it via clearEscrowAccount flag
    const updateData: any = {
      currentBalanceUsdCents: balanceUsdCents,
      maxMonthlyUsdCents: spendingLimitUsdCents,
      currentMonthChargedUsdCents: 0,
      currentMonthStart: new Date(),
      updatedAt: new Date(),
    };

    // Conditionally clear escrowContractId (test-only for "no account" scenarios)
    if (clearEscrowAccount) {
      updateData.escrowContractId = null;
    }

    await tx
      .update(customers)
      .set(updateData)
      .where(eq(customers.customerId, customerId));

    console.log(`[TEST DATA] Reset customer ${customerId}:`);
    console.log(`  - Deleted ${deletedServices.length} service instances`);
    console.log(`  - Deleted ${deletedApiKeys.length} API keys`);
    console.log(`  - Deleted ${deletedSealKeys.length} Seal keys`);
    console.log(`  - Reset balance to $${balanceUsdCents / 100}`);
    console.log(`  - Reset spending limit to $${spendingLimitUsdCents / 100}`);
  });

  return {
    success: true,
    message: 'Customer test data reset successfully',
    customerId,
    balanceUsd: balanceUsdCents / 100,
    spendingLimitUsd: spendingLimitUsdCents / 100,
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

  return {
    found: true,
    customer: {
      customerId: customer.customerId,
      walletAddress: customer.walletAddress,
      balanceUsd: (customer.currentBalanceUsdCents ?? 0) / 100,
      spendingLimitUsd: (customer.maxMonthlyUsdCents ?? 0) / 100,
      currentPeriodChargedUsd: (customer.currentMonthChargedUsdCents ?? 0) / 100,
    },
    services: services.map(s => ({
      serviceType: s.serviceType,
      tier: s.tier,
      state: s.state,
      isEnabled: s.isEnabled,
      subscriptionChargePending: s.subscriptionChargePending,
    })),
    apiKeysCount: keys.length,
    sealKeysCount: sealKeysData.length,
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
      apiKeyId: k.apiKeyId,
      serviceType: k.serviceType,
      metadata: k.metadata,
      isActive: k.isActive,
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
      isActive: k.isActive,
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
  };
}
