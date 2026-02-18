import { pgTable, integer, varchar, bigint, date, timestamp, index, check, boolean } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { FIELD_LIMITS } from '@suiftly/shared/constants';
import { customerStatusEnum } from './enums';

/**
 * Customers table schema
 *
 * Billing fields track 28-day rolling periods (see CONSTANTS.md):
 * - spendingLimitUsdCents: 28-day spending limit (default $250, min $10, 0=unlimited)
 * - currentBalanceUsdCents: Escrow account balance (synced from blockchain/mock)
 * - currentPeriodChargedUsdCents: Amount charged in current 28-day period
 * - currentPeriodStart: Start of current 28-day period (date only, no time)
 */
export const customers = pgTable('customers', {
  customerId: integer('customer_id').primaryKey(),
  walletAddress: varchar('wallet_address', { length: FIELD_LIMITS.SUI_ADDRESS }).notNull().unique(),
  escrowContractId: varchar('escrow_contract_id', { length: FIELD_LIMITS.SUI_ADDRESS }),
  status: customerStatusEnum('status').notNull().default('active'),
  spendingLimitUsdCents: bigint('spending_limit_usd_cents', { mode: 'number' }).default(25000), // 28-day spending limit ($250 default from CONSTANTS.md)
  currentBalanceUsdCents: bigint('current_balance_usd_cents', { mode: 'number' }).default(0), // Escrow balance (synced from blockchain/mock)
  currentPeriodChargedUsdCents: bigint('current_period_charged_usd_cents', { mode: 'number' }).default(0), // Charged this 28-day period
  currentPeriodStart: date('current_period_start'), // Start of current 28-day period

  // Stripe account (one per customer, set once — like escrowContractId)
  stripeCustomerId: varchar('stripe_customer_id', { length: 100 }),

  // Billing state tracking (Phase 1A)
  paidOnce: boolean('paid_once').notNull().default(false), // Has customer ever paid anything?
  gracePeriodStart: date('grace_period_start'), // When grace period started (NULL = none)
  gracePeriodNotifiedAt: timestamp('grace_period_notified_at', { withTimezone: true, mode: 'date' }).array(), // Timestamps of reminder emails sent

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idxWallet: index('idx_wallet').on(table.walletAddress),
  idxCustomerStatus: index('idx_customer_status').on(table.status).where(sql`${table.status} != 'active'`),
  checkCustomerId: check('check_customer_id', sql`${table.customerId} != 0`),
  // Note: check_status constraint removed - PostgreSQL ENUM type provides validation
}));
