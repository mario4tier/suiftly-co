/**
 * Database clock test utilities
 * Helpers for controlling database timestamps in Playwright tests
 *
 * IMPORTANT: Tests should NOT import DBClock directly!
 * Instead, control time through these API endpoints.
 */

import type { APIRequestContext } from '@playwright/test';

const API_BASE = 'http://localhost:3000';

/**
 * Reset clock to use real system time
 *
 * This should be called in beforeEach() to ensure each test
 * starts with real time unless it specifically needs mock time.
 */
export async function resetClock(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${API_BASE}/test/clock/real`);

  if (!response.ok()) {
    throw new Error(`Failed to reset clock: ${await response.text()}`);
  }
}

/**
 * Enable mock clock with specific time
 *
 * @param request - Playwright request context
 * @param time - The time to set (Date or ISO string)
 * @param options - Additional mock clock options
 */
export async function setMockClock(
  request: APIRequestContext,
  time: Date | string,
  options?: {
    autoAdvance?: boolean;
    timeScale?: number;
  }
): Promise<void> {
  const response = await request.post(`${API_BASE}/test/clock/mock`, {
    data: {
      time: typeof time === 'string' ? time : time.toISOString(),
      autoAdvance: options?.autoAdvance || false,
      timeScale: options?.timeScale || 1.0,
    },
  });

  if (!response.ok()) {
    throw new Error(`Failed to set mock clock: ${await response.text()}`);
  }
}

/**
 * Advance mock clock by specified duration
 *
 * @param request - Playwright request context
 * @param duration - Duration to advance
 */
export async function advanceClock(
  request: APIRequestContext,
  duration: {
    days?: number;
    hours?: number;
    minutes?: number;
    seconds?: number;
    milliseconds?: number;
  }
): Promise<void> {
  const response = await request.post(`${API_BASE}/test/clock/advance`, {
    data: duration,
  });

  if (!response.ok()) {
    throw new Error(`Failed to advance clock: ${await response.text()}`);
  }
}

/**
 * Set mock clock to specific time
 *
 * @param request - Playwright request context
 * @param time - The time to set (Date or ISO string)
 */
export async function setClockTime(
  request: APIRequestContext,
  time: Date | string
): Promise<void> {
  const response = await request.post(`${API_BASE}/test/clock/set`, {
    data: {
      time: typeof time === 'string' ? time : time.toISOString(),
    },
  });

  if (!response.ok()) {
    throw new Error(`Failed to set clock time: ${await response.text()}`);
  }
}

/**
 * Get current clock status and time
 *
 * @param request - Playwright request context
 * @returns Clock status including type (real/mock) and current time
 */
export async function getClockStatus(
  request: APIRequestContext
): Promise<{
  type: 'real' | 'mock';
  currentTime: string;
  config?: any;
}> {
  const response = await request.get(`${API_BASE}/test/clock`);

  if (!response.ok()) {
    throw new Error(`Failed to get clock status: ${await response.text()}`);
  }

  return response.json();
}

/**
 * Get billing period info for testing
 *
 * @param request - Playwright request context
 * @param customerCreatedAt - When the customer was created
 * @returns Billing period information
 */
export async function getBillingPeriodInfo(
  request: APIRequestContext,
  customerCreatedAt: Date | string
): Promise<{
  start: string;
  end: string;
  daysInPeriod: number;
  daysElapsed: number;
  daysRemaining: number;
  currentTime: string;
}> {
  const createdAt = typeof customerCreatedAt === 'string'
    ? customerCreatedAt
    : customerCreatedAt.toISOString();

  const response = await request.get(`${API_BASE}/test/billing/period`, {
    params: { createdAt },
  });

  if (!response.ok()) {
    throw new Error(`Failed to get billing period info: ${await response.text()}`);
  }

  return response.json();
}

/**
 * Example: Testing grace period expiration
 *
 * ```typescript
 * test('should suspend service after grace period', async ({ request, page }) => {
 *   // Set up initial payment date
 *   await setMockClock(request, '2024-01-01T00:00:00Z');
 *
 *   // ... customer makes payment ...
 *
 *   // Fast-forward 14 days (still in grace)
 *   await advanceClock(request, { days: 14 });
 *   // ... verify service still active ...
 *
 *   // Fast-forward 1 more day (grace expired)
 *   await advanceClock(request, { days: 1 });
 *   // ... verify service suspended ...
 * });
 * ```
 */

/**
 * Example: Testing billing period transitions
 *
 * ```typescript
 * test('should start new billing period after 28 days', async ({ request, page }) => {
 *   // Set customer creation date
 *   await setMockClock(request, '2024-01-01T00:00:00Z');
 *
 *   // ... customer signs up ...
 *
 *   // Jump to last day of period
 *   await setClockTime(request, '2024-01-28T23:59:59Z');
 *   const period1 = await getBillingPeriodInfo(request, '2024-01-01T00:00:00Z');
 *   expect(period1.daysRemaining).toBe(1);
 *
 *   // Jump to new period
 *   await setClockTime(request, '2024-01-29T00:00:01Z');
 *   const period2 = await getBillingPeriodInfo(request, '2024-01-01T00:00:00Z');
 *   expect(period2.daysElapsed).toBe(0);
 *   expect(period2.daysRemaining).toBe(28);
 * });
 * ```
 */