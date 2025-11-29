# Time Design

**All timestamps in this application are UTC. No exceptions.**

This document covers the time abstraction layer, UTC conventions, and testing with controlled time.

**Related Documents:**
- [BILLING_DESIGN.md](./BILLING_DESIGN.md) - Billing periods, grace periods, pro-rated calculations
- [CONSTANTS.md](./CONSTANTS.md) - 28-day spending period constants

---

## Quick Reference

### DBClock API

| Method | Returns | Description |
|--------|---------|-------------|
| `now()` | `Date` | Current timestamp (UTC) |
| `today()` | `Date` | Current date at UTC 00:00:00.000 |
| `daysUntil(date)` | `number` | Days until a future/past date |
| `addDays(n)` | `Date` | Add n days to current time |
| `addHours(n)` | `Date` | Add n hours to current time |
| `addDaysTo(date, n)` | `Date` | Add n days to specific date |

### Code Locations

| Component | Location |
|-----------|----------|
| DBClock interface | `packages/shared/src/db-clock/index.ts` |
| Billing period helpers | `packages/shared/src/billing/periods.ts` |
| Test clock helpers | `apps/webapp/tests/helpers/clock.ts` |
| Test API endpoints | `apps/api/src/routes/test/clock.ts` |

### Test Clock API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/test/clock/real` | POST | Reset to real system time |
| `/test/clock/mock` | POST | Enable mock time |
| `/test/clock/advance` | POST | Advance mock time |
| `/test/clock/set` | POST | Set specific time |
| `/test/clock` | GET | Get current clock status |
| `/test/billing/period` | GET | Get billing period info |

---

## 1. Architecture Decision: UTC Only

### Why UTC?

- **Simpler**: No timezone conversion logic in business code
- **Prevents bugs**: Avoids "Nov 30 vs Dec 1" type issues at month boundaries
- **Industry standard**: AWS, Stripe, financial systems all use UTC
- **Consistent**: Works with DBClock abstraction for deterministic testing

### Database Schema: Use Plain `timestamp`

**Rule: Use `timestamp` NOT `timestamptz`**

```typescript
// ✅ CORRECT - Plain timestamp, store UTC values
createdAt: timestamp('created_at').notNull().defaultNow()
billingPeriodStart: timestamp('billing_period_start').notNull()

// ❌ WRONG - timestamptz causes unwanted timezone conversion
createdAt: timestamp('created_at', { withTimezone: true })
```

**Why NOT `timestamptz`:**
- PostgreSQL `timestamptz` converts to client timezone on read
- Causes "2025-12-01 UTC" → "2025-11-30 EST" bugs
- We want UTC in, UTC out — no conversion

**Existing schema:** Already uses plain `timestamp` (correct!)

**If you see `{ withTimezone: true }` anywhere:** Remove it — this was added by mistake.

---

## 2. DBClock Abstraction

### Purpose

DBClock provides a unified time source for database timestamps, enabling:
- Consistent UTC time across all database operations
- Deterministic testing with controllable time
- Time-based business logic that's testable

### Scope

**DBClock is for database timestamps ONLY**, not for:
- Operational timeouts (use system clock)
- Rate limiting windows (use system clock)
- Cache TTLs (use system clock)

### Interface

```typescript
interface DBClock {
  now(): Date;                    // Current UTC timestamp
  today(): Date;                  // Current date at UTC midnight
  daysUntil(date: Date): number;  // Days until target date
  addDays(n: number): Date;       // Add days to now()
  addHours(n: number): Date;      // Add hours to now()
  addDaysTo(date: Date, n: number): Date;  // Add days to specific date
}
```

### Implementations

**RealDBClock (Production):**
- Uses system clock
- `now()` returns `new Date()`
- No special behavior

**MockDBClock (Testing):**
- Controllable time for deterministic tests
- `setTime(date)` - Jump to specific time
- `advance({ days, hours, minutes, seconds })` - Move forward
- `timeScale` - Auto-advance at accelerated rate

### Billing Period Helpers

Located in `@suiftly/shared/billing/periods`:

```typescript
import { getBillingPeriodInfo, getNextBillingDate } from '@suiftly/shared/billing/periods';

// Get current billing period for a customer
const period = getBillingPeriodInfo(customerCreatedAt, clock);
// Returns: { start, end, daysInPeriod, daysElapsed, daysRemaining }

// Get next 1st of month
const nextBilling = getNextBillingDate(clock);
```

---

## 3. Code Patterns

### Storing Dates

```typescript
import { dbClock } from '@suiftly/shared/db-clock';

// Always use DBClock (already returns UTC)
await db.insert(table).values({
  createdAt: dbClock.now(),     // UTC timestamp
  dueDate: dbClock.today(),     // UTC midnight
});
```

### Reading Dates

```typescript
// Dates from DB are UTC - treat as such
const record = await db.query.table.findFirst(...);

// For date-only fields, use UTC methods
const year = record.billingPeriodStart.getUTCFullYear();
const month = record.billingPeriodStart.getUTCMonth();
const day = record.billingPeriodStart.getUTCDate();
```

### API Responses

```typescript
// Return ISO8601 UTC strings
return {
  dueDate: record.billingPeriodStart.toISOString(), // Ends with 'Z' = UTC
};
```

### UI Display

