/**
 * Mock Tables for Testing
 *
 * These tables are used ONLY by the mock Sui service to simulate blockchain behavior.
 * They are NOT used in production - real blockchain is the source of truth.
 *
 * Purpose:
 * - Simulate blockchain transaction history
 * - Allow tests to verify charges, deposits, withdrawals
 * - Provide deterministic test scenarios
 *
 * IMPORTANT:
 * - These tables should be TRUNCATED between test runs
 * - Production code should NEVER reference these tables
 * - Real Sui service implementation ignores these tables entirely
 */

import { pgTable, bigserial, integer, varchar, bigint, timestamp, text, boolean } from 'drizzle-orm/pg-core';
import { customers } from './customers';

/**
 * Mock transaction types
 * Matches the operations in ISuiService
 */
export type MockTxType = 'deposit' | 'withdraw' | 'charge' | 'credit';

/**
 * Mock Sui Transactions
 *
 * Simulates blockchain transaction history for testing.
 * Each row represents a simulated on-chain transaction.
 */
export const mockSuiTransactions = pgTable('mock_sui_transactions', {
  /** Auto-increment ID */
  id: bigserial('id', { mode: 'number' }).primaryKey(),

  /** Customer who owns the escrow account */
  customerId: integer('customer_id').notNull().references(() => customers.customerId),

  /** Simulated transaction digest (0x + 64 hex chars) */
  txDigest: varchar('tx_digest', { length: 66 }).notNull(),

  /** Transaction type */
  txType: varchar('tx_type', { length: 20 }).notNull().$type<MockTxType>(),

  /** Amount in USD cents */
  amountUsdCents: bigint('amount_usd_cents', { mode: 'number' }).notNull(),

  /** Description (for charges/credits) */
  description: text('description'),

  /** Whether transaction succeeded */
  success: boolean('success').notNull().default(true),

  /** Error message if failed */
  errorMessage: text('error_message'),

  /** Simulated checkpoint/block height */
  checkpoint: bigint('checkpoint', { mode: 'number' }),

  /** Balance after transaction (for audit trail) */
  balanceAfterUsdCents: bigint('balance_after_usd_cents', { mode: 'number' }),

  /** Spending limit at time of transaction */
  spendingLimitUsdCents: bigint('spending_limit_usd_cents', { mode: 'number' }),

  /** Period charged after transaction */
  periodChargedAfterUsdCents: bigint('period_charged_after_usd_cents', { mode: 'number' }),

  /** When the mock transaction was created */
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Type for inserting mock transactions
 */
export type NewMockSuiTransaction = typeof mockSuiTransactions.$inferInsert;

/**
 * Type for selecting mock transactions
 */
export type MockSuiTransaction = typeof mockSuiTransactions.$inferSelect;
