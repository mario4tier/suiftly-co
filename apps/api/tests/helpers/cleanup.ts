/**
 * Shared test cleanup helpers
 *
 * Handles foreign key constraint-aware deletion of test data.
 * Order is critical: delete child tables before parent tables.
 */

import { db } from '@suiftly/database';
import {
  customers,
  mockSuiTransactions,
  mockTrackingObjects,
  usageRecords,
  escrowTransactions,
  ledgerEntries,
  billingRecords,
  customerCredits,
  invoicePayments,
  sealKeys,
  serviceInstances,
  apiKeys,
  refreshTokens,
  userActivityLogs,
} from '@suiftly/database/schema';
import { eq } from 'drizzle-orm';

/**
 * Clean up all data for a customer by ID
 * Respects foreign key constraints by deleting in correct order
 */
export async function cleanupCustomerById(customerId: number) {
  // Delete invoice payments FIRST (references escrow_transactions, billing_records, customer_credits)
  const customerBillingRecords = await db.query.billingRecords.findMany({
    where: eq(billingRecords.customerId, customerId)
  });
  for (const record of customerBillingRecords) {
    await db.delete(invoicePayments)
      .where(eq(invoicePayments.billingRecordId, record.id));
  }

  // Now safe to delete parent tables
  await db.delete(usageRecords)
    .where(eq(usageRecords.customerId, customerId));
  await db.delete(escrowTransactions)
    .where(eq(escrowTransactions.customerId, customerId));
  await db.delete(ledgerEntries)
    .where(eq(ledgerEntries.customerId, customerId));
  await db.delete(billingRecords)
    .where(eq(billingRecords.customerId, customerId));
  await db.delete(customerCredits)
    .where(eq(customerCredits.customerId, customerId));
  await db.delete(sealKeys)
    .where(eq(sealKeys.customerId, customerId));
  await db.delete(serviceInstances)
    .where(eq(serviceInstances.customerId, customerId));
  await db.delete(apiKeys)
    .where(eq(apiKeys.customerId, customerId));
  await db.delete(refreshTokens)
    .where(eq(refreshTokens.customerId, customerId));
  await db.delete(userActivityLogs)
    .where(eq(userActivityLogs.customerId, customerId));
  await db.delete(mockSuiTransactions)
    .where(eq(mockSuiTransactions.customerId, customerId));

  // Delete the customer last
  await db.delete(customers)
    .where(eq(customers.customerId, customerId));
}

/**
 * Clean up all data for a customer by wallet address
 * Includes mock tracking objects
 */
export async function cleanupCustomerByWallet(walletAddress: string) {
  // Find customer
  const customer = await db.query.customers.findFirst({
    where: eq(customers.walletAddress, walletAddress)
  });

  // Delete tracking objects (exist independently of customer)
  await db.delete(mockTrackingObjects)
    .where(eq(mockTrackingObjects.userAddress, walletAddress));

  if (customer) {
    await cleanupCustomerById(customer.customerId);
  }
}
