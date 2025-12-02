/**
 * Grace Period Management
 *
 * Handles 14-day grace period for payment failures (only for paid_once = TRUE customers).
 *
 * See BILLING_DESIGN.md R6 for detailed requirements:
 * - Grace period only applies when customers.paid_once = TRUE
 * - 14 days from first failure
 * - Reminder emails sent during grace period
 * - Account suspended after grace period expires
 *
 * State tracking:
 * - customers.grace_period_start: When grace period started (NULL = no grace period)
 * - customers.grace_period_notified_at: Timestamps of reminder emails
 * - customers.status: 'active' during grace, 'suspended' after
 */

import { eq, and, sql, lt, isNotNull } from 'drizzle-orm';
import { customers, serviceInstances } from '../schema';
import type { DatabaseOrTransaction } from '../db';
import type { LockedTransaction } from './locking';
import type { DBClock } from '@suiftly/shared/db-clock';
import type { BillingOperation } from './types';

/**
 * Start grace period for a customer
 *
 * Only starts if customer has paid before (paid_once = TRUE).
 * If already in grace period, does nothing.
 *
 * @param tx Transaction handle (must have customer lock)
 * @param customerId Customer ID
 * @param clock DBClock for timestamps
 * @returns true if grace period started, false if not applicable
 */
export async function startGracePeriod(
  tx: LockedTransaction,
  customerId: number,
  clock: DBClock
): Promise<boolean> {
  const [customer] = await tx
    .select()
    .from(customers)
    .where(eq(customers.customerId, customerId))
    .limit(1);

  if (!customer) {
    return false;
  }

  // Grace period only applies to customers who have paid before
  if (!customer.paidOnce) {
    return false;
  }

  // If already in grace period, don't restart
  if (customer.gracePeriodStart) {
    return false;
  }

  // Start grace period
  const today = clock.today();
  await tx
    .update(customers)
    .set({
      gracePeriodStart: today.toISOString().split('T')[0], // DATE format
      gracePeriodNotifiedAt: [], // Reset notification timestamps
    })
    .where(eq(customers.customerId, customerId));

  return true;
}

/**
 * Clear grace period for a customer (payment received)
 *
 * @param tx Transaction handle (must have customer lock)
 * @param customerId Customer ID
 */
export async function clearGracePeriod(
  tx: LockedTransaction,
  customerId: number
): Promise<void> {
  await tx
    .update(customers)
    .set({
      gracePeriodStart: null,
      gracePeriodNotifiedAt: null,
    })
    .where(eq(customers.customerId, customerId));
}

/**
 * Check if customer's grace period has expired
 *
 * Grace period is 14 days from start date.
 *
 * @param tx Transaction handle
 * @param customerId Customer ID
 * @param clock DBClock for current date
 * @param gracePeriodDays Grace period duration (default 14)
 * @returns true if grace period expired and customer should be suspended
 */
export async function isGracePeriodExpired(
  tx: DatabaseOrTransaction,
  customerId: number,
  clock: DBClock,
  gracePeriodDays: number = 14
): Promise<boolean> {
  const [customer] = await tx
    .select()
    .from(customers)
    .where(eq(customers.customerId, customerId))
    .limit(1);

  if (!customer || !customer.gracePeriodStart || !customer.paidOnce) {
    return false; // No grace period or not applicable
  }

  const gracePeriodStart = new Date(customer.gracePeriodStart);
  const expiryDate = new Date(gracePeriodStart);
  expiryDate.setDate(expiryDate.getDate() + gracePeriodDays);

  const today = clock.today();

  return today >= expiryDate;
}

/**
 * Suspend customer account due to non-payment
 *
 * Called when grace period expires. Sets all services to disabled state.
 *
 * @param tx Transaction handle (must have customer lock)
 * @param customerId Customer ID
 * @returns Number of services affected
 */
export async function suspendCustomerForNonPayment(
  tx: LockedTransaction,
  customerId: number
): Promise<number> {
  // Update customer status
  await tx
    .update(customers)
    .set({ status: 'suspended' })
    .where(eq(customers.customerId, customerId));

  // Disable all active services
  const affectedServices = await tx
    .update(serviceInstances)
    .set({ isUserEnabled: false })
    .where(
      and(
        eq(serviceInstances.customerId, customerId),
        eq(serviceInstances.isUserEnabled, true)
      )
    )
    .returning({ instanceId: serviceInstances.instanceId });

  return affectedServices.length;
}

/**
 * Resume customer account after payment
 *
 * Called when customer pays after being suspended.
 * IMPORTANT: Services remain disabled - user must manually re-enable.
 *
 * @param tx Transaction handle (must have customer lock)
 * @param customerId Customer ID
 */
export async function resumeCustomerAccount(
  tx: LockedTransaction,
  customerId: number
): Promise<void> {
  await tx
    .update(customers)
    .set({
      status: 'active',
      gracePeriodStart: null,
      gracePeriodNotifiedAt: null,
    })
    .where(eq(customers.customerId, customerId));

  // Services remain disabled - user must manually re-enable (per BILLING_DESIGN.md R6)
}

/**
 * Get all customers with expired grace periods
 *
 * Used by billing processor to batch-suspend customers.
 *
 * @param tx Transaction handle
 * @param clock DBClock for current date
 * @param gracePeriodDays Grace period duration (default 14)
 * @returns Array of customer IDs to suspend
 */
export async function getCustomersWithExpiredGracePeriod(
  tx: DatabaseOrTransaction,
  clock: DBClock,
  gracePeriodDays: number = 14
): Promise<number[]> {
  const today = clock.today();
  const expiryThreshold = new Date(today);
  expiryThreshold.setDate(expiryThreshold.getDate() - gracePeriodDays);

  const expiredCustomers = await tx
    .select({ customerId: customers.customerId })
    .from(customers)
    .where(
      and(
        eq(customers.status, 'active'), // Still active (not yet suspended)
        eq(customers.paidOnce, true), // Only customers who have paid before
        isNotNull(customers.gracePeriodStart), // Has grace period
        lt(customers.gracePeriodStart, expiryThreshold.toISOString().split('T')[0])
      )
    );

  return expiredCustomers.map((c) => c.customerId);
}

/**
 * Record that a reminder email was sent during grace period
 *
 * @param tx Transaction handle
 * @param customerId Customer ID
 * @param clock DBClock for timestamp
 */
export async function recordGracePeriodNotification(
  tx: LockedTransaction,
  customerId: number,
  clock: DBClock
): Promise<void> {
  const now = clock.now();

  // Append to notification timestamps array
  await tx
    .update(customers)
    .set({
      gracePeriodNotifiedAt: sql`array_append(COALESCE(${customers.gracePeriodNotifiedAt}, ARRAY[]::timestamptz[]), ${now})`,
    })
    .where(eq(customers.customerId, customerId));
}
