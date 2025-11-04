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
const DEFAULT_MONTHLY_LIMIT_USD_CENTS = 50000; // $500

interface TestDataResetOptions {
  walletAddress?: string;
  balanceUsdCents?: number;
  monthlyLimitUsdCents?: number;
}

/**
 * Reset a customer to default test state
 * - Deletes all service instances
 * - Deletes all API keys
 * - Deletes all Seal keys
 * - Resets balance and limits
 * - Clears monthly charges
 */
export async function resetCustomerTestData(options: TestDataResetOptions = {}) {
  const walletAddress = options.walletAddress || MOCK_WALLET_ADDRESS;
  const balanceUsdCents = options.balanceUsdCents ?? DEFAULT_BALANCE_USD_CENTS;
  const monthlyLimitUsdCents = options.monthlyLimitUsdCents ?? DEFAULT_MONTHLY_LIMIT_USD_CENTS;

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

    // 4. Delete ledger entries (optional - keep for audit trail)
    // await tx.delete(ledgerEntries).where(eq(ledgerEntries.customerId, customerId));

    // 5. Reset customer balance and limits
    await tx
      .update(customers)
      .set({
        currentBalanceUsdCents: balanceUsdCents,
        maxMonthlyUsdCents: monthlyLimitUsdCents,
        currentMonthChargedUsdCents: 0,
        currentMonthStart: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(customers.customerId, customerId));

    console.log(`[TEST DATA] Reset customer ${customerId}:`);
    console.log(`  - Deleted ${deletedServices.length} service instances`);
    console.log(`  - Deleted ${deletedApiKeys.length} API keys`);
    console.log(`  - Deleted ${deletedSealKeys.length} Seal keys`);
    console.log(`  - Reset balance to $${balanceUsdCents / 100}`);
    console.log(`  - Reset monthly limit to $${monthlyLimitUsdCents / 100}`);
  });

  return {
    success: true,
    message: 'Customer test data reset successfully',
    customerId,
    balanceUsd: balanceUsdCents / 100,
    monthlyLimitUsd: monthlyLimitUsdCents / 100,
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
      monthlyLimitUsd: (customer.maxMonthlyUsdCents ?? 0) / 100,
      currentMonthChargedUsd: (customer.currentMonthChargedUsdCents ?? 0) / 100,
    },
    services: services.map(s => ({
      serviceType: s.serviceType,
      tier: s.tier,
      state: s.state,
      isEnabled: s.isEnabled,
    })),
    apiKeysCount: keys.length,
    sealKeysCount: sealKeysData.length,
  };
}