```typescript
// Convert to user timezone ONLY in UI layer
const userDate = new Date(apiResponse.dueDate);
const formatted = userDate.toLocaleDateString('en-US', {
  timeZone: 'America/New_York' // or user's timezone
});
```

### Monthly Billing (1st of Month Detection)

```typescript
const today = dbClock.today(); // UTC midnight
const isFirstOfMonth = today.getUTCDate() === 1; // ✅ UTC date
```

**Why this matters:**
- Monthly billing runs at 00:00 UTC on the 1st
- Customers in all timezones see consistent behavior
- "December 1st billing" means December 1st UTC

---

## 4. Testing Guide

### Key Principle: Control Through API, Not Direct Import

**IMPORTANT**: Tests should NEVER directly import or create `DBClock` instances. All time control happens through test API endpoints.

```typescript
// ❌ WRONG - Don't do this in tests
import { dbClockProvider } from '@suiftly/shared/db-clock';
dbClockProvider.useMockClock({ ... });

// ✅ CORRECT - Use test helpers
import { setMockClock } from '../helpers/clock';
await setMockClock(request, '2024-01-01T00:00:00Z');
```

### Automatic Clock Reset

Every test automatically starts with real system time via the `base-test` fixture:

```typescript
// Use the base test fixture instead of @playwright/test
import { test, expect } from '../fixtures/base-test';

test('my test', async ({ page, request }) => {
  // Clock is automatically reset to real time
  // Your test code here
});
```

### Clock Helper Functions

Located in `apps/webapp/tests/helpers/clock.ts`:

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

// Get billing period information
const period = await getBillingPeriodInfo(request, customerCreatedAt);
// Returns: { start, end, daysInPeriod, daysElapsed, daysRemaining, currentTime }
```

### Common Test Scenarios

#### Testing Grace Periods (14 Days)

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

#### Testing Billing Period Transitions

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

#### Testing Session Timeouts

```typescript
test('should timeout session after 2 hours', async ({ request, page }) => {
  await setMockClock(request, '2024-01-01T10:00:00Z');

  // Login
  await page.goto('/login');
  // ... perform login ...

  // Fast-forward 1 hour 59 minutes - still logged in
  await advanceClock(request, { hours: 1, minutes: 59 });

  // Fast-forward 2 more minutes - logged out
  await advanceClock(request, { minutes: 2 });
});
```

#### Testing Monthly Billing (1st of Month)

```typescript
test('should process billing on 1st of month', async ({ request }) => {
  // Set to Jan 31, 23:59
  await setMockClock(request, '2024-01-31T23:59:00Z');

  // Advance to Feb 1, 00:00
  await advanceClock(request, { minutes: 1 });

  // Billing should run
  const status = await getClockStatus(request);
  const date = new Date(status.currentTime);
  expect(date.getUTCDate()).toBe(1);
  expect(date.getUTCMonth()).toBe(1); // February
});
```

### Auto-Advancing Clock

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
});
```

### Best Practices

#### 1. Always Start Fresh
Let the `base-test` fixture reset the clock. Don't assume time state from previous tests.

#### 2. Be Explicit About Time
```typescript
// ✅ Good - Clear what time is being tested
await setMockClock(request, '2024-01-01T00:00:00Z');

// ❌ Bad - Relative to unknown starting point
await advanceClock(request, { days: 14 });
```

#### 3. Use Descriptive Test Names
```typescript
test('grace period - should remain active for 14 days after last payment', ...)
test('billing period - should transition to new period after 28 days', ...)
```

#### 4. Group Related Time Tests
```typescript
test.describe('Grace Period Behavior', () => {
  test('should allow 14 days grace after payment', ...);
  test('should suspend on day 15', ...);
  test('should resume immediately on new payment', ...);
});
```

#### 5. Document Time Dependencies
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

### Debugging Time Issues

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

---

## 5. Integration Points

### Billing System

**Monthly billing** runs on 1st of month, 00:00 UTC:
- DRAFT invoices transition to PENDING
- Scheduled tier changes take effect
- Cancellations finalize
- See [BILLING_DESIGN.md](./BILLING_DESIGN.md)

**Pro-rated calculations** use days remaining:
```typescript
charge = (new_tier - old_tier) × (days_remaining / days_in_month)
```
Grace period: If ≤2 days remaining, charge = $0.

### Grace Periods

14-day grace period for customers with `paid_once = TRUE`:
- Day 0: Charge fails, grace starts
- Days 1-14: Services continue, retry charges
- Day 15+: Account suspended

### Spending Periods

28-day rolling period from account creation:
- See [CONSTANTS.md](./CONSTANTS.md) for SPENDING_LIMIT constants
- Uses exact timestamp arithmetic: `28 × 86,400,000 milliseconds`
- No drift, no calendar math

### Session Management

Session timeouts use system clock (not DBClock):
- Access tokens: 15 minutes
- Refresh tokens: 30 days
- See [AUTHENTICATION_DESIGN.md](./AUTHENTICATION_DESIGN.md)

---

## Migration Notes

### Converting Tests to Use Clock Helpers

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

---

**Document Version:** 1.0
**Last Updated:** 2025-11-28
**Status:** Architectural Standard

**Merged from:** UTC_CONVENTION.md, TESTING_WITH_DB_CLOCK.md
