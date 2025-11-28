# Test Refactoring Plan

## Overview

Refactor tests into three clear layers with strict separation:

1. **Unit Tests (`ut-*.test.ts`)** - Direct function calls, test internal logic
2. **API Tests (`api-*.test.ts`)** - HTTP calls only, simulate production client behavior
3. **UI Tests (`ui-*.spec.ts`)** - Browser interaction only, customer-level testing

## Current State

### Problems with Current Tests

1. **Mixed concerns**: `tier-changes.test.ts` directly calls `processCustomerBilling()` and `processCancellationCleanup()` - these should be triggered via API in API tests
2. **No clear separation**: Tests call internal functions when they should go through API
3. **Missing test API endpoints**: No way to trigger periodic billing jobs from API tests
4. **Inconsistent naming**: No naming convention to distinguish test types

### Current Test Files

```
packages/database/src/billing/
  tier-changes.test.ts       # Mixed: direct calls + integration-style tests
  billing.test.ts            # Mixed: unit + integration
  service-billing.test.ts    # Unit tests
  validation.test.ts         # Unit tests
  edge-case-tests.test.ts    # Unit tests
  draft-invoice-bugs.test.ts # Unit tests

apps/api/src/routes/
  auth.test.ts              # API tests (good example)
  api.test.ts               # API tests (good example)

apps/webapp/tests/e2e/
  *.spec.ts                 # UI tests (Playwright)
```

## Target State

### Test File Structure

```
packages/database/src/billing/
  ut-tier-changes.test.ts        # Unit: direct function tests
  ut-credits.test.ts             # Unit: credit application logic
  ut-payments.test.ts            # Unit: payment processing logic
  ut-validation.test.ts          # Unit: invoice validation
  ut-pro-rata.test.ts            # Unit: pro-rated charge calculations
  ut-grace-period.test.ts        # Unit: grace period logic
  ut-idempotency.test.ts         # Unit: idempotency checks

apps/api/tests/
  api-tier-changes.test.ts       # API: tier upgrade/downgrade via HTTP
  api-cancellation.test.ts       # API: service cancellation flow
  api-billing-processor.test.ts  # API: trigger billing job via HTTP
  api-subscription.test.ts       # API: subscribe to services
  api-escrow.test.ts             # API: escrow operations

apps/webapp/tests/e2e/
  ui-tier-changes.spec.ts        # UI: tier change modal interaction
  ui-cancellation.spec.ts        # UI: cancel service flow
  ui-billing.spec.ts             # UI: billing dashboard
```

## Required API Endpoints for Testing

### Test-Only Endpoints (disabled in production)

These endpoints allow API tests to trigger the periodic job and control time:

```typescript
// apps/api/src/routes/test-billing.ts

// Trigger the unified periodic billing job
// This is THE SAME job that runs every 5 minutes in production
// Single-threaded, deterministic order, handles ALL billing operations
POST /test/billing/run-periodic-job
Request: { customerId?: number }  // Optional: process single customer
Response: { results: BillingJobResult }

// Set mock clock time (already exists)
POST /test/clock/set
Request: { timestamp: string }  // ISO format

// Advance clock by days
POST /test/clock/advance
Request: { days: number }

// Get current mock clock time
GET /test/clock
Response: { timestamp: string, isReal: boolean }
```

### Production Safety

```typescript
// In test-billing.ts
if (config.isProduction) {
  throw new Error('Test billing endpoints disabled in production');
}
```

## Unified Periodic Job Design

**CRITICAL**: There is ONE periodic job that handles ALL billing operations in a deterministic order.

### Job: `runPeriodicBillingJob()`

Called every 5 minutes in production. Single-threaded. Deterministic order.

```typescript
// packages/database/src/billing/periodic-job.ts

export async function runPeriodicBillingJob(
  db: NodePgDatabase<any>,
  config: BillingProcessorConfig,
  suiService: ISuiService
): Promise<BillingJobResult> {
  const results: BillingJobResult = {
    timestamp: config.clock.now(),
    customersProcessed: 0,
    operations: [],
  };

  // ===== PHASE 1: Monthly Billing (1st of month only) =====
  // - Apply scheduled tier changes
  // - Process scheduled cancellations
  // - Transition DRAFT → PENDING
  // - Attempt payments
  // - Start grace periods on failure

  // ===== PHASE 2: Payment Retries =====
  // - Retry failed invoices (up to max attempts)
  // - Clear grace period on success

  // ===== PHASE 3: Grace Period Expiration =====
  // - Suspend accounts with expired grace periods

  // ===== PHASE 4: Cancellation Cleanup =====
  // - Delete services in cancellation_pending for 7+ days
  // - Record cancellation history for cooldown enforcement

  // ===== PHASE 5: Housekeeping =====
  // - Clean up old idempotency records
  // - Clean up old cancellation history (beyond cooldown)

  return results;
}
```

