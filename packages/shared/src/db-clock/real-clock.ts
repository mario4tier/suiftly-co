/**
 * Real database clock using system time
 *
 * Production implementation that returns actual system timestamps
 * for database storage.
 */

import type { DBClock } from './types';

export class RealDBClock implements DBClock {
  /**
   * Get current timestamp for database storage
   */
  now(): Date {
    return new Date();
  }

  /**
   * Get today's date with time zeroed (UTC)
   */
  today(): Date {
    const now = new Date();
    // Use UTC methods to avoid timezone issues
    const today = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0, 0, 0, 0
    ));
    return today;
  }

  /**
   * Calculate days until another date
   */
  daysUntil(otherDate: Date): number {
    const now = this.now();
    const diffMs = otherDate.getTime() - now.getTime();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  }

  /**
   * Add days to current timestamp
   */
  addDays(days: number): Date {
    const result = new Date(this.now());
    result.setDate(result.getDate() + days);
    return result;
  }

  /**
   * Add hours to current timestamp
   */
  addHours(hours: number): Date {
    const result = new Date(this.now());
    result.setHours(result.getHours() + hours);
    return result;
  }

  /**
   * Add days to specific date
   */
  addDaysTo(date: Date, days: number): Date {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  }
}

// Singleton instance for production
export const realDBClock = new RealDBClock();