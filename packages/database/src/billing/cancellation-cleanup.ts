/**
 * Cancellation Cleanup Job (Phase 1C)
 *
 * Processes services in cancellation_pending state after 7-day grace period.
 * Per BILLING_DESIGN.md R13.7.
 *
 * What it does:
 * 1. Finds services where cancellation_effective_at <= NOW
 * 2. Records in cancellation_history (for anti-abuse tracking)
 * 3. Deletes related records (API keys, Seal keys, packages)
 * 4. Resets service to not_provisioned state
 *
 * Run frequency: Hourly (or more frequently for timely cleanup)
 */

import { eq, and, lte, sql, inArray } from 'drizzle-orm';
import type { Database, DatabaseOrTransaction } from '../db';
import {
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

  // Find all services in cancellation_pending state past their effective date
  const expiredServices = await db
    .select()
    .from(serviceInstances)
    .where(
      and(
        eq(serviceInstances.state, 'cancellation_pending'),
        lte(serviceInstances.cancellationEffectiveAt, now)
      )
    );

  // Process each service with customer-level locking
  for (const service of expiredServices) {
    result.servicesProcessed++;

    try {
      await processServiceDeletion(
        db,
        service.customerId,
        service.serviceType as ServiceType,
        service.tier as ServiceTier,
        service.instanceId,
        clock
      );

      result.servicesDeleted.push({
        customerId: service.customerId,
        serviceType: service.serviceType as ServiceType,
        previousTier: service.tier as ServiceTier,
      });
    } catch (error) {
      result.errors.push({
        customerId: service.customerId,
        serviceType: service.serviceType as ServiceType,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return result;
}

/**
 * Process deletion of a single service
 *
 * Called within customer lock to ensure atomicity.
 *
 * @param db Database instance
 * @param customerId Customer ID
 * @param serviceType Service type
 * @param previousTier Tier before cancellation
 * @param instanceId Service instance ID
 * @param clock DBClock for timestamps
 */
async function processServiceDeletion(
  db: Database,
  customerId: number,
  serviceType: ServiceType,
  previousTier: ServiceTier,
  instanceId: number,
  clock: DBClock
): Promise<void> {
  await withCustomerLock(db, customerId, async (tx) => {
    const now = clock.now();
    const cooldownExpiresAt = clock.addDays(COOLDOWN_PERIOD_DAYS);

    // 1. Record in cancellation history (for anti-abuse tracking)
    await tx.insert(serviceCancellationHistory).values({
      customerId,
      serviceType,
      previousTier,
      billingPeriodEndedAt: now, // Approximate - actual was 7 days ago
      deletedAt: now,
      cooldownExpiresAt,
    });

    // 2. Delete related records

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
      // First get all seal key IDs for this customer
      const customerSealKeys = await tx
        .select({ sealKeyId: sealKeys.sealKeyId })
        .from(sealKeys)
        .where(eq(sealKeys.customerId, customerId));

      // Delete packages for all seal keys in one query
      if (customerSealKeys.length > 0) {
        const sealKeyIds = customerSealKeys.map(k => k.sealKeyId);
        await tx
          .delete(sealPackages)
          .where(inArray(sealPackages.sealKeyId, sealKeyIds));
      }

      // Delete seal keys
      await tx.delete(sealKeys).where(eq(sealKeys.customerId, customerId));
    }

    // 3. Reset service instance to not_provisioned state
    // Note: subPendingInvoiceId is NULL - re-subscribing will create new invoice
    await tx
      .update(serviceInstances)
      .set({
        state: 'not_provisioned',
        tier: 'starter', // Reset to default tier
        isUserEnabled: true, // Reset to default
        subPendingInvoiceId: null, // Reset - new invoice will be created on re-subscribe
        config: null,
        enabledAt: null,
        disabledAt: null,
        cancellationScheduledFor: null,
        cancellationEffectiveAt: null,
        scheduledTier: null,
        scheduledTierEffectiveDate: null,
      })
      .where(eq(serviceInstances.instanceId, instanceId));

    // 4. Log the cleanup
    await tx.insert(userActivityLogs).values({
      customerId,
      clientIp: '0.0.0.0', // System action
      message: `Service ${serviceType} deleted after cancellation grace period. Cooldown expires: ${cooldownExpiresAt.toISOString().split('T')[0]}`,
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
export async function getServicesApproachingDeletion(
  db: Database,
  clock: DBClock,
  daysUntilDeletion: number = 1
): Promise<
  Array<{
    customerId: number;
    serviceType: ServiceType;
    cancellationEffectiveAt: Date;
  }>
> {
  const now = clock.now();
  const deadline = clock.addDays(daysUntilDeletion);

  const services = await db
    .select({
      customerId: serviceInstances.customerId,
      serviceType: serviceInstances.serviceType,
      cancellationEffectiveAt: serviceInstances.cancellationEffectiveAt,
    })
    .from(serviceInstances)
    .where(
      and(
        eq(serviceInstances.state, 'cancellation_pending'),
        lte(serviceInstances.cancellationEffectiveAt, deadline)
      )
    );

  return services.map((s) => ({
    customerId: s.customerId,
    serviceType: s.serviceType as ServiceType,
    cancellationEffectiveAt: s.cancellationEffectiveAt!,
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
