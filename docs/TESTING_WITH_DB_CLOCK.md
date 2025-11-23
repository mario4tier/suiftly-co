# Testing with DBClock

## Overview

The `DBClock` provides a unified time source for database timestamps, allowing deterministic testing of date-based business logic. This document explains how to use it in tests.

## Key Principle: Control Through API, Not Direct Import

**IMPORTANT**: Tests should NEVER directly import or create `DBClock` instances. Instead, all time control happens through test API endpoints.

```typescript
// ❌ WRONG - Don't do this in tests
import { dbClockProvider } from '@suiftly/shared/db-clock';
dbClockProvider.useMockClock({ ... });

// ✅ CORRECT - Use test helpers
import { setMockClock } from '../helpers/clock';
await setMockClock(request, '2024-01-01T00:00:00Z');
```

## Automatic Clock Reset

Every test automatically starts with real system time. This is handled by the `base-test` fixture:

```typescript
// Use the base test fixture instead of @playwright/test
import { test, expect } from '../fixtures/base-test';

test('my test', async ({ page, request }) => {
  // Clock is automatically reset to real time
  // Your test code here
});
```

## Clock Helper Functions

Located in `apps/webapp/tests/helpers/clock.ts`:

### Basic Operations

```typescript
// Reset to real time (done automatically, but can be called manually)
await resetClock(request);

// Set mock time
await setMockClock(request, '2024-01-01T00:00:00Z');

// Advance time
await advanceClock(request, {
  days: 14,
  hours: 2,
  minutes: 30,
  seconds: 45
});

// Jump to specific time
await setClockTime(request, '2024-12-25T00:00:00Z');

// Get current status
const status = await getClockStatus(request);
// Returns: { type: 'real' | 'mock', currentTime: string, config?: {...} }
```

### Billing-Specific

```typescript
// Get billing period information
const period = await getBillingPeriodInfo(request, customerCreatedAt);
// Returns: {
//   start: '2024-01-01T00:00:00.000Z',
//   end: '2024-01-29T00:00:00.000Z',
//   daysInPeriod: 28,
//   daysElapsed: 14,
//   daysRemaining: 14,
//   currentTime: '2024-01-15T00:00:00.000Z'
// }
```

## Common Test Scenarios

### Testing Grace Periods

```typescript
test('should suspend service after grace period expires', async ({ request, page }) => {
  // Set initial payment date
  await setMockClock(request, '2024-01-01T00:00:00Z');

  // Make payment (your test logic)
  // ...

  // Fast-forward 14 days (last day of grace)
  await advanceClock(request, { days: 14 });
  // Service should still be active

  // Fast-forward 1 more day (grace expired)
  await advanceClock(request, { days: 1 });
  // Service should be suspended
});
```

### Testing Billing Period Transitions

```typescript
test('should start new period after 28 days', async ({ request }) => {
  const customerCreatedAt = '2024-01-01T00:00:00Z';
  await setMockClock(request, customerCreatedAt);

  // Check initial period
  let period = await getBillingPeriodInfo(request, customerCreatedAt);
  expect(period.daysRemaining).toBe(28);

  // Jump to new period
  await setClockTime(request, '2024-01-29T00:00:01Z');
  period = await getBillingPeriodInfo(request, customerCreatedAt);
  expect(period.daysElapsed).toBe(0);
  expect(period.start).toBe('2024-01-29T00:00:00.000Z');
});
```

### Testing Session Timeouts

```typescript
test('should timeout session after 2 hours', async ({ request, page }) => {
  await setMockClock(request, '2024-01-01T10:00:00Z');

  // Login
  await page.goto('/login');
  // ... perform login ...

  // Fast-forward 1 hour 59 minutes
  await advanceClock(request, { hours: 1, minutes: 59 });
  // Should still be logged in

  // Fast-forward 2 more minutes
  await advanceClock(request, { minutes: 2 });
  // Should be logged out
});
```

### Testing Rate Limiting

```typescript
test('should enforce rate limit window', async ({ request, page }) => {
  await setMockClock(request, '2024-01-01T10:00:00Z');

  // Make 5 requests (at limit)
  for (let i = 0; i < 5; i++) {
    await page.request.get('/api/endpoint');
    await advanceClock(request, { seconds: 1 });
  }

  // 6th request should fail (rate limited)
  const response = await page.request.get('/api/endpoint');
  expect(response.status()).toBe(429);

  // Wait for window to reset (1 minute total)
  await setClockTime(request, '2024-01-01T10:01:00Z');

  // Should work again
  const retryResponse = await page.request.get('/api/endpoint');
  expect(retryResponse.ok()).toBe(true);
});
```

