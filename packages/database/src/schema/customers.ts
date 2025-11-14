import { pgTable, integer, varchar, bigint, date, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { FIELD_LIMITS } from '@suiftly/shared/constants';

/**
 * Customers table schema
 *
 * IMPORTANT NOTE ON FIELD NAMING:
 * Several fields use "monthly" terminology (maxMonthlyUsdCents, currentMonthChargedUsdCents, etc.)
 * but actually track 28-day rolling periods, NOT calendar months.
 *
 * This is a legacy naming decision made before finalizing the 28-day period design.
 * The field names are kept as-is to avoid breaking changes and database migrations.
 *
 * Actual behavior (see CONSTANTS.md):
 * - maxMonthlyUsdCents: 28-day spending limit (default $250, min $10)
 * - currentMonthChargedUsdCents: Amount charged in current 28-day period
 * - currentMonthStart: Start of current 28-day period (NOT calendar month)
 * - lastMonthChargedUsdCents: Amount charged in previous 28-day period
 */
export const customers = pgTable('customers', {
  customerId: integer('customer_id').primaryKey(),
  walletAddress: varchar('wallet_address', { length: FIELD_LIMITS.SUI_ADDRESS }).notNull().unique(),
  escrowContractId: varchar('escrow_contract_id', { length: FIELD_LIMITS.SUI_ADDRESS }),
  status: varchar('status', { length: FIELD_LIMITS.CUSTOMER_STATUS }).notNull().default('active'),
  maxMonthlyUsdCents: bigint('max_monthly_usd_cents', { mode: 'number' }), // 28-day spending limit (see note above)
  currentBalanceUsdCents: bigint('current_balance_usd_cents', { mode: 'number' }),
  currentMonthChargedUsdCents: bigint('current_month_charged_usd_cents', { mode: 'number' }), // Charged this 28-day period
  lastMonthChargedUsdCents: bigint('last_month_charged_usd_cents', { mode: 'number' }), // Charged last 28-day period
  currentMonthStart: date('current_month_start'), // Start of current 28-day period
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  idxWallet: index('idx_wallet').on(table.walletAddress),
  idxCustomerStatus: index('idx_customer_status').on(table.status).where(sql`${table.status} != 'active'`),
  checkCustomerId: check('check_customer_id', sql`${table.customerId} != 0`),
  checkStatus: check('check_status', sql`${table.status} IN ('active', 'suspended', 'closed')`),
}));
