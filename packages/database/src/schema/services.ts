import { pgTable, serial, integer, boolean, jsonb, timestamp, date, unique, index, bigint } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';
import { billingRecords } from './escrow';
import { serviceTypeEnum, serviceStateEnum, serviceTierEnum } from './enums';

/**
 * Service Instances Table
 *
 * Tracks customer subscriptions to services with tier management.
 * Supports scheduled tier changes and cancellations per BILLING_DESIGN.md R13.
 */
export const serviceInstances = pgTable('service_instances', {
  instanceId: serial('instance_id').primaryKey(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  serviceType: serviceTypeEnum('service_type').notNull(),
  state: serviceStateEnum('state').notNull().default('not_provisioned'),
  tier: serviceTierEnum('tier').notNull(),
  isUserEnabled: boolean('is_user_enabled').notNull().default(true),
  // Subscription pending invoice reference: NULL = no pending subscription charge, ID = immediate invoice awaiting payment
  // Used exclusively during initial subscription flow - stores reference to the invoice created at subscribe time
  // This replaces the old boolean subscriptionChargePending field for better atomicity and direct lookup
  subPendingInvoiceId: bigint('sub_pending_invoice_id', { mode: 'number' }).references(() => billingRecords.id),
  paidOnce: boolean('paid_once').notNull().default(false), // Has this service ever had a successful payment?
  config: jsonb('config'),
  enabledAt: timestamp('enabled_at'),
  disabledAt: timestamp('disabled_at'),

  // Phase 1C: Tier change scheduling (BILLING_DESIGN.md R13.2)
  // For scheduled downgrades - takes effect on 1st of next month
  scheduledTier: serviceTierEnum('scheduled_tier'),
  scheduledTierEffectiveDate: date('scheduled_tier_effective_date'),

  // Phase 1C: Cancellation scheduling (BILLING_DESIGN.md R13.3)
  // During billing period: cancellation_scheduled_for = end of period
  // After period ends: state → cancellation_pending, cancellation_effective_at = +7 days
  cancellationScheduledFor: date('cancellation_scheduled_for'),
  cancellationEffectiveAt: timestamp('cancellation_effective_at', { withTimezone: true }),

  // Usage billing: tracks last billed timestamp to prevent double-billing (STATS_DESIGN.md D3)
  lastBilledTimestamp: timestamp('last_billed_timestamp'),
}, (table) => ({
  uniqueCustomerService: unique().on(table.customerId, table.serviceType),
  // Index for efficient service-type iteration (backend synchronization)
  idxServiceTypeState: index('idx_service_type_state').on(table.serviceType, table.state),
  // Index for finding services with scheduled cancellations
  idxServiceCancellationScheduled: index('idx_service_cancellation_scheduled')
    .on(table.cancellationScheduledFor)
    .where(sql`${table.cancellationScheduledFor} IS NOT NULL`),
  // Index for processing cancellation_pending services
  idxServiceCancellationPending: index('idx_service_cancellation_pending')
    .on(table.state, table.cancellationEffectiveAt)
    .where(sql`${table.state} = 'cancellation_pending'`),
  // Index for finding services with scheduled tier changes
  idxServiceScheduledTier: index('idx_service_scheduled_tier')
    .on(table.scheduledTierEffectiveDate)
    .where(sql`${table.scheduledTier} IS NOT NULL`),
}));
