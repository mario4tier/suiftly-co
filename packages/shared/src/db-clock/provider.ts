/**
 * Database clock provider for managing clock implementations
 *
 * Switches between real and mock clocks based on environment and testing needs.
 *
 * Cross-Process Sync (test_kv mode):
 * - When enabled, clock time is read from the test_kv table in the database
 * - GM writes mock time to test_kv, all other processes read from it
 * - This ensures all processes (API, GM) use the same mock time
 */

import type { DBClock, MockDBClockConfig } from './types';
import { RealDBClock } from './real-clock';
import { MockDBClock } from './mock-clock';

/**
 * Function type for reading mock clock state from database
 * Injected to avoid circular dependency with database package
 */
export type MockClockStateReader = () => Promise<{
  mockTime: string | null;
  autoAdvance: boolean;
  timeScale: number;
} | null>;

/**
 * Function type for writing mock clock state to database
 */
export type MockClockStateWriter = (state: {
  mockTime: string | null;
  autoAdvance: boolean;
  timeScale: number;
}) => Promise<void>;

export class DBClockProvider {
  private static instance: DBClockProvider;
  private clock: DBClock;
  private isMocked: boolean = false;

  // test_kv sync support
  private testKvReader: MockClockStateReader | null = null;
  private testKvWriter: MockClockStateWriter | null = null;
  private testKvSyncEnabled: boolean = false;

  private constructor() {
    // Default to real clock
    this.clock = new RealDBClock();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): DBClockProvider {
    if (!DBClockProvider.instance) {
      DBClockProvider.instance = new DBClockProvider();
    }
    return DBClockProvider.instance;
  }

  /**
   * Get current database clock
   */
  getClock(): DBClock {
    return this.clock;
  }

  /**
   * Switch to real database clock (production)
   */
  useRealClock(): void {
    this.clock = new RealDBClock();
    this.isMocked = false;
  }

  /**
   * Switch to mock database clock (testing)
   */
  useMockClock(config?: MockDBClockConfig): MockDBClock {
    const mockClock = new MockDBClock(config);
    this.clock = mockClock;
    this.isMocked = true;
    return mockClock;
  }

  /**
   * Get mock clock if currently using one
   */
  getMockClock(): MockDBClock | null {
    if (this.isMocked && this.clock instanceof MockDBClock) {
      return this.clock;
    }
    return null;
  }

  /**
   * Check if using mock clock
   */
  isUsingMockClock(): boolean {
    return this.isMocked;
  }

  /**
   * Reset to real clock
   */
  reset(): void {
    this.useRealClock();
  }

  // =========================================================================
  // test_kv Cross-Process Sync
  // =========================================================================

  /**
   * Configure test_kv sync functions
   * Called during app initialization to inject database functions
   */
  configureTestKvSync(
    reader: MockClockStateReader,
    writer: MockClockStateWriter
  ): void {
    this.testKvReader = reader;
    this.testKvWriter = writer;
  }

  /**
   * Enable test_kv sync mode
   * When enabled, syncFromTestKv() will read mock time from database
   */
  enableTestKvSync(): void {
    this.testKvSyncEnabled = true;
  }

  /**
   * Disable test_kv sync mode
   */
  disableTestKvSync(): void {
    this.testKvSyncEnabled = false;
  }

  /**
   * Check if test_kv sync is enabled
   */
  isTestKvSyncEnabled(): boolean {
    return this.testKvSyncEnabled;
  }

  /**
   * Sync clock state from test_kv table
   *
   * Call this before operations that need the current mock time.
   * If mock time is set in test_kv, switches to mock clock.
   * If no mock time, switches to real clock.
   */
  async syncFromTestKv(): Promise<void> {
    if (!this.testKvSyncEnabled || !this.testKvReader) {
      return;
    }

    try {
      const state = await this.testKvReader();

      if (state?.mockTime) {
        // Switch to mock clock with time from test_kv
        const mockTime = new Date(state.mockTime);
        if (!isNaN(mockTime.getTime())) {
          this.useMockClock({
            currentTime: mockTime,
            autoAdvance: state.autoAdvance,
            timeScale: state.timeScale,
          });
        }
      } else {
        // No mock time in DB, use real clock
        this.useRealClock();
      }
    } catch (error) {
      // On error, use real clock
      console.warn('[DBClockProvider] Failed to sync from test_kv:', error);
      this.useRealClock();
    }
  }

  /**
   * Write current mock clock state to test_kv
   *
   * Call this after setting mock time to persist for other processes.
   */
  async writeToTestKv(): Promise<void> {
    if (!this.testKvWriter) {
      return;
    }

    try {
      if (this.isMocked && this.clock instanceof MockDBClock) {
        const config = this.clock.getConfig();
        await this.testKvWriter({
          mockTime: config.currentTime?.toISOString() ?? null,
          autoAdvance: config.autoAdvance ?? false,
          timeScale: config.timeScale ?? 1.0,
        });
      } else {
        // Clear mock time in test_kv
        await this.testKvWriter({
          mockTime: null,
          autoAdvance: false,
          timeScale: 1.0,
        });
      }
    } catch (error) {
      console.warn('[DBClockProvider] Failed to write to test_kv:', error);
    }
  }

  /**
   * Set mock clock and write to test_kv
   *
   * Convenience method for GM to set mock time and persist it.
   */
  async useMockClockAndSync(config?: MockDBClockConfig): Promise<MockDBClock> {
    const mockClock = this.useMockClock(config);
    await this.writeToTestKv();
    return mockClock;
  }

  /**
   * Reset to real clock and clear test_kv
   */
  async useRealClockAndSync(): Promise<void> {
    this.useRealClock();
    await this.writeToTestKv();
  }
}

// Singleton provider instance
export const dbClockProvider = DBClockProvider.getInstance();

/**
 * Database clock instance
 *
 * IMPORTANT: This is a proxy that always returns the current clock.
 * It will automatically use mock clock during tests when configured.
 *
 * ```typescript
 * import { dbClock } from '@suiftly/shared/db-clock';
 *
 * const timestamp = dbClock.now(); // For createdAt, updatedAt, etc.
 * const startOfDay = dbClock.today(); // For billing period calculations
 * ```
 */
export const dbClock: DBClock = new Proxy({} as DBClock, {
  get(target, prop) {
    const clock = dbClockProvider.getClock();
    return (clock as any)[prop];
  }
});

/**
 * Get current database clock (fresh reference)
 * Use when clock might have been swapped
 */
export function getDBClock(): DBClock {
  return dbClockProvider.getClock();
}