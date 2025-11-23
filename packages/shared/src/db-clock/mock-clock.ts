/**
 * Mock database clock for testing
 *
 * Allows precise control over timestamps for deterministic testing
 * of database-stored dates and date-based business logic.
 */

import type { DBClock, MockDBClockConfig } from './types';

export class MockDBClock implements DBClock {
  private mockedTime: Date;
  private autoAdvance: boolean;
  private timeScale: number;
  private startRealTime: number;
  private startMockedTime: number;

  constructor(config: MockDBClockConfig = {}) {
    this.mockedTime = config.currentTime || new Date();
    this.autoAdvance = config.autoAdvance || false;
    this.timeScale = config.timeScale || 1.0;
    this.startRealTime = Date.now();
    this.startMockedTime = this.mockedTime.getTime();
  }

  /**
   * Get current timestamp
   */
  now(): Date {
    if (this.autoAdvance) {
      // Calculate elapsed time since mock was created
      const realElapsed = Date.now() - this.startRealTime;
      const scaledElapsed = realElapsed * this.timeScale;
      return new Date(this.startMockedTime + scaledElapsed);
    }
    return new Date(this.mockedTime);
  }

  /**
   * Get today's date with time zeroed
   */
  today(): Date {
    const now = this.now();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    return today;
  }

  /**
   * Set the mocked time
   */
  setTime(time: Date): void {
    this.mockedTime = new Date(time);
    this.startRealTime = Date.now();
    this.startMockedTime = this.mockedTime.getTime();
  }

  /**
   * Advance time by milliseconds
   */
  advance(ms: number): void {
    const newTime = new Date(this.now().getTime() + ms);
    this.setTime(newTime);
  }

  /**
   * Advance time by days
   */
  advanceDays(days: number): void {
    this.advance(days * 24 * 60 * 60 * 1000);
  }

  /**
   * Advance time by hours
   */
  advanceHours(hours: number): void {
    this.advance(hours * 60 * 60 * 1000);
  }

  /**
   * Advance time by minutes (for finer control)
   */
  advanceMinutes(minutes: number): void {
    this.advance(minutes * 60 * 1000);
  }

  /**
   * Reset to specific time or current real time
   */
  reset(time?: Date): void {
    this.mockedTime = time || new Date();
    this.startRealTime = Date.now();
    this.startMockedTime = this.mockedTime.getTime();
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

  /**
   * Get current configuration
   */
  getConfig(): MockDBClockConfig {
    return {
      currentTime: new Date(this.mockedTime),
      autoAdvance: this.autoAdvance,
      timeScale: this.timeScale,
    };
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<MockDBClockConfig>): void {
    if (config.currentTime !== undefined) {
      this.setTime(config.currentTime);
    }
    if (config.autoAdvance !== undefined) {
      this.autoAdvance = config.autoAdvance;
    }
    if (config.timeScale !== undefined) {
      this.timeScale = config.timeScale;
    }
  }
}