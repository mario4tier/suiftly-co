/**
 * API Test: Cancellation Flow
 *
 * Tests the cancellation lifecycle through HTTP calls only.
 * NO direct internal function calls (except DB reads for assertions).
 *
 * Cancellation applies to the platform subscription. Non-platform services
 * (seal, grpc, graphql) are auto-provisioned and can be toggled off, but
 * they follow the platform's cancellation lifecycle when it's cancelled.
 *
 * This test simulates realistic client behavior by:
 * 1. Making HTTP calls to tRPC endpoints (services.scheduleCancellation, etc.)
 * 2. Controlling time via /test/clock/* endpoints
 * 3. Reading DB directly for assertions (read-only)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import { customers } from '@suiftly/database/schema';
import { eq } from 'drizzle-orm';
import {
  setClockTime,
  resetClock,
  ensureTestBalance,
  trpcMutation,
  trpcQuery,
  resetTestData,
  runPeriodicBillingJob,
} from './helpers/http.js';
import { login, TEST_WALLET } from './helpers/auth.js';
import { INVOICE_LINE_ITEM_TYPE } from '@suiftly/shared/constants';
import { clearNotifications } from './helpers/notifications.js';
import { setupBillingTest } from './helpers/setup.js';

const SUBSCRIPTION_ITEM_TYPES = [
  INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_STARTER,
  INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_PRO,
] as const;

describe('API: Cancellation Flow', () => {
  let accessToken: string;
  let customerId: number;

  beforeEach(async () => {
    // Platform is subscribed at starter tier; seal/grpc/graphql auto-provisioned
    ({ accessToken, customerId } = await setupBillingTest());
  });

  afterEach(async () => {
    // Reset clock
    await resetClock();
    // Clean up via HTTP
    await resetTestData(TEST_WALLET);
  });

  describe('Cancellation Scheduling via HTTP', () => {
    it('should schedule and undo cancellation via HTTP endpoints', async () => {
      // Platform is already subscribed at starter from beforeEach
      await setClockTime('2025-01-05T00:00:00Z');

      // Verify platform via customer record
      let customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer).toBeDefined();
      expect(customer?.platformTier).toBe('starter');

      // ---- Schedule cancellation via HTTP ----
      await setClockTime('2025-01-15T00:00:00Z');

      const cancelResult = await trpcMutation<any>(
        'services.scheduleCancellation',
        { serviceType: 'platform' },
        accessToken
      );
      expect(cancelResult.result?.data?.success).toBe(true);
      expect(cancelResult.result?.data?.effectiveDate).toBeDefined();

      // Verify cancellation is scheduled in DB
      customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.platformTier).not.toBeNull(); // still active
      expect(customer?.platformCancellationScheduledFor).toBeTruthy();

      // ---- Undo cancellation via HTTP ----
      const undoResult = await trpcMutation<any>(
        'services.undoCancellation',
        { serviceType: 'platform' },
        accessToken
      );
      expect(undoResult.result?.data?.success).toBe(true);

      // Verify cancellation was undone in DB
      customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.platformCancellationScheduledFor).toBeNull();
    });
  });

  describe('Unpaid Subscription Cancellation', () => {
    it('should cancel immediately when paidOnce = false', async () => {
      /**
       * When a subscription payment is pending (paidOnce=false) and the user
       * cancels, the service is deleted immediately (no grace period needed
       * since no service was ever actively used).
       *
       * This test uses manual setup to avoid the platform subscription from
       * setupBillingTest, so we can test the unpaid cancellation path directly.
       */

      // ---- Manual setup: customer with $0 balance, no platform subscription ----
      await resetTestData(TEST_WALLET);
      const freshToken = await login(TEST_WALLET);
      const customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, TEST_WALLET),
      });
      if (!customer) throw new Error('Customer not found');
      const freshId = customer.customerId;
      await ensureTestBalance(0, { walletAddress: TEST_WALLET });
      await clearNotifications(freshId);

      // Accept TOS (required for platform subscribe)
      await trpcMutation<any>('billing.acceptTos', {}, freshToken);

      // Subscribe to platform with $0 balance → payment fails (paidOnce remains false)
      await setClockTime('2025-01-15T00:00:00Z');

      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'starter' },
        freshToken
      );
      expect(subscribeResult.result?.data).toBeDefined();
      // Payment should be pending due to insufficient balance
      expect(subscribeResult.result?.data?.paymentPending).toBe(true);

      // Check customer billing state
      let freshCustomer = await db.query.customers.findFirst({
        where: eq(customers.customerId, freshId),
      });
      expect(freshCustomer).toBeDefined();
      expect(freshCustomer?.paidOnce).toBe(false); // Verify paidOnce is false
      expect(freshCustomer?.platformTier).toBe('starter');

      // Cancel immediately (should delete service since unpaid)
      const cancelResult = await trpcMutation<any>(
        'services.scheduleCancellation',
        { serviceType: 'platform' },
        freshToken
      );
      expect(cancelResult.result?.data?.success).toBe(true);

      // Platform subscription should be cleared immediately (not scheduled)
      freshCustomer = await db.query.customers.findFirst({
        where: eq(customers.customerId, freshId),
      });
      expect(freshCustomer?.platformTier).toBeNull();
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
       * Actual (BUG): Line items show "Platform Pro tier - $29.00" even though cancelled
       *
       * Root cause: buildDraftLineItems() in invoice-formatter.ts does not check
       * for cancellationScheduledFor when building subscription line items.
       */

      // ---- Setup: Upgrade platform to pro tier ----
      await setClockTime('2025-01-05T00:00:00Z');
      await ensureTestBalance(100, { walletAddress: TEST_WALLET });

      await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'platform', newTier: 'pro' },
        accessToken
      );

      // ---- Verify initial state: DRAFT shows pro price ----
      let paymentResult = await trpcQuery<any>(
        'billing.getNextScheduledPayment',
        undefined,
        accessToken
      );

      expect(paymentResult.result?.data?.found).toBe(true);
      let lineItems = paymentResult.result?.data?.lineItems;
      let subscriptionItem = lineItems?.find(
        (item: any) => SUBSCRIPTION_ITEM_TYPES.includes(item.itemType) && item.service === 'platform'
      );
      expect(subscriptionItem?.itemType).toBe(INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_PRO);
      expect(subscriptionItem?.amountUsd).toBe(29); // Pro = $29

      // ---- Schedule cancellation ----
      await setClockTime('2025-01-15T00:00:00Z');

      const cancelResult = await trpcMutation<any>(
        'services.scheduleCancellation',
        { serviceType: 'platform' },
        accessToken
      );

      expect(cancelResult.result?.data?.success).toBe(true);

      // Verify cancellation is scheduled in DB
      const customerRec = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customerRec?.platformCancellationScheduledFor).toBeTruthy();

      // ---- BUG: Verify DRAFT line items do NOT show subscription charge ----
      paymentResult = await trpcQuery<any>(
        'billing.getNextScheduledPayment',
        undefined,
        accessToken
      );

      expect(paymentResult.result?.data?.found).toBe(true);
      lineItems = paymentResult.result?.data?.lineItems;

      // When cancellation is scheduled, there should be NO platform subscription line item
      subscriptionItem = lineItems?.find(
        (item: any) => SUBSCRIPTION_ITEM_TYPES.includes(item.itemType) && item.service === 'platform'
      );
      expect(subscriptionItem).toBeUndefined();

      // The total should be $0 or negative (just credits if any)
      const totalUsd = paymentResult.result?.data?.totalUsd ?? 0;
      expect(totalUsd).toBeLessThanOrEqual(0);
    });
  });

  describe('Re-subscription After Full Cancellation', () => {
    it('should allow re-subscription after cancellation takes effect', async () => {
      /**
       * Tests the full cancellation lifecycle for the platform subscription:
       * 1. Platform is subscribed (paid)
       * 2. Schedule cancellation
       * 3. Advance time to end of billing period (cancellation takes effect)
       * 4. Re-subscribe to platform
       *
       * This ensures:
       * - Platform service is properly reset after cancellation
       * - Customer can re-subscribe to platform
       */

      // ---- Step 1: Platform is already at starter from beforeEach ----
      await setClockTime('2025-01-05T00:00:00Z');

      // Verify platform subscription exists via customer record
      let custRec = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(custRec).toBeDefined();
      expect(custRec?.platformTier).toBe('starter');
      expect(custRec?.paidOnce).toBe(true);

      // ---- Step 2: Schedule cancellation ----
      await setClockTime('2025-01-15T00:00:00Z');

      const cancelResult = await trpcMutation<any>(
        'services.scheduleCancellation',
        { serviceType: 'platform' },
        accessToken
      );
      expect(cancelResult.result?.data?.success).toBe(true);

      // Verify cancellation is scheduled (end of billing period = Feb 1)
      custRec = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(custRec?.platformCancellationScheduledFor).toBeTruthy();

      // ---- Step 3: Advance to billing period end (Feb 1st) ----
      await setClockTime('2025-02-01T00:01:00Z');

      // Run the periodic billing job to process the cancellation
      await runPeriodicBillingJob(customerId);

      // Platform should be in cancellation_pending state (7-day grace period)
      custRec = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(custRec?.platformCancellationEffectiveAt).toBeDefined();
      expect(custRec?.platformCancellationScheduledFor).toBeNull();

      // ---- Step 3b: Advance past the 7-day grace period (Feb 8th+) ----
      await setClockTime('2025-02-09T00:01:00Z');

      // Run the periodic billing job again to trigger cleanup
      await runPeriodicBillingJob(customerId);

      // Platform subscription should now be cleared (not_provisioned = platformTier null)
      custRec = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(custRec?.platformTier).toBeNull();

      // ---- Step 4: Re-subscribe to platform ----
      // Note: There's a 7-day cooldown period after cancellation before re-subscribing
      await setClockTime('2025-02-17T00:00:00Z');

      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'starter' },
        accessToken
      );
      expect(subscribeResult.result?.data).toBeDefined();

      expect(subscribeResult.result?.data.tier).toBe('starter');

      custRec = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });

      expect(custRec?.platformTier).toBe('starter');
      expect(custRec?.platformCancellationScheduledFor).toBeNull();
      expect(custRec?.platformCancellationEffectiveAt).toBeNull();
    });
  });
});
