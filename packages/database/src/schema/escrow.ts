import { pgTable, bigserial, uuid, integer, varchar, bigint, decimal, timestamp, index, text, check } from 'drizzle-orm/pg-core';
import { bytea } from '../types/bytea';
import { sql } from 'drizzle-orm';
import { customers } from './customers';
import { FIELD_LIMITS } from '@suiftly/shared/constants';
import { transactionTypeEnum, billingRecordTypeEnum, billingStatusEnum, billingTypeEnum } from './enums';

/**
 * First invoice ID - billing_records sequence starts at this value.
 * Makes invoice numbers look professional from day one.
 */
export const FIRST_INVOICE_ID = 103405;

export const escrowTransactions = pgTable('escrow_transactions', {
  txId: bigserial('tx_id', { mode: 'number' }).primaryKey(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  txDigest: bytea('tx_digest').notNull().unique(),
  txType: transactionTypeEnum('tx_type').notNull(),
  // USD dollar amount (USDC on-chain). Stored as dollars, not cents,
  // because it represents the on-chain USDC transfer amount.
  amountUsd: decimal('amount_usd', { precision: 20, scale: 8 }).notNull(),
  assetType: varchar('asset_type', { length: FIELD_LIMITS.SUI_ADDRESS }),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
}, (table) => ({
  idxEscrowCustomer: index('idx_escrow_customer').on(table.customerId),
  idxEscrowTxDigest: index('idx_escrow_tx_digest').on(table.txDigest),
  checkTxDigestLength: check('check_tx_digest_length', sql`LENGTH(${table.txDigest}) = 32`),
}));

export const ledgerEntries = pgTable('ledger_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  type: transactionTypeEnum('type').notNull(),
  amountUsdCents: bigint('amount_usd_cents', { mode: 'number' }).notNull(),
  amountSuiMist: bigint('amount_sui_mist', { mode: 'number' }),
  suiUsdRateCents: bigint('sui_usd_rate_cents', { mode: 'number' }),
  txDigest: bytea('tx_digest'),
  description: text('description'),
  invoiceId: bigint('invoice_id', { mode: 'number' }), // References billing_records.id (forward reference not supported)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idxCustomerCreated: index('idx_customer_created').on(table.customerId, table.createdAt),
  idxLedgerTxDigest: index('idx_ledger_tx_digest').on(table.txDigest).where(sql`${table.txDigest} IS NOT NULL`),
  checkTxDigestLength: check('check_tx_digest_length', sql`${table.txDigest} IS NULL OR LENGTH(${table.txDigest}) = 32`),
}));

export const billingRecords = pgTable('billing_records', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  billingPeriodStart: timestamp('billing_period_start', { withTimezone: true }).notNull(),
  billingPeriodEnd: timestamp('billing_period_end', { withTimezone: true }).notNull(),
  amountUsdCents: bigint('amount_usd_cents', { mode: 'number' }).notNull(),
  type: billingRecordTypeEnum('type').notNull(),
  status: billingStatusEnum('status').notNull(),
  txDigest: bytea('tx_digest'),

  // Phase 1A: Invoice metadata and multi-source payment tracking
  dueDate: timestamp('due_date', { withTimezone: true }),

  // Billing type: immediate (upgrades, first sub) vs scheduled (monthly billing)
  // - immediate: Created BEFORE on-chain charge, voided on failure, needs reconciliation if stuck pending
  // - scheduled: From DRAFT, retry until paid
  // Default 'scheduled' for backward compatibility with existing records
  billingType: billingTypeEnum('billing_type').notNull().default('scheduled'),

  // Multi-source payment tracking (credits + escrow)
  amountPaidUsdCents: bigint('amount_paid_usd_cents', { mode: 'number' }).notNull().default(0), // Running total of payments received

  // Retry tracking for failed payments
  retryCount: integer('retry_count').default(0),
  lastRetryAt: timestamp('last_retry_at', { withTimezone: true }),
  failureReason: text('failure_reason'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

  // Tracks when DRAFT invoice was last checked/synced (usage sync, config changes)
  // Used to display "Updated X ago" in UI
  // Updated even if no changes were found (confirms data is fresh)
  lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true }),
}, (table) => ({
  idxCustomerPeriod: index('idx_customer_period').on(table.customerId, table.billingPeriodStart),
  idxBillingStatus: index('idx_billing_status').on(table.status).where(sql`${table.status} != 'paid'`),
  idxBillingTypeStatus: index('idx_billing_type_status').on(table.billingType, table.status).where(sql`${table.status} = 'pending'`),
  checkTxDigestLength: check('check_tx_digest_length', sql`${table.txDigest} IS NULL OR LENGTH(${table.txDigest}) = 32`),
}));
