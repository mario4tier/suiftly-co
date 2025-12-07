/**
 * Test Key-Value Store
 *
 * A simple key-value table for sharing test state across processes.
 * Primary use case: Mock clock synchronization between API and Global Manager.
 *
 * IMPORTANT:
 * - This table exists in dev/test databases for cross-process state sharing
 * - Production: Table may exist but should NEVER be used (always empty)
 * - All keys are automatically prefixed to avoid collisions
 *
 * Usage:
 * - mock_clock_time: ISO timestamp for mock clock (set by API, read by GM)
 * - Other test-specific state as needed
 */

import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Test Key-Value Store Table
 *
 * Simple key-value for cross-process test state.
 * Keys should be namespaced (e.g., "clock:mock_time", "test:scenario_id")
 */
export const testKv = pgTable('test_kv', {
  /** Unique key (namespaced, e.g., "clock:mock_time") */
  key: text('key').primaryKey(),

  /** Value as string (caller handles serialization) */
  value: text('value').notNull(),

  /** Last update time (for debugging/monitoring) */
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Well-known keys for test_kv table
 */
export const TEST_KV_KEYS = {
  /** Mock clock time in ISO format, or empty string for real clock */
  MOCK_CLOCK_TIME: 'clock:mock_time',
  /** Mock clock config (autoAdvance, timeScale) as JSON */
  MOCK_CLOCK_CONFIG: 'clock:mock_config',
} as const;

export type TestKvKey = typeof TEST_KV_KEYS[keyof typeof TEST_KV_KEYS];

/**
 * Type for inserting test_kv rows
 */
export type NewTestKv = typeof testKv.$inferInsert;

/**
 * Type for selecting test_kv rows
 */
export type TestKv = typeof testKv.$inferSelect;
