/**
 * Test Key-Value Store Functions
 *
 * Provides read/write access to the test_kv table for cross-process state sharing.
 * Primary use case: Mock clock synchronization between API and Global Manager.
 *
 * IMPORTANT:
 * - This is for development/testing only
 * - Production should NEVER use these functions
 * - The table may exist in production but should remain empty
 */

import { db } from '../db';
import { testKv, TEST_KV_KEYS } from '../schema/test-kv';
import { eq } from 'drizzle-orm';
import { dbClock } from '@suiftly/shared/db-clock';

export { TEST_KV_KEYS };

/**
 * Get a value from test_kv
 */
export async function getTestKvValue(key: string): Promise<string | null> {
  const result = await db
    .select({ value: testKv.value })
    .from(testKv)
    .where(eq(testKv.key, key))
    .limit(1);

  return result[0]?.value ?? null;
}

/**
 * Set a value in test_kv (upsert)
 */
export async function setTestKvValue(key: string, value: string): Promise<void> {
  const now = dbClock.now();
  await db
    .insert(testKv)
    .values({
      key,
      value,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: testKv.key,
      set: {
        value,
        updatedAt: now,
      },
    });
}

/**
 * Delete a value from test_kv
 */
export async function deleteTestKvValue(key: string): Promise<void> {
  await db.delete(testKv).where(eq(testKv.key, key));
}

/**
 * Clear all test_kv entries (use with caution in tests)
 */
export async function clearTestKv(): Promise<void> {
  await db.delete(testKv);
}

// ============================================================================
// Mock Clock Specific Functions
// ============================================================================

export interface MockClockState {
  /** ISO timestamp for mock time, or null for real clock */
  mockTime: string | null;
  /** Auto-advance flag */
  autoAdvance: boolean;
  /** Time scale (1.0 = normal) */
  timeScale: number;
}

/**
 * Get mock clock state from test_kv
 *
 * Returns null if no mock clock is set (use real clock)
 */
export async function getMockClockState(): Promise<MockClockState | null> {
  const [timeValue, configValue] = await Promise.all([
    getTestKvValue(TEST_KV_KEYS.MOCK_CLOCK_TIME),
    getTestKvValue(TEST_KV_KEYS.MOCK_CLOCK_CONFIG),
  ]);

  // If no time set, use real clock
  if (!timeValue) {
    return null;
  }

  // Parse config or use defaults
  let config = { autoAdvance: false, timeScale: 1.0 };
  if (configValue) {
    try {
      config = JSON.parse(configValue);
    } catch {
      // Use defaults on parse error
    }
  }

  return {
    mockTime: timeValue,
    autoAdvance: config.autoAdvance ?? false,
    timeScale: config.timeScale ?? 1.0,
  };
}

/**
 * Set mock clock state in test_kv
 *
 * Called by GM to set mock time that all processes will read.
 */
export async function setMockClockState(state: MockClockState): Promise<void> {
  if (state.mockTime) {
    await Promise.all([
      setTestKvValue(TEST_KV_KEYS.MOCK_CLOCK_TIME, state.mockTime),
      setTestKvValue(TEST_KV_KEYS.MOCK_CLOCK_CONFIG, JSON.stringify({
        autoAdvance: state.autoAdvance,
        timeScale: state.timeScale,
      })),
    ]);
  } else {
    // Clear mock clock (return to real time)
    await clearMockClockState();
  }
}

/**
 * Clear mock clock state (return to real clock)
 */
export async function clearMockClockState(): Promise<void> {
  await Promise.all([
    deleteTestKvValue(TEST_KV_KEYS.MOCK_CLOCK_TIME),
    deleteTestKvValue(TEST_KV_KEYS.MOCK_CLOCK_CONFIG),
  ]);
}
