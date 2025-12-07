/**
 * Clock Sync Integration Test
 *
 * Verifies that mock clock time set via GM is correctly synced to the API server
 * via the test_kv table.
 *
 * This tests the cross-process clock sync mechanism:
 * 1. GM writes mock time to test_kv
 * 2. API reads from test_kv before each protected request
 * 3. Both processes see the same time
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setClockTime, resetClock, getClockStatus } from './helpers/http';

const API_BASE = 'http://localhost:22700';

describe('Clock Sync (GM → test_kv → API)', () => {
  beforeEach(async () => {
    // Reset to real clock before each test
    await resetClock();
  });

  afterEach(async () => {
    // Always reset to real clock after tests
    await resetClock();
  });

  it('should sync mock time from GM to API via test_kv', async () => {
    // 1. Set a specific mock time via GM
    const mockTime = '2025-06-15T10:30:00.000Z';
    await setClockTime(mockTime);

    // 2. Verify GM reports the correct time
    const gmStatus = await getClockStatus();
    expect(gmStatus.type).toBe('mock');
    expect(gmStatus.currentTime).toBe(mockTime);

    // 3. Call API's billing period endpoint which uses dbClock
    const response = await fetch(`${API_BASE}/test/billing/period?createdAt=2025-01-01T00:00:00.000Z`);
    expect(response.ok).toBe(true);

    const billingPeriod = await response.json();

    // 4. The API's currentTime should match what GM set
    expect(billingPeriod.currentTime).toBe(mockTime);
  });

  it('should update when GM advances the clock', async () => {
    // 1. Set initial mock time
    const initialTime = '2025-01-01T00:00:00.000Z';
    await setClockTime(initialTime);

    // 2. Verify initial time
    const response1 = await fetch(`${API_BASE}/test/billing/period?createdAt=2025-01-01T00:00:00.000Z`);
    const period1 = await response1.json();
    expect(period1.currentTime).toBe(initialTime);

    // 3. Advance clock by 14 days via GM
    const advanceResponse = await fetch('http://localhost:22600/api/test/clock/advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: 14 }),
    });
    expect(advanceResponse.ok).toBe(true);

    // 4. Verify API sees the advanced time
    const response2 = await fetch(`${API_BASE}/test/billing/period?createdAt=2025-01-01T00:00:00.000Z`);
    const period2 = await response2.json();

    // Should be 14 days later
    const expectedTime = new Date('2025-01-15T00:00:00.000Z');
    const actualTime = new Date(period2.currentTime);
    expect(actualTime.getTime()).toBe(expectedTime.getTime());
  });

  it('should reset to real time when GM resets', async () => {
    // 1. Set mock time
    await setClockTime('2020-01-01T00:00:00.000Z');

    // 2. Verify mock time is active
    const gmStatus1 = await getClockStatus();
    expect(gmStatus1.type).toBe('mock');

    // 3. Reset to real time
    await resetClock();

    // 4. Verify GM reports real time
    const gmStatus2 = await getClockStatus();
    expect(gmStatus2.type).toBe('real');

    // 5. Verify API also sees real time (should be close to now)
    const response = await fetch(`${API_BASE}/test/billing/period?createdAt=2025-01-01T00:00:00.000Z`);
    const period = await response.json();

    const now = Date.now();
    const apiTime = new Date(period.currentTime).getTime();

    // Should be within 5 seconds of real time
    expect(Math.abs(now - apiTime)).toBeLessThan(5000);
  });

  it('should maintain time consistency across multiple API calls', async () => {
    // Set a fixed mock time
    const mockTime = '2025-03-15T12:00:00.000Z';
    await setClockTime(mockTime);

    // Make multiple API calls and verify they all see the same time
    const times: string[] = [];
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${API_BASE}/test/billing/period?createdAt=2025-01-01T00:00:00.000Z`);
      const period = await response.json();
      times.push(period.currentTime);
    }

    // All calls should return the same mock time
    expect(times[0]).toBe(mockTime);
    expect(times[1]).toBe(mockTime);
    expect(times[2]).toBe(mockTime);
  });
});