### Why Single Job?

1. **Determinism**: Order of operations is always the same
2. **Testability**: One function to call, one result to verify
3. **Simplicity**: No race conditions between separate jobs
4. **Debuggability**: Single log stream, easy to trace issues

### Current State vs Target

**Current**:
- `processCustomerBilling()` - monthly billing, retries, grace period
- `processCancellationCleanup()` - separate cleanup job

**Target**:
- `runPeriodicBillingJob()` - unified job that calls both in correct order

## Test Design Principles

### Unit Tests (`ut-*.test.ts`)

**Location**: `packages/database/src/billing/`

**Rules**:
- Direct function imports and calls
- Mock dependencies at function level
- Use MockDBClock directly
- Use test database with direct queries
- Focus on edge cases, boundary conditions, error handling

**Example**:
```typescript
// ut-tier-changes.test.ts
import { handleTierUpgrade, calculateProRatedUpgradeCharge } from './tier-changes';
import { MockDBClock } from '@suiftly/shared/db-clock';

describe('calculateProRatedUpgradeCharge', () => {
  it('should return $0 for grace period (<=2 days remaining)', () => {
    const clock = new MockDBClock();
    clock.setTime(new Date('2025-01-30T00:00:00Z')); // 2 days left

    const charge = calculateProRatedUpgradeCharge(999, 2999, clock);
    expect(charge).toBe(0);
  });
});
```

### API Tests (`api-*.test.ts`)

**Location**: `apps/api/tests/`

**Rules**:
- HTTP calls only (fetch/supertest)
- NO direct function imports from billing package
- Use test API endpoints to control state (clock, trigger jobs)
- Can read database directly for assertions only
- Simulate realistic client behavior

**Example**:
```typescript
// api-tier-changes.test.ts
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import { serviceInstances } from '@suiftly/database/schema';
import { eq } from 'drizzle-orm';

const API_URL = 'http://localhost:3000';

describe('API: Tier Changes', () => {
  let authCookie: string;

  beforeAll(async () => {
    // Login via API
    const res = await fetch(`${API_URL}/auth/login`, { ... });
    authCookie = res.headers.get('set-cookie')!;
  });

  afterEach(async () => {
    // Reset test data via API
    await fetch(`${API_URL}/test/data/reset`, { method: 'POST' });
  });

  describe('Tier Upgrade Flow', () => {
    it('should upgrade tier with pro-rated charge', async () => {
      // 1. Set clock to mid-month via test API
      await fetch(`${API_URL}/test/clock/set`, {
        method: 'POST',
        body: JSON.stringify({ timestamp: '2025-01-15T00:00:00Z' }),
      });

      // 2. Call upgrade API
      const res = await fetch(`${API_URL}/services/seal/upgrade`, {
        method: 'POST',
        headers: { Cookie: authCookie },
        body: JSON.stringify({ newTier: 'enterprise' }),
      });

      const result = await res.json();
      expect(result.success).toBe(true);
      expect(result.chargeAmountUsdCents).toBeGreaterThan(0);

      // 3. Verify via direct DB read (read-only assertion)
      const service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.customerId, testCustomerId),
      });
      expect(service?.tier).toBe('enterprise');
    });
  });

  describe('Scheduled Downgrade Flow', () => {
    it('should schedule downgrade for end of billing period', async () => {
      // 1. Schedule downgrade via API
      await fetch(`${API_URL}/services/seal/downgrade`, {
        method: 'POST',
        headers: { Cookie: authCookie },
        body: JSON.stringify({ newTier: 'starter' }),
      });

      // 2. Advance clock to 1st of next month
      await fetch(`${API_URL}/test/clock/set`, {
        method: 'POST',
        body: JSON.stringify({ timestamp: '2025-02-01T00:00:00Z' }),
      });

      // 3. Trigger billing processor via test API
      await fetch(`${API_URL}/test/billing/process`, { method: 'POST' });

      // 4. Verify tier changed
      const service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.customerId, testCustomerId),
      });
      expect(service?.tier).toBe('starter');
    });
  });
});
```

### UI Tests (`ui-*.spec.ts`)

**Location**: `apps/webapp/tests/e2e/`

**Rules**:
- Browser interaction only (Playwright)
- NO direct API calls except test setup endpoints
- Use page objects for common interactions
- Test customer-visible behavior

