import { pgTable, serial, integer, bigint, bigserial, varchar, text, timestamp, boolean, jsonb, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';
import { billingRecords, escrowTransactions } from './escrow';
import { serviceTypeEnum, invoiceLineItemTypeEnum, paymentSourceTypeEnum, paymentProviderTypeEnum, paymentMethodStatusEnum, creditReasonEnum } from './enums';
import { FIELD_LIMITS } from '@suiftly/shared/constants';

/**
 * Customer Credits Table
 *
 * Off-chain promotional/compensation credits (non-withdrawable).
 * Used for: outage compensation, promos, goodwill, prepay reconciliation.
 *
 * Key difference from escrow:
 * - Credits are off-chain (no tx_digest)
 * - Non-withdrawable (spend on Suiftly only)
 * - May have expiration dates
 */
export const customerCredits = pgTable('customer_credits', {
  creditId: serial('credit_id').primaryKey(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),

  // Amounts
  originalAmountUsdCents: bigint('original_amount_usd_cents', { mode: 'number' }).notNull(),
  remainingAmountUsdCents: bigint('remaining_amount_usd_cents', { mode: 'number' }).notNull(),

  // Metadata
  reason: creditReasonEnum('reason').notNull(),
  description: text('description'),
  campaignId: varchar('campaign_id', { length: 50 }),

  // Expiration
  expiresAt: timestamp('expires_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idxCreditCustomer: index('idx_credit_customer').on(table.customerId),
  idxCreditExpires: index('idx_credit_expires').on(table.expiresAt).where(sql`${table.expiresAt} IS NOT NULL`),
  checkRemainingNotNegative: check('check_remaining_not_negative', sql`${table.remainingAmountUsdCents} >= 0`),
  checkRemainingNotExceedOriginal: check('check_remaining_not_exceed_original', sql`${table.remainingAmountUsdCents} <= ${table.originalAmountUsdCents}`),
}));

/**
 * Invoice Payments Table
 *
 * Tracks multi-source payments applied to invoices.
 * Each row represents one payment application from one source.
 *
 * Supports:
 * - credit (customer_credits) — local FK
 * - escrow (escrow_transactions) — local FK
 * - stripe (Stripe payment intent ID) — external reference
 * - paypal (PayPal order ID) — external reference
 */
export const invoicePayments = pgTable('invoice_payments', {
  paymentId: serial('payment_id').primaryKey(),
  billingRecordId: bigint('billing_record_id', { mode: 'number' }).notNull().references(() => billingRecords.id),

  // Payment source
  sourceType: paymentSourceTypeEnum('source_type').notNull(),

  // Local DB foreign keys (for sources with local tables)
  creditId: integer('credit_id').references(() => customerCredits.creditId),
  escrowTransactionId: bigint('escrow_transaction_id', { mode: 'number' }).references(() => escrowTransactions.txId),

  // Generic reference for external providers (Stripe payment intent ID, PayPal order ID)
  // External system is the source of record — no local FK needed
  providerReferenceId: varchar('provider_reference_id', { length: 200 }),

  // Amount applied from this source
  amountUsdCents: bigint('amount_usd_cents', { mode: 'number' }).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idxPaymentBillingRecord: index('idx_payment_billing_record').on(table.billingRecordId),
  idxPaymentCredit: index('idx_payment_credit').on(table.creditId).where(sql`${table.creditId} IS NOT NULL`),
  idxPaymentEscrow: index('idx_payment_escrow').on(table.escrowTransactionId).where(sql`${table.escrowTransactionId} IS NOT NULL`),
  idxPaymentProvider: index('idx_payment_provider').on(table.providerReferenceId).where(sql`${table.providerReferenceId} IS NOT NULL`),

  // Constraint: sourceType must match exactly one reference column
  // credit → creditId, escrow → escrowTransactionId, stripe/paypal → providerReferenceId
  checkSourceTypeMatch: check('check_source_type_match', sql`
    (${table.sourceType} = 'credit'
      AND ${table.creditId} IS NOT NULL
      AND ${table.escrowTransactionId} IS NULL
      AND ${table.providerReferenceId} IS NULL) OR
    (${table.sourceType} = 'escrow'
      AND ${table.escrowTransactionId} IS NOT NULL
      AND ${table.creditId} IS NULL
      AND ${table.providerReferenceId} IS NULL) OR
    (${table.sourceType} IN ('stripe', 'paypal')
      AND ${table.providerReferenceId} IS NOT NULL
      AND ${table.creditId} IS NULL
      AND ${table.escrowTransactionId} IS NULL)
  `),
}));

/**
 * Customer Payment Methods Table
 *
 * Stores which payment methods a customer has configured and their preferred order.
 *
 * Uniqueness: partial unique index on (customer_id, provider_ref) WHERE active AND NOT NULL.
 * This prevents the same card/agreement from being added twice, while allowing multiple
 * cards per provider type in the future. Escrow (providerRef=NULL) is limited to one
 * per customer by application-level pre-check (not the DB index).
 *
 * Provider account IDs live on customers table (escrowContractId, stripeCustomerId),
 * not here. This table tracks which methods are enabled and in what priority order.
 *
 * providerRef stores method-level references:
 * - Escrow: NULL (uses customers.escrowContractId)
 * - Stripe: payment method ID (e.g. 'pm_xxx') — set by webhook after card confirmation
 * - PayPal: billing agreement ID
 *
 * providerConfig stores display/config data (JSONB):
 * - Escrow: NULL (display info computed live from customers.currentBalanceUsdCents)
 * - Stripe: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2027 }
 * - PayPal: { email: 'user@example.com' }
 */
