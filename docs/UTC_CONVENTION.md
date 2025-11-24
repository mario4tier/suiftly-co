# UTC Convention

**All timestamps in this application are UTC. No exceptions.**

## Architecture Decision

**Why UTC-only:**
- ✅ Simpler (no timezone conversion logic)
- ✅ Prevents bugs (Nov 30 vs Dec 1 type issues)
- ✅ Industry standard (AWS, Stripe, financial systems)
- ✅ Consistent with DBClock abstraction

## Database Schema

**Rule: Use plain `timestamp` (NOT `timestamptz`)**

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
- We don't want conversion - we want UTC in, UTC out

## Code Patterns

**Storing dates:**
```typescript
import { dbClock } from '@suiftly/shared/db-clock';

// Always use DBClock (already returns UTC)
await db.insert(table).values({
  createdAt: dbClock.now(), // UTC timestamp
  dueDate: dbClock.today(), // UTC midnight
});
```

**Reading dates:**
```typescript
// Dates from DB are UTC - treat as such
const record = await db.query.table.findFirst(...);

// For date-only fields, use UTC methods
const year = record.billingPeriodStart.getUTCFullYear();
const month = record.billingPeriodStart.getUTCMonth();
const day = record.billingPeriodStart.getUTCDate();
```

**API responses:**
```typescript
// Return ISO8601 UTC strings
return {
  dueDate: record.billingPeriodStart.toISOString(), // Ends with 'Z' = UTC
};
```

**UI display:**
```typescript
// Convert to user timezone ONLY in UI
const userDate = new Date(apiResponse.dueDate);
const formatted = userDate.toLocaleDateString('en-US', {
  timeZone: 'America/New_York' // or user's timezone
});
```

## Monthly Billing (1st of Month)

**1st of month detection uses UTC:**
```typescript
const today = dbClock.today(); // UTC midnight
const isFirstOfMonth = today.getUTCDate() === 1; // ✅ UTC date
```

**Why this matters:**
- Monthly billing runs at 00:00 UTC on the 1st
- Customers in all timezones see consistent behavior
- "December 1st billing" means December 1st UTC

## Testing

**MockDBClock uses UTC:**
```typescript
clock.setTime(new Date('2025-12-01T00:00:00Z')); // Z = UTC
const today = clock.today(); // Returns UTC midnight
```

## Migration Notes

**Existing schema:** Already uses plain `timestamp` (correct!)

**If you see `{ withTimezone: true }` anywhere:**
- Remove it
- This was added by mistake during development
- Plain `timestamp` is the correct pattern

## Exception: User Activity Timestamps

**Operational logs** (e.g., HAProxy logs, user activity) may include timezone for debugging:
- These are for ops, not business logic
- Business logic (billing, subscriptions) is **always UTC**

---

**Document Version:** 1.0
**Last Updated:** 2025-11-24
**Status:** Architectural Standard
