/**
 * Database clock provider for managing clock implementations
 *
 * Switches between real and mock clocks based on environment and testing needs.
 */

import type { DBClock, MockDBClockConfig } from './types';
import { RealDBClock } from './real-clock';
import { MockDBClock } from './mock-clock';

export class DBClockProvider {
  private static instance: DBClockProvider;
  private clock: DBClock;
  private isMocked: boolean = false;

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