export const customerPaymentMethods = pgTable('customer_payment_methods', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  providerType: paymentProviderTypeEnum('provider_type').notNull(),
  status: paymentMethodStatusEnum('status').notNull().default('active'),
  priority: integer('priority').notNull(), // User-defined order (1 = first tried, 2 = fallback, etc.)

  providerRef: varchar('provider_ref', { length: 200 }),
  providerConfig: jsonb('provider_config'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idxCustomerPriority: index('idx_cpm_customer_priority').on(table.customerId, table.priority),
}));
// NOTE: Partial unique index (prevent duplicate provider_ref per customer)
// created in migration SQL because Drizzle ORM unique() does not support WHERE clauses:
//   CREATE UNIQUE INDEX uniq_customer_provider_ref_active
//   ON customer_payment_methods (customer_id, provider_ref)
//   WHERE status = 'active' AND provider_ref IS NOT NULL;
// This allows multiple cards per provider type in the future. Escrow uniqueness
// (providerRef=NULL) is enforced by application-level pre-check, not the DB index.
//
// NOTE: Partial unique index (prevent duplicate priority per customer)
// created in migration SQL because Drizzle ORM unique() does not support WHERE clauses:
//   CREATE UNIQUE INDEX uniq_customer_priority_active
//   ON customer_payment_methods (customer_id, priority)
//   WHERE status = 'active';
// This ensures deterministic provider chain ordering in getCustomerProviders().

/**
 * Payment Webhook Events Table
 *
 * Webhook idempotency — prevents processing the same event twice.
 * Shared across webhook-based providers (Stripe, PayPal).
 * Not used for escrow — escrow charges are synchronous on-chain.
 */
export const paymentWebhookEvents = pgTable('payment_webhook_events', {
  eventId: varchar('event_id', { length: 200 }).primaryKey(), // Provider's event ID
  providerType: paymentProviderTypeEnum('provider_type').notNull(),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  processed: boolean('processed').notNull().default(false),
  customerId: integer('customer_id').references(() => customers.customerId),
  data: text('data'), // JSON-encoded event payload (for debugging/audit)

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
}, (table) => ({
  idxWebhookProvider: index('idx_webhook_provider').on(table.providerType, table.eventType),
  idxWebhookCustomer: index('idx_webhook_customer').on(table.customerId).where(sql`${table.customerId} IS NOT NULL`),
}));

/**
 * Billing Idempotency Table
 *
 * Prevents duplicate charges by tracking idempotency keys.
 * Cached responses allow returning same result for retry attempts.
 *
 * Cleanup: Remove entries older than 24 hours (stale keys).
 */
export const billingIdempotency = pgTable('billing_idempotency', {
  idempotencyKey: varchar('idempotency_key', { length: 100 }).primaryKey(),
  billingRecordId: bigint('billing_record_id', { mode: 'number' }).references(() => billingRecords.id),
  response: text('response').notNull(), // JSON-encoded response
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idxIdempotencyCreated: index('idx_idempotency_created').on(table.createdAt), // For cleanup of old entries
}));

/**
 * Invoice Line Items Table
 *
 * Stores structured invoice line items with semantic types.
 * Uses PostgreSQL ENUMs for type safety at database level.
 *
 * itemType uses invoiceLineItemTypeEnum (invoice_line_item_type):
 * - subscription_starter, subscription_pro, subscription_enterprise
 * - tier_upgrade (pro-rated upgrade charges)
 * - requests (usage-based charges)
 * - extra_api_keys, extra_seal_keys, extra_allowlist_ips, extra_packages
 * - credit, tax
 *
 * serviceType uses serviceTypeEnum (service_type):
 * - seal, grpc, graphql
 *
 * Frontend formats display strings from this structured data.
 */
export const invoiceLineItems = pgTable('invoice_line_items', {
  lineItemId: serial('line_item_id').primaryKey(),
  billingRecordId: bigint('billing_record_id', { mode: 'number' }).notNull().references(() => billingRecords.id, { onDelete: 'cascade' }),

  // Semantic type - uses PostgreSQL ENUM for database-level validation
  itemType: invoiceLineItemTypeEnum('item_type').notNull(),

  // Service this line item belongs to (null for credits, taxes)
  // Uses existing service_type ENUM for consistency
  serviceType: serviceTypeEnum('service_type'),

  // Quantity and pricing
  // NOTE: For 'requests' items, unitPriceUsdCents is cents per 1000 requests (not per 1).
  // So quantity * unitPriceUsdCents != amountUsdCents. The authoritative charge is amountUsdCents,
  // computed as: Math.floor(quantity * unitPriceUsdCents / 1000).
  quantity: bigint('quantity', { mode: 'number' }).notNull().default(1),
  unitPriceUsdCents: bigint('unit_price_usd_cents', { mode: 'number' }).notNull(),
  amountUsdCents: bigint('amount_usd_cents', { mode: 'number' }).notNull(),

  // Optional: credit month name for credit line items
  creditMonth: varchar('credit_month', { length: 20 }),

  // Optional: extra context appended to semantic description (e.g., "Pro → Enterprise" for tier upgrades)
  description: varchar('description', { length: 100 }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idxLineItemsBilling: index('idx_line_items_billing').on(table.billingRecordId),
}));
