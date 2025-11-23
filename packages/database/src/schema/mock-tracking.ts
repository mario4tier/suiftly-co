/**
 * Mock Tracking Objects Table
 *
 * Simulates the tracking objects created on the Sui blockchain.
 * In production, these would be actual on-chain objects owned by the user and Suiftly.
 *
 * When an escrow account is created, three objects are created atomically:
 * 1. Shared escrow account object (tracked in customers.escrowContractId)
 * 2. User tracking object (owned by user, points to escrow)
 * 3. Suiftly tracking object (owned by Suiftly, points to escrow)
 *
 * This enables multiple recovery paths:
 * - Primary: User reads their tracking object to find escrow
 * - Secondary: Query our database for escrow address
 * - Tertiary: Suiftly backend discovers its tracking objects
 *
 * IMPORTANT: This table is for MOCK ONLY, not used in production
 */

import { pgTable, bigserial, varchar, timestamp } from 'drizzle-orm/pg-core';

/**
 * Mock Tracking Objects
 *
 * Each row represents a tracking object that would exist on-chain.
 * These enable discovery of escrow accounts even if the client fails
 * to report the creation to our API.
 */
export const mockTrackingObjects = pgTable('mock_tracking_objects', {
  /** Auto-increment ID */
  id: bigserial('id', { mode: 'number' }).primaryKey(),

  /** Address of this tracking object (0x + 64 hex chars) */
  trackingAddress: varchar('tracking_address', { length: 66 }).notNull().unique(),

  /** Owner of this tracking object ('user' or 'suiftly') */
  owner: varchar('owner', { length: 10 }).notNull(),

  /** User's wallet address */
  userAddress: varchar('user_address', { length: 66 }).notNull(),

  /** Address of the shared escrow account this points to */
  escrowAddress: varchar('escrow_address', { length: 66 }).notNull(),

  /** Transaction digest that created this tracking object */
  createdByTx: varchar('created_by_tx', { length: 66 }).notNull(),

  /** When the tracking object was created */
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

  /** Whether this has been reconciled into the main database */
  reconciled: varchar('reconciled', { length: 5 }).notNull().default('false').$type<'true' | 'false'>(),

  /** When it was reconciled (if applicable) */
  reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
});

/**
 * Type for inserting mock tracking objects
 */
export type NewMockTrackingObject = typeof mockTrackingObjects.$inferInsert;

/**
 * Type for selected mock tracking objects
 */
export type MockTrackingObject = typeof mockTrackingObjects.$inferSelect;