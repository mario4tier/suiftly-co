/**
 * API Test: Cancellation Flow
 *
 * Tests the cancellation lifecycle through HTTP calls only.
 * NO direct internal function calls (except DB reads for assertions).
 *
 * This test simulates realistic client behavior by:
 * 1. Making HTTP calls to tRPC endpoints (services.scheduleCancellation, etc.)
 * 2. Controlling time via /test/clock/* endpoints
 * 3. Reading DB directly for assertions (read-only)
 *
 * See docs/TEST_REFACTORING_PLAN.md for test layer design.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import { serviceInstances, customers } from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import {
  setClockTime,
  resetClock,
  ensureTestBalance,
  trpcMutation,
  trpcQuery,
  resetTestData,
} from './helpers/http.js';
import { login, TEST_WALLET } from './helpers/auth.js';
import { INVOICE_LINE_ITEM_TYPE } from '@suiftly/shared/constants';

const SUBSCRIPTION_ITEM_TYPES = [
  INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_STARTER,
  INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_PRO,
  INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_ENTERPRISE,
] as const;

describe('API: Cancellation Flow', () => {
  let accessToken: string;
  let customerId: number;

  beforeEach(async () => {
    // Reset clock to real time first
    await resetClock();

    // Reset test customer data via HTTP (like E2E tests do)
    await resetTestData(TEST_WALLET);

    // Login FIRST - this creates the customer with production defaults
    // Following E2E pattern: reset → login → setup balance
    accessToken = await login(TEST_WALLET);

    // Get customer ID for DB assertions
    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, TEST_WALLET),
    });
    if (!customer) {
      throw new Error('Test customer not found after login');
    }
    customerId = customer.customerId;

    // THEN ensure balance (after customer exists)
    await ensureTestBalance(100, { walletAddress: TEST_WALLET });
  });

  afterEach(async () => {
    // Reset clock
    await resetClock();
    // Clean up via HTTP
    await resetTestData(TEST_WALLET);
  });

  describe('Cancellation Scheduling via HTTP', () => {
    it('should schedule and undo cancellation via HTTP endpoints', async () => {
      // ---- Setup: Subscribe to a service ----
      await setClockTime('2025-01-05T00:00:00Z');

      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'pro' },
        accessToken
      );
      expect(subscribeResult.result?.data).toBeDefined();

      // Verify service exists (starts in DISABLED state per design)
      let service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(service).toBeDefined();
      expect(service?.tier).toBe('pro');
      expect(service?.state).toBe('disabled');

      // Mark as paid and enable the service
      await db.update(serviceInstances)
        .set({ paidOnce: true, subscriptionChargePending: false, state: 'enabled', isUserEnabled: true })
        .where(eq(serviceInstances.instanceId, service!.instanceId));

      // ---- Schedule cancellation via HTTP ----
      await setClockTime('2025-01-15T00:00:00Z');

      const cancelResult = await trpcMutation<any>(
        'services.scheduleCancellation',
        { serviceType: 'seal' },
        accessToken
      );
      expect(cancelResult.result?.data?.success).toBe(true);
      expect(cancelResult.result?.data?.effectiveDate).toBeDefined();

      // Verify cancellation is scheduled in DB
      service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, service!.instanceId),
      });
      expect(service?.state).toBe('enabled');
      expect(service?.cancellationScheduledFor).toBeTruthy();

      // ---- Undo cancellation via HTTP ----
      const undoResult = await trpcMutation<any>(
        'services.undoCancellation',
        { serviceType: 'seal' },
        accessToken
      );
      expect(undoResult.result?.data?.success).toBe(true);

      // Verify cancellation was undone in DB
      service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, service!.instanceId),
      });
      expect(service?.cancellationScheduledFor).toBeNull();
    });
  });

  describe('Unpaid Subscription Cancellation', () => {
    it('should cancel immediately when paidOnce = false', async () => {
      // Subscribe but don't mark as paid
      await setClockTime('2025-01-15T00:00:00Z');

      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );
      expect(subscribeResult.result?.data).toBeDefined();

      // Get service instance
      let service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(service).toBeDefined();

      // Ensure paidOnce is false (should be default)
      await db.update(serviceInstances)
        .set({ paidOnce: false })
        .where(eq(serviceInstances.instanceId, service!.instanceId));

      const instanceId = service!.instanceId;

      // Cancel immediately (should delete service since unpaid)
      const cancelResult = await trpcMutation<any>(
        'services.scheduleCancellation',
        { serviceType: 'seal' },
        accessToken
      );
      expect(cancelResult.result?.data?.success).toBe(true);

      // Service should be DELETED immediately (not scheduled)
      service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, instanceId),
      });
      expect(service).toBeUndefined();
    });
  });

  describe('Scheduled Cancellation Line Items Bug', () => {
    it('should NOT show subscription charge in line items when cancellation is scheduled', async () => {
      /**
       * BUG REPRODUCTION: When user schedules a cancellation:
       * - The DRAFT invoice amount is correctly set to $0 (no charge)
       * - BUT the line items still show the subscription charge
       *
       * Expected: Line items should only show the credit (if any), no subscription charge
       * Actual (BUG): Line items show "Seal Enterprise tier - $185.00" even though cancelled
       *
       * Root cause: buildDraftLineItems() in invoice-formatter.ts does not check
       * for cancellationScheduledFor when building subscription line items.
       */

      // ---- Setup: Subscribe to enterprise tier ----
      await setClockTime('2025-01-05T00:00:00Z');

      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'enterprise' },
        accessToken
      );

      let service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });

      // Mark as paid and enable the service
      await db.update(serviceInstances)
        .set({ paidOnce: true, subscriptionChargePending: false, state: 'enabled', isUserEnabled: true })
        .where(eq(serviceInstances.instanceId, service!.instanceId));

      // ---- Verify initial state: DRAFT shows enterprise price ----
      let paymentResult = await trpcQuery<any>(
        'billing.getNextScheduledPayment',
        undefined,
        accessToken
      );

      expect(paymentResult.result?.data?.found).toBe(true);
      let lineItems = paymentResult.result?.data?.lineItems;
      let subscriptionItem = lineItems?.find((item: any) => SUBSCRIPTION_ITEM_TYPES.includes(item.itemType));
      expect(subscriptionItem?.itemType).toBe(INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_ENTERPRISE);
      expect(subscriptionItem?.amountUsd).toBe(185); // Enterprise = $185

      // ---- Schedule cancellation ----
      await setClockTime('2025-01-15T00:00:00Z');

      const cancelResult = await trpcMutation<any>(
        'services.scheduleCancellation',
        { serviceType: 'seal' },
        accessToken
      );

      expect(cancelResult.result?.data?.success).toBe(true);

      // Verify cancellation is scheduled in DB
      service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, service!.instanceId),
      });
      expect(service?.cancellationScheduledFor).toBeTruthy();

      // ---- BUG: Verify DRAFT line items do NOT show subscription charge ----
      paymentResult = await trpcQuery<any>(
        'billing.getNextScheduledPayment',
        undefined,
        accessToken
      );

      expect(paymentResult.result?.data?.found).toBe(true);
      lineItems = paymentResult.result?.data?.lineItems;

      // When cancellation is scheduled, there should be NO subscription line item
      subscriptionItem = lineItems?.find((item: any) => SUBSCRIPTION_ITEM_TYPES.includes(item.itemType));
      expect(subscriptionItem).toBeUndefined();

      // The total should be $0 or negative (just credits if any)
      const totalUsd = paymentResult.result?.data?.totalUsd ?? 0;
      expect(totalUsd).toBeLessThanOrEqual(0);
    });
  });
});
