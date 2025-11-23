/**
 * Example test demonstrating DBClock usage
 *
 * This shows how tests should control database timestamps through the API,
 * NOT by importing DBClock directly.
 */

import { test, expect } from '../fixtures/base-test';
import {
  setMockClock,
  advanceClock,
  setClockTime,
  getClockStatus,
  getBillingPeriodInfo,
} from '../helpers/clock';
import { resetCustomer } from '../helpers/db';

test.describe('DBClock Test Examples', () => {
  test.beforeEach(async ({ request }) => {
    // The base-test fixture already resets the clock to real time
    // Reset customer for clean state
    await resetCustomer(request);
  });

  test('clock is reset to real time by default', async ({ request }) => {
    // Clock should be real time (reset by base-test fixture)
    const status = await getClockStatus(request);
    expect(status.type).toBe('real');
  });

  test('can control time for grace period testing', async ({ request, page }) => {
    // Set initial time when payment was made
    const paymentDate = '2024-01-01T00:00:00Z';
    await setMockClock(request, paymentDate);

    // Verify we're using mock time
    const status = await getClockStatus(request);
    expect(status.type).toBe('mock');
    expect(status.currentTime).toBe('2024-01-01T00:00:00.000Z');

    // Simulate customer making a payment
    // ... your payment logic here ...

    // Fast-forward 13 days (still within 14-day grace period)
    await advanceClock(request, { days: 13 });
    const midGraceStatus = await getClockStatus(request);
    expect(new Date(midGraceStatus.currentTime).toISOString()).toBe('2024-01-14T00:00:00.000Z');

    // At this point, service should still be active (within grace period)
    // ... verify service is active ...

    // Fast-forward 2 more days (total 15 days - grace period expired)
    await advanceClock(request, { days: 2 });
    const expiredStatus = await getClockStatus(request);
    expect(new Date(expiredStatus.currentTime).toISOString()).toBe('2024-01-16T00:00:00.000Z');

    // Now service should be suspended (grace period expired)
    // ... verify service is suspended ...
  });

  test('can test billing period transitions', async ({ request }) => {
    // Set customer creation date
    const customerCreatedAt = '2024-01-01T00:00:00Z';
    await setMockClock(request, customerCreatedAt);

    // Check initial period
    let periodInfo = await getBillingPeriodInfo(request, customerCreatedAt);
    expect(periodInfo.daysElapsed).toBe(0);
    expect(periodInfo.daysRemaining).toBe(28);
    expect(periodInfo.start).toBe('2024-01-01T00:00:00.000Z');
    expect(periodInfo.end).toBe('2024-01-29T00:00:00.000Z');

    // Jump to middle of period
    await setClockTime(request, '2024-01-15T12:00:00Z');
    periodInfo = await getBillingPeriodInfo(request, customerCreatedAt);
    expect(periodInfo.daysElapsed).toBe(14);
    expect(periodInfo.daysRemaining).toBe(14);

    // Jump to last day of period
    await setClockTime(request, '2024-01-28T23:59:59Z');
    periodInfo = await getBillingPeriodInfo(request, customerCreatedAt);
    expect(periodInfo.daysElapsed).toBe(27);
    expect(periodInfo.daysRemaining).toBe(1);

    // Jump to new period
    await setClockTime(request, '2024-01-29T00:00:01Z');
    periodInfo = await getBillingPeriodInfo(request, customerCreatedAt);
    expect(periodInfo.daysElapsed).toBe(0);
    expect(periodInfo.daysRemaining).toBe(28);
    expect(periodInfo.start).toBe('2024-01-29T00:00:00.000Z');
    expect(periodInfo.end).toBe('2024-02-26T00:00:00.000Z');
  });

  test('can use auto-advancing clock for real-time simulation', async ({ request }) => {
    // Set mock clock with auto-advance at 100x speed
    await setMockClock(request, '2024-01-01T00:00:00Z', {
      autoAdvance: true,
      timeScale: 100, // 100x speed
    });

    const startStatus = await getClockStatus(request);
    const startTime = new Date(startStatus.currentTime).getTime();

    // Wait 100ms real time = 10 seconds simulated time
    await new Promise(resolve => setTimeout(resolve, 100));

    const endStatus = await getClockStatus(request);
    const endTime = new Date(endStatus.currentTime).getTime();

    const elapsedMs = endTime - startTime;
    // Should be approximately 10 seconds (10000ms) simulated
    expect(elapsedMs).toBeGreaterThan(9000);
    expect(elapsedMs).toBeLessThan(11000);
  });

  test('clock resets between tests', async ({ request, page }) => {
    // This test runs after the others, but clock should be real time again
    // (reset by base-test fixture - which requires page fixture to be used)
    const status = await getClockStatus(request);
    expect(status.type).toBe('real');

    // Current time should be close to actual system time
    const now = Date.now();
    const clockTime = new Date(status.currentTime).getTime();
    const diff = Math.abs(now - clockTime);
    expect(diff).toBeLessThan(1000); // Within 1 second of real time
  });
});

test.describe('Integration with Billing Features', () => {
  test.skip('should calculate pro-rated charges based on mock time', async ({ request, page }) => {
    // This is a placeholder for actual billing tests
    // Shows how billing tests would use the clock

    const customerCreatedAt = '2024-01-01T00:00:00Z';

    // Set to middle of billing period
    await setMockClock(request, '2024-01-15T00:00:00Z');

    // Get period info
    const periodInfo = await getBillingPeriodInfo(request, customerCreatedAt);
    expect(periodInfo.daysRemaining).toBe(14);

    // Pro-rated charge should be 50% of monthly rate
    // $28.00 monthly * (14/28 days) = $14.00
    const monthlyRate = 2800; // cents
    const proRatedAmount = Math.round(monthlyRate * periodInfo.daysRemaining / 28);
    expect(proRatedAmount).toBe(1400);
  });

  test.skip('should handle year transitions correctly', async ({ request }) => {
    // Customer created mid-December
    const customerCreatedAt = '2023-12-15T00:00:00Z';

    // Jump to January (crosses year boundary)
    await setMockClock(request, '2024-01-12T00:00:00Z');

    const periodInfo = await getBillingPeriodInfo(request, customerCreatedAt);
    // Second period should start Jan 12, 2024
    expect(periodInfo.start).toBe('2024-01-12T00:00:00.000Z');
    expect(periodInfo.end).toBe('2024-02-09T00:00:00.000Z');
  });
});