## Auto-Advancing Clock

For tests that need time to progress automatically:

```typescript
test('should process background job after delay', async ({ request }) => {
  // Time advances at 100x speed
  await setMockClock(request, '2024-01-01T00:00:00Z', {
    autoAdvance: true,
    timeScale: 100
  });

  // Schedule job for 5 minutes from now
  // ...

  // Wait 3 seconds real time = 300 seconds (5 minutes) simulated
  await page.waitForTimeout(3000);

  // Job should have executed
  // ...
});
```

## Best Practices

### 1. Always Start Fresh
Let the `base-test` fixture reset the clock. Don't assume time state from previous tests.

### 2. Be Explicit About Time
```typescript
// Good - Clear what time is being tested
await setMockClock(request, '2024-01-01T00:00:00Z');

// Bad - Relative to unknown starting point
await advanceClock(request, { days: 14 });
```

### 3. Use Descriptive Test Names
```typescript
test('grace period - should remain active for 14 days after last payment', ...)
test('billing period - should transition to new period after 28 days', ...)
```

### 4. Group Related Time Tests
```typescript
test.describe('Grace Period Behavior', () => {
  test('should allow 14 days grace after payment', ...);
  test('should suspend on day 15', ...);
  test('should resume immediately on new payment', ...);
});
```

### 5. Document Time Dependencies
```typescript
test('should calculate pro-rated charge correctly', async ({ request }) => {
  // Customer created on day 1
  const customerCreatedAt = '2024-01-01T00:00:00Z';

  // Jump to day 15 (14 days remaining in period)
  await setMockClock(request, '2024-01-15T00:00:00Z');

  // Pro-rated = $28 * (14/28) = $14
  const proRated = calculateProRatedAmount(2800, customerCreatedAt);
  expect(proRated).toBe(1400);
});
```

## Integration with Other Test Helpers

The clock helpers work seamlessly with other test utilities:

```typescript
import { test, expect } from '../fixtures/base-test';
import { setMockClock, advanceClock } from '../helpers/clock';
import { resetCustomer, ensureTestBalance } from '../helpers/db';

test('complete billing flow with time control', async ({ request, page }) => {
  // Reset customer and clock (clock reset is automatic)
  await resetCustomer(request);

  // Set initial time
  await setMockClock(request, '2024-01-01T00:00:00Z');

  // Ensure wallet has funds
  await ensureTestBalance(request, 100); // $100

  // ... perform actions ...

  // Fast-forward to test grace period
  await advanceClock(request, { days: 14 });

  // ... verify behavior ...
});
```

## Debugging Time Issues

If tests are failing due to time-related issues:

1. **Check Clock Status**
   ```typescript
   const status = await getClockStatus(request);
   console.log('Clock:', status);
   ```

2. **Verify Period Calculations**
   ```typescript
   const period = await getBillingPeriodInfo(request, customerCreatedAt);
   console.log('Period:', period);
   ```

3. **Add Time Checkpoints**
   ```typescript
   console.log('Before advance:', await getClockStatus(request));
   await advanceClock(request, { days: 14 });
   console.log('After advance:', await getClockStatus(request));
   ```

4. **Ensure Clean State**
   - Check that previous tests aren't leaving mock clock active
   - Verify `base-test` fixture is being used
   - Confirm global teardown is resetting clock

## API Endpoints (For Reference)

The helper functions wrap these endpoints:

- `POST /test/clock/real` - Reset to real time
- `POST /test/clock/mock` - Enable mock time
- `POST /test/clock/advance` - Advance mock time
- `POST /test/clock/set` - Set specific time
- `GET /test/clock` - Get current status
- `GET /test/billing/period` - Get billing period info

## Migration Guide

If you have existing tests that need time control:

1. Switch to `base-test` fixture:
   ```typescript
   // Old
   import { test, expect } from '@playwright/test';

   // New
   import { test, expect } from '../fixtures/base-test';
   ```

2. Add time control where needed:
   ```typescript
   // Old - Tests ran with unpredictable real time
   test('billing test', async ({ page }) => {
     // Test might fail depending on when it runs
   });

   // New - Deterministic time control
   test('billing test', async ({ request, page }) => {
     await setMockClock(request, '2024-01-01T00:00:00Z');
     // Test always runs with consistent time
   });
   ```

3. Replace time-dependent waits:
   ```typescript
   // Old - Actually wait 14 days (impossible!)
   await page.waitForTimeout(14 * 24 * 60 * 60 * 1000);

   // New - Instantly advance 14 days
   await advanceClock(request, { days: 14 });
   ```

## Example Test File

See `apps/webapp/tests/e2e/example-clock-test.spec.ts` for complete working examples.