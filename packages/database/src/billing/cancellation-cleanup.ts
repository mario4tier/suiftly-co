/**
 * Cancellation Cleanup Job (Phase 1C)
 *
 * Processes platform cancellations after 7-day grace period.
 * Per BILLING_DESIGN.md R13.7.
 *
 * What it does:
 * 1. Finds customers where platformCancellationEffectiveAt <= NOW
 * 2. Records in cancellation_history (for anti-abuse tracking)
 * 3. Deletes related records (API keys, Seal keys, packages)
 * 4. Resets services to not_provisioned state
 *
 * Run frequency: Hourly (or more frequently for timely cleanup)
 *
 * TODO(production-safety): Before production launch, seal keys (especially imported ones)
 * should NOT be deleted on cancellation. Imported seal keys represent on-chain objects
 * with real value. Instead: disable services/keys, keep data intact, allow re-subscription
 * to restore access. Only delete after extended inactivity (90+ days) or explicit user
 * request. See: https://github.com/mario4tier/suiftly-co/issues/XX
 */

import { eq, and, lte, sql, isNotNull, inArray } from 'drizzle-orm';
import type { Database, DatabaseOrTransaction } from '../db';
import {
  customers,
  serviceInstances,
  serviceCancellationHistory,
  apiKeys,
  sealKeys,
  sealPackages,
  userActivityLogs,
} from '../schema';
import { withCustomerLock } from './locking';
import type { DBClock } from '@suiftly/shared/db-clock';
import type { ServiceType, ServiceTier } from '../schema/enums';

// ============================================================================
// Types
// ============================================================================

