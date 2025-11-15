import { pgTable, bigserial, uuid, integer, varchar, bigint, decimal, timestamp, index, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';
import { FIELD_LIMITS } from '@suiftly/shared/constants';
import { transactionTypeEnum, billingStatusEnum } from './enums';

export const escrowTransactions = pgTable('escrow_transactions', {
  txId: bigserial('tx_id', { mode: 'number' }).primaryKey(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  txDigest: varchar('tx_digest', { length: FIELD_LIMITS.SUI_TX_DIGEST }).notNull().unique(),
  txType: transactionTypeEnum('tx_type').notNull(),
  amount: decimal('amount', { precision: 20, scale: 8 }).notNull(),
  assetType: varchar('asset_type', { length: FIELD_LIMITS.SUI_ADDRESS }),
  timestamp: timestamp('timestamp').notNull(),
}, (table) => ({
  idxEscrowCustomer: index('idx_escrow_customer').on(table.customerId),
  idxEscrowTxDigest: index('idx_escrow_tx_digest').on(table.txDigest),
}));

export const ledgerEntries = pgTable('ledger_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  type: transactionTypeEnum('type').notNull(),
  amountUsdCents: bigint('amount_usd_cents', { mode: 'number' }).notNull(),
  amountSuiMist: bigint('amount_sui_mist', { mode: 'number' }),
  suiUsdRateCents: bigint('sui_usd_rate_cents', { mode: 'number' }),
  txHash: varchar('tx_hash', { length: FIELD_LIMITS.SUI_ADDRESS }),
  description: text('description'),
  invoiceId: varchar('invoice_id', { length: FIELD_LIMITS.INVOICE_ID }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idxCustomerCreated: index('idx_customer_created').on(table.customerId, table.createdAt),
  idxLedgerTxHash: index('idx_ledger_tx_hash').on(table.txHash).where(sql`${table.txHash} IS NOT NULL`),
}));

export const billingRecords = pgTable('billing_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  billingPeriodStart: timestamp('billing_period_start').notNull(),
  billingPeriodEnd: timestamp('billing_period_end').notNull(),
  amountUsdCents: bigint('amount_usd_cents', { mode: 'number' }).notNull(),
  type: transactionTypeEnum('type').notNull(),
  status: billingStatusEnum('status').notNull(),
  txDigest: varchar('tx_digest', { length: FIELD_LIMITS.SUI_TX_DIGEST }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  idxCustomerPeriod: index('idx_customer_period').on(table.customerId, table.billingPeriodStart),
  idxBillingStatus: index('idx_billing_status').on(table.status).where(sql`${table.status} != 'paid'`),
}));
