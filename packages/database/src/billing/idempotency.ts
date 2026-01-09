/**
 * Idempotency Handling for Billing Operations
 *
 * Prevents duplicate charges by caching operation results.
 * Uses billing_idempotency table for persistence.
 *
 * See BILLING_DESIGN.md Section "Error Handling" for requirements.
 */

import { eq, lt } from 'drizzle-orm';
import { billingIdempotency } from '../schema';
import type { Database, DatabaseOrTransaction } from '../db';
import type { IdempotencyResult } from './types';
import type { DBClock } from '@suiftly/shared/db-clock';

/**
 * Execute an operation with idempotency protection
 *
 * If the idempotency key exists, returns cached result.
 * Otherwise, executes operation and caches the result.
 *
 * IMPORTANT: Caches BOTH success and failure results. This is correct:
 * - Monthly billing: Prevents duplicate invoice creation for same month
 * - Payment fails? Invoice exists as 'failed', retry logic handles it separately
 * - Idempotency = "operation attempted", not "operation succeeded"
 *
 * User NOT stuck on failure:
 * - Invoice created with status='failed' (customer can see they owe)
 * - Separate retry logic (retryFailedPayments) keeps attempting
 * - Grace period starts (14 days to add funds)
 * - Idempotency only prevents duplicate INVOICES, not duplicate PAYMENT ATTEMPTS
 *
 * @param tx Transaction handle
 * @param idempotencyKey Unique key for this operation
 * @param operation Function to execute if key doesn't exist
 * @returns Result (either cached or freshly computed)
 */
export async function withIdempotency<T>(
  tx: DatabaseOrTransaction,
  idempotencyKey: string,
  operation: () => Promise<T>
): Promise<IdempotencyResult<T>> {
  // Check if we've seen this key before
  const [existing] = await tx
    .select()
    .from(billingIdempotency)
    .where(eq(billingIdempotency.idempotencyKey, idempotencyKey))
    .limit(1);

  if (existing) {
    // Return cached result
    const cachedResult = JSON.parse(existing.response) as T;
    return {
      cached: true,
      result: cachedResult,
    };
  }

  // Execute operation
  const result = await operation();

  // Cache result
  await tx.insert(billingIdempotency).values({
    idempotencyKey,
    billingRecordId: null, // Can be set by caller if needed
    response: JSON.stringify(result),
  });

  return {
    cached: false,
    result,
  };
}

/**
 * Generate idempotency key for monthly billing
 *
 * Format: monthly-{customerId}-{year}-{month}
 * Ensures each customer is billed once per month.
 *
 * @param customerId Customer ID
 * @param year Year (e.g., 2025)
 * @param month Month (1-12)
 * @returns Idempotency key
 */
export function generateMonthlyBillingKey(
  customerId: number,
  year: number,
  month: number
): string {
  return `monthly-${customerId}-${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Generate idempotency key for usage billing
 *
 * Format: usage-{customerId}-{timestamp}
 * Timestamp ensures each usage charge is unique.
 *
 * @param customerId Customer ID
 * @param timestamp Unix timestamp in milliseconds
 * @returns Idempotency key
 */
export function generateUsageBillingKey(
  customerId: number,
  timestamp: number
): string {
  return `usage-${customerId}-${timestamp}`;
}

/**
 * Clean up old idempotency records
 *
 * Removes records older than specified age (default 24 hours).
 * Should be run periodically to prevent table bloat.
 *
 * @param tx Transaction handle
 * @param clock DBClock for time reference (required for testability)
 * @param maxAgeHours Maximum age in hours (default 24)
 * @returns Number of records deleted
 */
export async function cleanupIdempotencyRecords(
  tx: DatabaseOrTransaction,
  clock: DBClock,
  maxAgeHours: number = 24
): Promise<number> {
  const now = clock.now();
  const cutoffTime = new Date(now.getTime() - maxAgeHours * 60 * 60 * 1000);

  const deleted = await tx
    .delete(billingIdempotency)
    .where(lt(billingIdempotency.createdAt, cutoffTime)) // Delete records OLDER than cutoff
    .returning({ key: billingIdempotency.idempotencyKey });

  return deleted.length;
}