export interface CancellationCleanupResult {
  servicesProcessed: number;
  servicesDeleted: Array<{
    customerId: number;
    serviceType: ServiceType;
    previousTier: ServiceTier;
  }>;
  errors: Array<{
    customerId: number;
    serviceType: ServiceType;
    error: string;
  }>;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Cooldown period after service deletion (days)
 * Customer cannot re-subscribe during this period
 */
const COOLDOWN_PERIOD_DAYS = 7;

// ============================================================================
// Main Cleanup Function
// ============================================================================

/**
 * Process all expired cancellation_pending services
 *
 * This is the main entry point, called by cron job.
 *
 * @param db Database instance
 * @param clock DBClock for timestamps
 * @returns Cleanup result
 */
export async function processCancellationCleanup(
  db: Database,
  clock: DBClock
): Promise<CancellationCleanupResult> {
  const now = clock.now();

  const result: CancellationCleanupResult = {
    servicesProcessed: 0,
    servicesDeleted: [],
    errors: [],
  };

  // Find all customers with platform cancellation past their effective date
  const expiredCustomers = await db
    .select()
    .from(customers)
    .where(
      and(
        isNotNull(customers.platformCancellationEffectiveAt),
        lte(customers.platformCancellationEffectiveAt, now)
      )
    );

  // Process each customer's platform cancellation with customer-level locking
  for (const customer of expiredCustomers) {
    result.servicesProcessed++;
    const previousTier = (customer.platformTier ?? 'starter') as ServiceTier;

    try {
      await processPlatformCancellation(
        db,
        customer.customerId,
        previousTier,
        clock
      );

      result.servicesDeleted.push({
        customerId: customer.customerId,
        serviceType: 'platform' as ServiceType,
        previousTier,
      });
    } catch (error) {
      result.errors.push({
        customerId: customer.customerId,
        serviceType: 'platform' as ServiceType,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return result;
}

/**
 * Process platform cancellation for a customer
 *
 * Records cancellation history, cleans up all service instances,
 * and resets platform fields. Called within customer lock for atomicity.
 *
 * @param db Database instance
 * @param customerId Customer ID
 * @param previousTier Tier before cancellation
 * @param clock DBClock for timestamps
 */
async function processPlatformCancellation(
  db: Database,
  customerId: number,
  previousTier: ServiceTier,
  clock: DBClock
): Promise<void> {
  await withCustomerLock(db, customerId, async (tx) => {
    const now = clock.now();
    const cooldownExpiresAt = clock.addDays(COOLDOWN_PERIOD_DAYS);

    // 1. Record platform cancellation in history (for anti-abuse tracking)
    await tx.insert(serviceCancellationHistory).values({
      customerId,
      serviceType: 'platform',
      previousTier,
      billingPeriodEndedAt: now, // Approximate - actual was 7 days ago
      deletedAt: now,
      cooldownExpiresAt,
    });

    // 2. Clean up all service instances for this customer
    const customerServices = await tx
      .select()
      .from(serviceInstances)
      .where(eq(serviceInstances.customerId, customerId));

    for (const service of customerServices) {
      const serviceType = service.serviceType as ServiceType;

      // Delete API keys for this service
      await tx
        .delete(apiKeys)
        .where(
          and(
            eq(apiKeys.customerId, customerId),
            eq(apiKeys.serviceType, serviceType)
          )
        );

      // Delete Seal keys and packages (if Seal service)
      if (serviceType === 'seal') {
        const customerSealKeys = await tx
          .select({ sealKeyId: sealKeys.sealKeyId })
          .from(sealKeys)
          .where(eq(sealKeys.customerId, customerId));

        if (customerSealKeys.length > 0) {
          const sealKeyIds = customerSealKeys.map(k => k.sealKeyId);
          await tx
            .delete(sealPackages)
            .where(inArray(sealPackages.sealKeyId, sealKeyIds));
        }

        await tx.delete(sealKeys).where(eq(sealKeys.customerId, customerId));
      }

      // Reset service instance to not_provisioned state
      await tx
        .update(serviceInstances)
        .set({
          state: 'not_provisioned',
          isUserEnabled: true, // Reset to default
          cpEnabled: false, // Remove from vault generation
          config: null,
          enabledAt: null,
          disabledAt: null,
        })
        .where(eq(serviceInstances.instanceId, service.instanceId));
    }

    // 3. Clear platform cancellation/billing fields on customer
    await tx
      .update(customers)
      .set({
        platformTier: null, // Fully cancelled — no subscription
        pendingInvoiceId: null, // Reset - new invoice will be created on re-subscribe
        platformCancellationScheduledFor: null,
        platformCancellationEffectiveAt: null,
        scheduledPlatformTier: null,
        scheduledPlatformTierEffectiveDate: null,
      })
      .where(eq(customers.customerId, customerId));

    // 4. Log the cleanup
    await tx.insert(userActivityLogs).values({
      customerId,
      clientIp: '0.0.0.0', // System action
      message: `Platform subscription cancelled. Cooldown expires: ${cooldownExpiresAt.toISOString().split('T')[0]}`,
    });
  });
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get services approaching cancellation deadline
 *
 * Returns services that will be deleted within the specified days.
 * Useful for sending reminder notifications.
 *
 * @param db Database instance
 * @param clock DBClock for timestamps
 * @param daysUntilDeletion Days until deletion (e.g., 1 = tomorrow)
 * @returns Services approaching deadline
 */
export async function getCustomersApproachingCancellation(
  db: Database,
  clock: DBClock,
  daysUntilDeletion: number = 1
): Promise<
  Array<{
    customerId: number;
    cancellationEffectiveAt: Date;
  }>
> {
  const deadline = clock.addDays(daysUntilDeletion);

  // Find customers with platform cancellation approaching deadline
  const results = await db
    .select({
      customerId: customers.customerId,
      cancellationEffectiveAt: customers.platformCancellationEffectiveAt,
    })
    .from(customers)
    .where(
      and(
        isNotNull(customers.platformCancellationEffectiveAt),
        lte(customers.platformCancellationEffectiveAt, deadline)
      )
    );

  return results.map(r => ({
    customerId: r.customerId,
    cancellationEffectiveAt: r.cancellationEffectiveAt!,
  }));
}

/**
 * Clean up old cancellation history records
 *
 * Removes records where cooldown has long expired.
 * Keeps records for audit purposes (default: 1 year retention).
 *
 * @param db Database instance
 * @param clock DBClock for timestamps
 * @param retentionDays Days to retain records after cooldown expires (default: 365)
 * @returns Number of records deleted
 */
export async function cleanupOldCancellationHistory(
  db: Database,
  clock: DBClock,
  retentionDays: number = 365
): Promise<number> {
  const cutoffDate = new Date(clock.now().getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const result = await db
    .delete(serviceCancellationHistory)
    .where(lte(serviceCancellationHistory.cooldownExpiresAt, cutoffDate));

  // Drizzle returns undefined for count, so we handle that
  return 0; // In production, you'd get the affected rows count
}
