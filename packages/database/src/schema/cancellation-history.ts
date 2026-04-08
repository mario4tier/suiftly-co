import { pgTable, serial, integer, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';
import { serviceTypeEnum, serviceTierEnum } from './enums';

/**
 * Service Cancellation History Table
 *
 * Tracks completed service cancellations for anti-abuse protection.
 * Used to enforce the 7-day cooldown period before re-provisioning.
 *
 * Per BILLING_DESIGN.md R13.6: Prevents abuse by blocking immediate
 * re-subscription after cancellation (e.g., to capture promotional credits).
 */
export const serviceCancellationHistory = pgTable('service_cancellation_history', {
  id: serial('id').primaryKey(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  serviceType: serviceTypeEnum('service_type').notNull(),
  previousTier: serviceTierEnum('previous_tier'),  // NOT NULL only for platform services (enforced by check constraint)
  billingPeriodEndedAt: timestamp('billing_period_ended_at', { withTimezone: true }).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull(),
  cooldownExpiresAt: timestamp('cooldown_expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  // Lookup by customer + service type for canProvisionService() check
  idxCancellationCustomerService: index('idx_cancellation_customer_service')
    .on(table.customerId, table.serviceType),
  // For cleanup of expired cooldown records (if needed)
  idxCancellationCooldown: index('idx_cancellation_cooldown')
    .on(table.cooldownExpiresAt),
  // Ensure previousTier is set only for platform services (non-platform services never have tiers)
  checkTierOnlyForPlatform: check(
    'check_tier_only_for_platform',
    sql`(${table.serviceType} = 'platform' AND ${table.previousTier} IS NOT NULL) OR (${table.serviceType} != 'platform' AND ${table.previousTier} IS NULL)`
  ),
}));
