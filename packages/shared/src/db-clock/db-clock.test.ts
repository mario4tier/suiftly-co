/**
 * Tests for database clock implementations
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RealDBClock } from './real-clock';
import { MockDBClock } from './mock-clock';
import { DBClockProvider } from './provider';

describe('RealDBClock', () => {
  let clock: RealDBClock;

  beforeEach(() => {
    clock = new RealDBClock();
  });

  it('should return current timestamp', () => {
    const before = Date.now();
    const now = clock.now();
    const after = Date.now();

    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(after);
  });

  it('should return today with time zeroed (UTC)', () => {
    const today = clock.today();
    // Use UTC methods since today() returns UTC midnight
    expect(today.getUTCHours()).toBe(0);
    expect(today.getUTCMinutes()).toBe(0);
    expect(today.getUTCSeconds()).toBe(0);
    expect(today.getUTCMilliseconds()).toBe(0);
  });

  it('should calculate days until future date', () => {
    const futureDate = new Date(clock.now().getTime() + 7 * 24 * 60 * 60 * 1000);
    const daysUntil = clock.daysUntil(futureDate);
    expect(daysUntil).toBeGreaterThanOrEqual(6);
    expect(daysUntil).toBeLessThanOrEqual(7);
  });

  it('should add days correctly', () => {
    const now = clock.now();
    const in5Days = clock.addDays(5);
    const daysDiff = (in5Days.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(Math.round(daysDiff)).toBe(5);
  });

  it('should add hours correctly', () => {
    const now = clock.now();
    const in3Hours = clock.addHours(3);
    const hoursDiff = (in3Hours.getTime() - now.getTime()) / (1000 * 60 * 60);
    expect(Math.round(hoursDiff)).toBe(3);
  });

  it('should add days to specific date', () => {
    const baseDate = new Date('2024-06-15T12:00:00Z');
    const result = clock.addDaysTo(baseDate, 10);
    const expected = new Date('2024-06-25T12:00:00Z');
    expect(result.toISOString()).toBe(expected.toISOString());
  });
});

describe('MockDBClock', () => {
  let clock: MockDBClock;

  beforeEach(() => {
    clock = new MockDBClock({
      currentTime: new Date('2024-06-15T12:00:00Z'),
      autoAdvance: false,
    });
  });

  it('should return mocked time when frozen', () => {
    const time1 = clock.now();
    const time2 = clock.now();
    expect(time1.toISOString()).toBe('2024-06-15T12:00:00.000Z');
    expect(time2.toISOString()).toBe(time1.toISOString());
  });

  it('should advance time when configured', async () => {
    clock.setConfig({ autoAdvance: true, timeScale: 1000 }); // 1000x speed

    const time1 = clock.now();
    await new Promise(resolve => setTimeout(resolve, 10)); // Wait 10ms
    const time2 = clock.now();

    const diffMs = time2.getTime() - time1.getTime();
    expect(diffMs).toBeGreaterThanOrEqual(9000); // At least 9 seconds (10ms * 1000)
    expect(diffMs).toBeLessThanOrEqual(15000); // At most 15 seconds
  });

  it('should set time correctly', () => {
    const newTime = new Date('2024-12-25T00:00:00Z');
    clock.setTime(newTime);
    expect(clock.now().toISOString()).toBe('2024-12-25T00:00:00.000Z');
  });

  it('should advance by days', () => {
    clock.advanceDays(5);
    expect(clock.now().toISOString()).toBe('2024-06-20T12:00:00.000Z');
  });

  it('should advance by hours', () => {
    clock.advanceHours(3);
    expect(clock.now().toISOString()).toBe('2024-06-15T15:00:00.000Z');
  });

  it('should advance by minutes', () => {
    clock.advanceMinutes(30);
    expect(clock.now().toISOString()).toBe('2024-06-15T12:30:00.000Z');
  });

  it('should calculate days until correctly', () => {
    const futureDate = new Date('2024-06-20T12:00:00Z');
    expect(clock.daysUntil(futureDate)).toBe(5);

    const pastDate = new Date('2024-06-10T12:00:00Z');
    expect(clock.daysUntil(pastDate)).toBe(-5);
  });

  it('should add days to current time', () => {
    const result = clock.addDays(10);
    expect(result.toISOString()).toBe('2024-06-25T12:00:00.000Z');
  });

  it('should add hours to current time', () => {
    const result = clock.addHours(6);
    expect(result.toISOString()).toBe('2024-06-15T18:00:00.000Z');
  });

  it('should add days to specific date', () => {
    const baseDate = new Date('2024-01-01T00:00:00Z');
    const result = clock.addDaysTo(baseDate, 28);
    expect(result.toISOString()).toBe('2024-01-29T00:00:00.000Z');
  });
});

describe('DBClockProvider', () => {
  let provider: DBClockProvider;

  beforeEach(() => {
    provider = DBClockProvider.getInstance();
    provider.reset();
  });

  it('should be a singleton', () => {
    const provider1 = DBClockProvider.getInstance();
    const provider2 = DBClockProvider.getInstance();
    expect(provider1).toBe(provider2);
  });

  it('should default to real clock', () => {
    expect(provider.isUsingMockClock()).toBe(false);
    expect(provider.getMockClock()).toBeNull();
  });

  it('should switch to mock clock', () => {
    const mockTime = new Date('2024-06-15T00:00:00Z');
    const mockClock = provider.useMockClock({ currentTime: mockTime });

    expect(provider.isUsingMockClock()).toBe(true);
    expect(provider.getMockClock()).toBe(mockClock);
    expect(provider.getClock().now().toISOString()).toBe('2024-06-15T00:00:00.000Z');
  });

  it('should switch back to real clock', () => {
    provider.useMockClock({ currentTime: new Date('2024-06-15T00:00:00Z') });
    expect(provider.isUsingMockClock()).toBe(true);

    provider.useRealClock();
    expect(provider.isUsingMockClock()).toBe(false);
    expect(provider.getMockClock()).toBeNull();
  });
});

describe('DBClock Proxy Export', () => {
  it('should dynamically use current clock through proxy', async () => {
    const provider = DBClockProvider.getInstance();
    provider.reset();

    // Import the proxy export
    const providerModule = await import('./provider');
    const { dbClock } = providerModule;

    // Should use real clock initially
    const realTime1 = dbClock.now();
    expect(realTime1).toBeInstanceOf(Date);

    // Switch to mock clock
    provider.useMockClock({ currentTime: new Date('2024-06-15T12:00:00Z') });

    // Proxy should now use mock clock
    const mockTime = dbClock.now();
    expect(mockTime.toISOString()).toBe('2024-06-15T12:00:00.000Z');

    // Switch back to real clock
    provider.useRealClock();

    // Proxy should use real clock again
    const realTime2 = dbClock.now();
    expect(realTime2.getTime()).toBeGreaterThan(mockTime.getTime());
  });
});