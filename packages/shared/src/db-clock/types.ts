/**
 * Database clock types for timestamp abstraction
 *
 * DBClock provides a unified source for timestamps that will be stored in the database,
 * allowing deterministic testing of date-based business logic.
 *
 * SCOPE: Database timestamps ONLY (createdAt, updatedAt, billing periods, grace periods, etc).
 * NOT for operational timeouts, HTTP timeouts, or other short-lived delays.
 */

/**
 * DBClock interface for database timestamp abstraction
 *
 * All methods return Date objects suitable for PostgreSQL TIMESTAMP columns.
 * Production uses RealDBClock (system time).
 * Tests use MockDBClock (controllable time).
 */
export interface DBClock {
  /**
   * Get the current timestamp for database storage
   * @returns Date object for TIMESTAMP columns
   */
  now(): Date;

  /**
   * Get today's date with time zeroed (00:00:00.000)
   * Useful for date-based calculations like billing periods
   */
  today(): Date;

  /**
   * Calculate days between now and another date
   * @param otherDate - Target date
   * @returns Days until date (negative if in past)
   */
  daysUntil(otherDate: Date): number;

  /**
   * Add days to current timestamp
   * @param days - Days to add (can be negative)
   * @returns New date for database storage
   */
  addDays(days: number): Date;

  /**
   * Add hours to current timestamp
   * Useful for testing within-day transitions
   * @param hours - Hours to add (can be negative)
   * @returns New date for database storage
   */
  addHours(hours: number): Date;

  /**
   * Add days to a specific date
   * @param date - Base date
   * @param days - Days to add
   * @returns New date for database storage
   */
  addDaysTo(date: Date, days: number): Date;
}

/**
 * Configuration for MockDBClock
 */
export interface MockDBClockConfig {
  /**
   * The mocked current time
   * If not set, uses actual system time
   */
  currentTime?: Date;

  /**
   * If true, time advances normally from the mocked time
   * If false, time is frozen at the mocked time
   */
  autoAdvance?: boolean;

  /**
   * Rate at which time advances (1.0 = real time, 100.0 = 100x speed)
   * Only applies when autoAdvance is true
   * Useful for testing long periods in short time
   */
  timeScale?: number;
}