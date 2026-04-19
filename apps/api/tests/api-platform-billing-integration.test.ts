/**
 * API Test: Platform Billing Integration
 *
 * Tests platform subscription billing through HTTP calls, including:
 *
 * Section 1: Partial-month credit on platform subscription
 * Section 1B: No duplicate credits in API response
 * Section 2: Platform provider chain (escrow, stripe, pending)
 * Section 3: Platform tier changes (upgrade/downgrade)
 * Section 4: Platform cancellation lifecycle
 * Section 5: Auto-provisioned service coexistence
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import {
  serviceInstances,
  billingRecords,
  invoiceLineItems,
  customerCredits,
  customers,
} from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import {
  setClockTime,
  resetClock,
  trpcMutation,
  trpcQuery,
  restCall,
  resetTestData,
  ensureTestBalance,
  addStripePaymentMethod,
  runPeriodicBillingJob,
  subscribePlatform,
} from './helpers/http.js';
import { login, TEST_WALLET } from './helpers/auth.js';
import { expectNoNotifications, clearNotifications } from './helpers/notifications.js';
import { setupBillingTest } from './helpers/setup.js';
import { waitForState } from './helpers/wait-for-state.js';
import { PLATFORM_TIER_PRICES_USD_CENTS } from '@suiftly/shared/pricing';

describe('API: Platform Billing Integration', () => {
  const STARTER_PRICE = PLATFORM_TIER_PRICES_USD_CENTS.starter;
  const PRO_PRICE = PLATFORM_TIER_PRICES_USD_CENTS.pro;


  let accessToken: string;
  let customerId: number;

  afterEach(async () => {
    await resetClock();
    await resetTestData(TEST_WALLET);
  });

  // =========================================================================
  // Section 1: Partial Month Credit
  // =========================================================================
  describe('Partial Month Credits', () => {
    beforeEach(async () => {
      // Subscribe platform mid-month so it gets a partial-month credit
      ({ accessToken, customerId } = await setupBillingTest({
        clockTime: '2025-01-15T00:00:00Z',
      }));
    });

    it('should create single reconciliation credit when platform subscribed mid-month', async () => {
      // Platform was subscribed at Jan 15 in setupBillingTest.
      // Query all reconciliation credits for this customer
      const credits = await db
        .select()
        .from(customerCredits)
        .where(
          and(
            eq(customerCredits.customerId, customerId),
            eq(customerCredits.reason, 'reconciliation')
          )
        );

      // Should have exactly ONE credit: for platform only
      // Platform Starter = $2 = STARTER_PRICE cents
      // Jan: 31 days, subscribed day 15 → daysUsed = 17, daysNotUsed = 14
      // Credit = floor(STARTER_PRICE * 14 / 31) = 90 cents
      expect(credits.length).toBe(1);

      const platformCredit = credits.find(c =>
        c.description?.includes('platform')
      );
      expect(platformCredit).toBeDefined();
      expect(Number(platformCredit!.originalAmountUsdCents)).toBe(Math.floor(STARTER_PRICE * 14 / 31));

      await expectNoNotifications(customerId);
    });

    it('should include credit line item in DRAFT for platform mid-month subscription', async () => {
      // Platform subscribed Jan 15 → reconciliation credit exists
      // DRAFT invoice for next month should include:
      // - Platform subscription line item ($2 = STARTER_PRICE cents)
      // - Credit line item (from the reconciliation credit)
      // - Total = STARTER_PRICE - credit

      // Get the DRAFT invoice
      const drafts = await db.query.billingRecords.findMany({
        where: and(
          eq(billingRecords.customerId, customerId),
          eq(billingRecords.status, 'draft')
        ),
      });
      expect(drafts.length).toBeGreaterThanOrEqual(1);
      const draftId = drafts[0].id;

      // Get all line items for the DRAFT
      const lineItems = await db.query.invoiceLineItems.findMany({
        where: eq(invoiceLineItems.billingRecordId, draftId),
      });

      // Should have subscription line item for platform
      const platformSub = lineItems.find(
        li => li.serviceType === 'platform' && li.itemType?.startsWith('subscription_')
      );
      expect(platformSub).toBeDefined();
      expect(Number(platformSub!.amountUsdCents)).toBe(STARTER_PRICE); // Platform starter = $2

      // Should have exactly 1 credit line item (platform credit)
      const creditItems = lineItems.filter(li => li.itemType === 'credit');
      expect(creditItems.length).toBe(1);

      const platformCreditItem = creditItems.find(li =>
        li.description?.includes('platform')
      );
      expect(platformCreditItem).toBeDefined();
      const expectedCredit = Math.floor(STARTER_PRICE * 14 / 31);
      expect(Number(platformCreditItem!.amountUsdCents)).toBe(-expectedCredit);

      // DRAFT total is net (STARTER_PRICE - credit)
      expect(Number(drafts[0].amountUsdCents)).toBe(STARTER_PRICE - expectedCredit);

      await expectNoNotifications(customerId);
    });
  });

  // =========================================================================
  // Section 1B: No duplicate credits in Next Scheduled Payment
  // =========================================================================
  describe('No Duplicate Credits in API Response', () => {
    it('should return exactly one credit line item per credit in getNextScheduledPayment', async () => {
      // Subscribe platform mid-month to produce a reconciliation credit
      ({ accessToken, customerId } = await setupBillingTest({
        clockTime: '2025-01-15T00:00:00Z',
      }));

      // Query the API endpoint (this uses buildDraftLineItems internally)
      const result = await trpcQuery<any>(
        'billing.getNextScheduledPayment',
        undefined,
        accessToken
      );

      const lineItems = result.result?.data?.lineItems ?? [];
      const creditItems = lineItems.filter(
        (li: any) => li.itemType === 'credit'
      );

      // Platform Starter on Jan 15 → 1 credit. Must NOT be duplicated.
      expect(creditItems.length).toBe(1);
      // Credit should be negative
      expect(creditItems[0].amountUsd).toBeLessThan(0);
    });
  });

  // =========================================================================
  // Section 2: Platform Provider Chain
  // =========================================================================
  describe('Platform Provider Chain', () => {
    beforeEach(async () => {
      ({ accessToken, customerId } = await setupBillingTest({
        balance: 100,
      }));
      await restCall('POST', '/test/stripe/force-mock', { enabled: true });
      await restCall('POST', '/test/stripe/config/clear');
    });

    afterEach(async () => {
      await restCall('POST', '/test/stripe/config/clear');
      await restCall('POST', '/test/stripe/force-mock', { enabled: false });
    });

    it('should charge escrow for platform subscription (already done in setup)', async () => {
      // Platform was subscribed in setupBillingTest — verify billing record exists
      const records = await db.query.billingRecords.findMany({
        where: and(
          eq(billingRecords.customerId, customerId),
          eq(billingRecords.status, 'paid')
        ),
      });

      // Should have at least one paid record with $2 (platform starter)
      const paidPlatform = records.find(r => Number(r.amountUsdCents) === STARTER_PRICE);
      expect(paidPlatform).toBeDefined();

      // Verify the line item is for platform service
      const lineItems = await db.query.invoiceLineItems.findMany({
        where: eq(invoiceLineItems.billingRecordId, paidPlatform!.id),
      });
      const platformItem = lineItems.find(li => li.serviceType === 'platform');
      expect(platformItem).toBeDefined();

      await expectNoNotifications(customerId);
    });

    it('should leave platform payment pending when escrow has zero balance', async () => {
      // Reset to get a fresh customer with $0 balance and no platform subscription
      await resetTestData(TEST_WALLET);
      const freshToken = await login(TEST_WALLET);
      const freshCustomer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, TEST_WALLET),
      });
      const freshId = freshCustomer!.customerId;
      await ensureTestBalance(0, { walletAddress: TEST_WALLET }); // adds escrow with $0
      await clearNotifications(freshId);

      // Accept TOS (server enforces for platform subscriptions)
      await trpcMutation<any>('billing.acceptTos', {}, freshToken);

      // Subscribe platform — escrow exists but has $0, so payment fails
      await setClockTime('2025-01-15T00:00:00Z');
      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'starter' },
        freshToken
      );

      expect(result.result?.data?.paymentPending).toBe(true);

      // Verify pendingInvoiceId is set on customer
      const freshCustomerAfter = await db.query.customers.findFirst({
        where: eq(customers.customerId, freshId),
      });
      expect(freshCustomerAfter?.pendingInvoiceId).not.toBeNull();
    });

    it('should fallback to stripe when escrow has insufficient funds for platform', async () => {
      // Reset — create customer with $0 escrow (insufficient for $2 platform)
      await resetTestData(TEST_WALLET);
      const freshToken = await login(TEST_WALLET);
      await ensureTestBalance(0, { walletAddress: TEST_WALLET });

      // Accept TOS (server enforces for platform subscriptions)
      await trpcMutation<any>('billing.acceptTos', {}, freshToken);

      await setClockTime('2025-01-15T00:00:00Z');

      // Add stripe as payment method
      await addStripePaymentMethod(freshToken);

      // Subscribe platform — escrow insufficient ($0), stripe should handle
      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'starter' },
        freshToken
      );

      expect(result.result?.data?.paymentPending).toBe(false);
    });
  });

  // =========================================================================
  // Section 3: Platform Tier Changes
  // =========================================================================
  describe('Platform Tier Changes', () => {
    beforeEach(async () => {
      ({ accessToken, customerId } = await setupBillingTest({
        balance: 500,
      }));
    });

    it('should upgrade platform Starter→Pro with pro-rated charge', async () => {
      // Platform was subscribed as Starter in setup.
      await setClockTime('2025-01-15T00:00:00Z');

      // Upgrade to Pro
      const result = await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'platform', newTier: 'pro' },
        accessToken
      );

      expect(result.result?.data?.success).toBe(true);
      expect(result.result?.data?.newTier).toBe('pro');

      // Verify customer platform tier changed
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.platformTier).toBe('pro');

      // Verify pro-rated billing record exists
      const records = await db.query.billingRecords.findMany({
        where: and(
          eq(billingRecords.customerId, customerId),
          eq(billingRecords.status, 'paid')
        ),
      });
      // Should have 2 paid records: initial subscription + upgrade
      expect(records.length).toBeGreaterThanOrEqual(2);

      await expectNoNotifications(customerId);
    });

    it('should schedule platform downgrade Pro→Starter', async () => {
      await setClockTime('2025-01-15T00:00:00Z');

      // Upgrade to Pro first
      await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'platform', newTier: 'pro' },
        accessToken
      );

      // Schedule downgrade
      const result = await trpcMutation<any>(
        'services.scheduleTierDowngrade',
        { serviceType: 'platform', newTier: 'starter' },
        accessToken
      );

      expect(result.result?.data?.success).toBe(true);

      // Verify scheduled
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.platformTier).toBe('pro');
      expect(customer?.scheduledPlatformTier).toBe('starter');

      // DRAFT should show scheduled tier price ($2 = STARTER_PRICE cents)
      const drafts = await db.query.billingRecords.findMany({
        where: and(
          eq(billingRecords.customerId, customerId),
          eq(billingRecords.status, 'draft')
        ),
      });
      expect(drafts.length).toBeGreaterThanOrEqual(1);

      const draftItems = await db.query.invoiceLineItems.findMany({
        where: eq(invoiceLineItems.billingRecordId, drafts[0].id),
      });
      const platformItem = draftItems.find(
        li => li.serviceType === 'platform'
      );
      expect(platformItem).toBeDefined();
      expect(Number(platformItem!.amountUsdCents)).toBe(STARTER_PRICE); // Starter = $2

      await expectNoNotifications(customerId);
    });

    it('should apply scheduled platform downgrade on 1st of month', async () => {
      await setClockTime('2025-01-15T00:00:00Z');

      // Upgrade then schedule downgrade
      await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'platform', newTier: 'pro' },
        accessToken
      );
      await trpcMutation<any>(
        'services.scheduleTierDowngrade',
        { serviceType: 'platform', newTier: 'starter' },
        accessToken
      );

      // Advance to 1st of next month
      await setClockTime('2025-02-01T00:00:00Z');
      const result = await runPeriodicBillingJob(customerId);
      expect(result.success).toBe(true);

      // Verify tier changed. Poll because runPeriodicBillingJob is
      // fire-and-forget on the GM side: the call returns once the tick
      // is queued, but the customer-row write commits on a subsequent
      // GM iteration. A single read can race that commit.
      const customer = await waitForState(
        () => db.query.customers.findFirst({
          where: eq(customers.customerId, customerId),
        }),
        (c) => c?.platformTier === 'starter' && c?.scheduledPlatformTier === null,
        `customer.platformTier='starter' & scheduledPlatformTier=null after billing tick`,
      );
      expect(customer?.platformTier).toBe('starter');
      expect(customer?.scheduledPlatformTier).toBeNull();

      await expectNoNotifications(customerId);
    });
  });

  // =========================================================================
  // Section 4: Platform Cancellation
  // =========================================================================
  describe('Platform Cancellation', () => {
    beforeEach(async () => {
      ({ accessToken, customerId } = await setupBillingTest());
    });

    it('should schedule platform cancellation for end of billing period', async () => {
      await setClockTime('2025-01-15T00:00:00Z');

      const result = await trpcMutation<any>(
        'services.scheduleCancellation',
        { serviceType: 'platform' },
        accessToken
      );

      expect(result.result?.data?.success).toBe(true);

      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.platformCancellationScheduledFor).toBeTruthy();
      // Platform is always-on: tier stays set until cancellation processes
      expect(customer?.platformTier).not.toBeNull();

      await expectNoNotifications(customerId);
    });

    it('should undo scheduled platform cancellation', async () => {
      await setClockTime('2025-01-15T00:00:00Z');

      // Schedule then undo
      await trpcMutation<any>(
        'services.scheduleCancellation',
        { serviceType: 'platform' },
        accessToken
      );
      const result = await trpcMutation<any>(
        'services.undoCancellation',
        { serviceType: 'platform' },
        accessToken
      );

      expect(result.result?.data?.success).toBe(true);

      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.platformCancellationScheduledFor).toBeNull();
      // Platform is active: tier is set
      expect(customer?.platformTier).not.toBeNull();

      await expectNoNotifications(customerId);
    });

    it('should process scheduled platform cancellation on 1st of month', async () => {
      await setClockTime('2025-01-15T00:00:00Z');

      await trpcMutation<any>(
        'services.scheduleCancellation',
        { serviceType: 'platform' },
        accessToken
      );

      // Advance to 1st
      await setClockTime('2025-02-01T00:00:00Z');
      const result = await runPeriodicBillingJob(customerId);
      expect(result.success).toBe(true);

      // Poll for cancellation-apply commit (GM-async).
      const customer = await waitForState(
        () => db.query.customers.findFirst({
          where: eq(customers.customerId, customerId),
        }),
        (c) => !!c?.platformCancellationEffectiveAt && c?.platformCancellationScheduledFor === null,
        `customer.platformCancellationEffectiveAt set & scheduledFor cleared`,
      );
      expect(customer?.platformCancellationEffectiveAt).toBeTruthy();
      expect(customer?.platformCancellationScheduledFor).toBeNull();

      await expectNoNotifications(customerId);
    });

    it('should remove platform subscription line item from DRAFT when cancelled', async () => {
      await setClockTime('2025-01-15T00:00:00Z');

      // Get DRAFT before cancellation
      const draftsBefore = await db.query.billingRecords.findMany({
        where: and(
          eq(billingRecords.customerId, customerId),
          eq(billingRecords.status, 'draft')
        ),
      });
      const itemsBefore = await db.query.invoiceLineItems.findMany({
        where: eq(invoiceLineItems.billingRecordId, draftsBefore[0].id),
      });
      const platformItemBefore = itemsBefore.find(
        li => li.serviceType === 'platform'
      );
      expect(platformItemBefore).toBeDefined();

      // Schedule cancellation
      await trpcMutation<any>(
        'services.scheduleCancellation',
        { serviceType: 'platform' },
        accessToken
      );

      // DRAFT should no longer include platform subscription
      const itemsAfter = await db.query.invoiceLineItems.findMany({
        where: eq(invoiceLineItems.billingRecordId, draftsBefore[0].id),
      });
      const platformItemAfter = itemsAfter.find(
        li => li.serviceType === 'platform' && li.itemType?.startsWith('subscription_')
      );
      expect(platformItemAfter).toBeUndefined();

      await expectNoNotifications(customerId);
    });
  });

  // =========================================================================
  // Section 5: Auto-Provisioned Services
  // =========================================================================
  describe('Auto-Provisioned Services', () => {
    beforeEach(async () => {
      // Platform subscribed; seal/grpc/graphql auto-provisioned (disabled)
      ({ accessToken, customerId } = await setupBillingTest());
    });

    it('should auto-provision seal service when platform is subscribed', async () => {
      // After setupBillingTest, seal should be auto-provisioned (disabled)
      const sealService = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });

      expect(sealService).toBeDefined();
      expect(sealService?.isUserEnabled).toBe(false);
      // tier and paidOnce are on customers table (platform-level), not service instances

      await expectNoNotifications(customerId);
    });

    it('should cancel platform while auto-provisioned seal remains enabled', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Enable the auto-provisioned seal service
      await trpcMutation<any>(
        'services.toggleService',
        { serviceType: 'seal', enabled: true },
        accessToken
      );

      // Cancel platform only
      await trpcMutation<any>(
        'services.scheduleCancellation',
        { serviceType: 'platform' },
        accessToken
      );

      // Platform should be scheduled for cancellation
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.platformCancellationScheduledFor).toBeTruthy();

      // Seal should be unaffected (still enabled)
      const sealService = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      // cancellationScheduledFor is platform-level, not on service instances
      expect(sealService?.state).toBe('enabled');

      await expectNoNotifications(customerId);
    });

    it('should run periodic billing for platform while seal stays active', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Enable the auto-provisioned seal service
      await trpcMutation<any>(
        'services.toggleService',
        { serviceType: 'seal', enabled: true },
        accessToken
      );

      // Advance to 1st of next month
      await setClockTime('2025-02-01T00:00:00Z');
      const result = await runPeriodicBillingJob(customerId);
      expect(result.success).toBe(true);

      // Platform should still be active (tier set, no cancellation)
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.platformTier).not.toBeNull();
      expect(customer?.platformCancellationEffectiveAt).toBeNull();

      // Seal should still be active
      const seal = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(seal?.state).toBe('enabled');

      await expectNoNotifications(customerId);
    });
  });
});