**Example**:
```typescript
// ui-tier-changes.spec.ts
import { test, expect } from '@playwright/test';

test.describe('UI: Tier Changes', () => {
  test.beforeEach(async ({ request }) => {
    // Reset via test API
    await request.post('/test/data/reset');
    await request.post('/test/clock/set', {
      data: { timestamp: '2025-01-15T00:00:00Z' }
    });
  });

  test('should show upgrade confirmation with pro-rated price', async ({ page }) => {
    await page.goto('/services/seal/overview');

    // Click change plan button
    await page.click('text=Change Plan');

    // Verify modal shows
    await expect(page.locator('.tier-change-modal')).toBeVisible();

    // Select enterprise tier
    await page.click('text=Enterprise');

    // Verify price shown
    await expect(page.locator('.upgrade-price')).toContainText('$');

    // Confirm upgrade
    await page.click('text=Confirm Upgrade');

    // Verify success
    await expect(page.locator('.toast-success')).toBeVisible();
  });
});
```

## Implementation Steps

### Phase 1: Create Test Infrastructure

1. Create `apps/api/src/routes/test-billing.ts` with billing job endpoints
2. Add clock advance endpoint to existing test routes
3. Create test utility functions for common API test patterns

### Phase 2: Refactor Existing Tests

1. **Rename existing tests** with `ut-` prefix
2. **Extract pure unit tests** from mixed test files
3. **Move integration tests** that use `processCustomerBilling` to new API test files
4. **Update imports** to use HTTP calls instead of direct functions

### Phase 3: Create API Tests

1. `api-tier-changes.test.ts` - Full tier change flows via HTTP
2. `api-cancellation.test.ts` - Cancellation journey via HTTP
3. `api-billing-processor.test.ts` - Monthly billing via HTTP
4. `api-subscription.test.ts` - Subscribe/unsubscribe via HTTP

### Phase 4: Create UI Tests

1. `ui-tier-changes.spec.ts` - Modal interaction
2. `ui-cancellation.spec.ts` - Cancel flow
3. `ui-billing.spec.ts` - Billing dashboard

## Test Runner Configuration

### Vitest Config for Unit Tests

```typescript
// packages/database/vitest.config.ts
export default {
  include: ['src/**/*.test.ts'],  // All .test.ts files
  // Unit tests run against test database
};
```

### Vitest Config for API Tests

```typescript
// apps/api/vitest.config.ts
export default {
  include: ['tests/api-*.test.ts'],
  // Requires running API server
  globalSetup: './tests/setup.ts',
};
```

### Playwright Config for UI Tests

```typescript
// apps/webapp/playwright.config.ts
export default {
  testMatch: 'tests/e2e/ui-*.spec.ts',
  // Full stack required
};
```

## Migration Checklist

### Phase 1: Create Unified Periodic Job ✅ COMPLETE
- [x] Create `packages/database/src/billing/periodic-job.ts`
- [x] Integrate `processBilling()` into unified job
- [x] Integrate `processCancellationCleanup()` into unified job
- [x] Add housekeeping (idempotency cleanup, history cleanup)
- [x] Export `runPeriodicBillingJob()` from billing index

### Phase 2: Create Test API Endpoint ✅ COMPLETE
- [x] Create `/test/billing/run-periodic-job` endpoint
- [x] Create `/test/clock/advance` endpoint (already exists as `/test/clock/set`)
- [x] Ensure production safety checks

### Phase 3: Rename Existing Tests with `ut-` Prefix ✅ COMPLETE
- [x] Rename `tier-changes.test.ts` → `ut-tier-changes.test.ts`
- [x] Rename `billing.test.ts` → `ut-billing.test.ts`
- [x] Rename `service-billing.test.ts` → `ut-service-billing.test.ts`
- [x] Rename `validation.test.ts` → `ut-validation.test.ts`
- [x] Rename `edge-case-tests.test.ts` → `ut-edge-cases.test.ts`
- [x] Rename `draft-invoice-bugs.test.ts` → `ut-draft-invoice.test.ts`

### Phase 4: Extract Integration Tests to API Tests
- [ ] Move "Full Cancellation Journey" from unit test to `api-cancellation.test.ts`
- [ ] Move monthly billing flow tests to `api-billing.test.ts`
- [ ] Update tests to use HTTP calls + `/test/billing/run-periodic-job`

### Phase 5: Create API Test Files
- [ ] Create `apps/api/tests/api-tier-changes.test.ts`
- [ ] Create `apps/api/tests/api-cancellation.test.ts`
- [ ] Create `apps/api/tests/api-billing.test.ts`
- [ ] Create `apps/api/tests/api-subscription.test.ts`

### Phase 6: Create UI Test Files
- [ ] Create `apps/webapp/tests/e2e/ui-tier-changes.spec.ts`
- [ ] Create `apps/webapp/tests/e2e/ui-cancellation.spec.ts`

### Phase 7: Update Documentation
- [ ] Update CI to run all test types in correct order
- [ ] Document test patterns in CLAUDE.md
- [ ] Update this plan as complete

## Notes

- Keep unit tests fast (no HTTP overhead)
- API tests are slower but more realistic
- UI tests are slowest, use sparingly for critical flows
- All tests should pass before merge
