import { pgTable, bigserial, uuid, integer, varchar, bigint, decimal, timestamp, index, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';

export const escrowTransactions = pgTable('escrow_transactions', {
  txId: bigserial('tx_id', { mode: 'number' }).primaryKey(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  txDigest: varchar('tx_digest', { length: 64 }).notNull().unique(),
  txType: varchar('tx_type', { length: 20 }).notNull(),
  amount: decimal('amount', { precision: 20, scale: 8 }).notNull(),
  assetType: varchar('asset_type', { length: 66 }),
  timestamp: timestamp('timestamp').notNull(),
}, (table) => ({
  idxCustomer: index('idx_customer').on(table.customerId),
  idxTxDigest: index('idx_tx_digest').on(table.txDigest),
}));

export const ledgerEntries = pgTable('ledger_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  type: varchar('type', { length: 20 }).notNull(),
  amountUsdCents: bigint('amount_usd_cents', { mode: 'number' }).notNull(),
  amountSuiMist: bigint('amount_sui_mist', { mode: 'number' }),
  suiUsdRateCents: bigint('sui_usd_rate_cents', { mode: 'number' }),
  txHash: varchar('tx_hash', { length: 66 }),
  description: text('description'),
  invoiceId: varchar('invoice_id', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idxCustomerCreated: index('idx_customer_created').on(table.customerId, table.createdAt),
  idxTxHash: index('idx_tx_hash').on(table.txHash).where(sql`${table.txHash} IS NOT NULL`),
}));

export const billingRecords = pgTable('billing_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  billingPeriodStart: timestamp('billing_period_start').notNull(),
  billingPeriodEnd: timestamp('billing_period_end').notNull(),
  amountUsdCents: bigint('amount_usd_cents', { mode: 'number' }).notNull(),
  type: varchar('type', { length: 20 }).notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  txDigest: varchar('tx_digest', { length: 64 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  idxCustomerPeriod: index('idx_customer_period').on(table.customerId, table.billingPeriodStart),
  idxStatus: index('idx_status').on(table.status).where(sql`${table.status} != 'paid'`),
}));
