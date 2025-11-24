import { pgTable, serial, integer, uuid, bigint, varchar, text, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';
import { billingRecords, escrowTransactions } from './escrow';
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
  reason: varchar('reason', { length: 50 }).notNull(), // 'outage' | 'promo' | 'goodwill' | 'reconciliation'
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
 * MVP supports:
 * - credit (customer_credits)
 * - escrow (escrow_transactions)
 *
 * Phase 3 will add:
 * - stripe (Stripe payment IDs)
 */
export const invoicePayments = pgTable('invoice_payments', {
  paymentId: serial('payment_id').primaryKey(),
  billingRecordId: uuid('billing_record_id').notNull().references(() => billingRecords.id),

  // Payment source (MVP: credit or escrow only)
  sourceType: varchar('source_type', { length: 20 }).notNull(), // 'credit' | 'escrow' | 'stripe' (Phase 3)

  // Foreign keys to payment sources (exactly one must be set based on sourceType)
  creditId: integer('credit_id').references(() => customerCredits.creditId),
  escrowTransactionId: bigint('escrow_transaction_id', { mode: 'number' }).references(() => escrowTransactions.txId),
  // Phase 3: stripePaymentId: varchar('stripe_payment_id', { length: 100 })

  // Amount applied from this source
  amountUsdCents: bigint('amount_usd_cents', { mode: 'number' }).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idxPaymentBillingRecord: index('idx_payment_billing_record').on(table.billingRecordId),
  idxPaymentCredit: index('idx_payment_credit').on(table.creditId).where(sql`${table.creditId} IS NOT NULL`),
  idxPaymentEscrow: index('idx_payment_escrow').on(table.escrowTransactionId).where(sql`${table.escrowTransactionId} IS NOT NULL`),

  // Ensure only one reference is set based on source_type
  checkSourceTypeMatch: check('check_source_type_match', sql`
    (${table.sourceType} = 'credit' AND ${table.creditId} IS NOT NULL AND ${table.escrowTransactionId} IS NULL) OR
    (${table.sourceType} = 'escrow' AND ${table.escrowTransactionId} IS NOT NULL AND ${table.creditId} IS NULL)
  `),
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
  billingRecordId: uuid('billing_record_id').references(() => billingRecords.id),
  response: text('response').notNull(), // JSON-encoded response
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idxIdempotencyCreated: index('idx_idempotency_created').on(table.createdAt), // For cleanup of old entries
}));

/**
 * Invoice Line Items Table (Optional)
 *
 * Stores itemized invoice details as separate rows instead of JSONB.
 * Provides better queryability and type safety.
 *
 * Note: billing_records currently uses JSONB for line_items.
 * This table is for future migration to relational model.
 */
export const invoiceLineItems = pgTable('invoice_line_items', {
  lineItemId: serial('line_item_id').primaryKey(),
  billingRecordId: uuid('billing_record_id').notNull().references(() => billingRecords.id, { onDelete: 'cascade' }),
  description: text('description').notNull(),
  amountUsdCents: bigint('amount_usd_cents', { mode: 'number' }).notNull(),
  serviceType: varchar('service_type', { length: 20 }), // Optional: link to service_type enum
  quantity: integer('quantity').default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idxLineItemsBilling: index('idx_line_items_billing').on(table.billingRecordId),
}));
