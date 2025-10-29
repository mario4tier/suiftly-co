import { pgTable, integer, varchar, bigint, date, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const customers = pgTable('customers', {
  customerId: integer('customer_id').primaryKey(),
  walletAddress: varchar('wallet_address', { length: 66 }).notNull().unique(),
  escrowContractId: varchar('escrow_contract_id', { length: 66 }),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  maxMonthlyUsdCents: bigint('max_monthly_usd_cents', { mode: 'number' }),
  currentBalanceUsdCents: bigint('current_balance_usd_cents', { mode: 'number' }),
  currentMonthChargedUsdCents: bigint('current_month_charged_usd_cents', { mode: 'number' }),
  lastMonthChargedUsdCents: bigint('last_month_charged_usd_cents', { mode: 'number' }),
  currentMonthStart: date('current_month_start'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  idxWallet: index('idx_wallet').on(table.walletAddress),
  idxCustomerStatus: index('idx_customer_status').on(table.status).where(sql`${table.status} != 'active'`),
  checkCustomerId: check('check_customer_id', sql`${table.customerId} > 0`),
  checkStatus: check('check_status', sql`${table.status} IN ('active', 'suspended', 'closed')`),
}));
