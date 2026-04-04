/**
 * API Test: Platform Billing Integration
 *
 * Tests platform subscription billing through HTTP calls, mirroring the
 * seal-focused billing tests to ensure parity.
 *
 * Section 1: Partial-month credit bug reproduction (both mode)
 * Section 2: Platform provider chain (escrow, stripe, pending)
 * Section 3: Platform tier changes (upgrade/downgrade)
 * Section 4: Platform cancellation lifecycle
 * Section 5: Both-mode sanity (platform + seal coexistence)
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
  subscribeAndEnable,
  runPeriodicBillingJob,
  subscribePlatform,
} from './helpers/http.js';
import { TEST_WALLET } from './helpers/auth.js';
import { expectNoNotifications } from './helpers/notifications.js';
import { setupBillingTest } from './helpers/setup.js';

describe('API: Platform Billing Integration', () => {
  let accessToken: string;
  let customerId: number;

  afterEach(async () => {
    await resetClock();
    await resetTestData(TEST_WALLET);
  });

  // =========================================================================
  // Section 1: Partial Month Credit Bug (Both Mode)
  // =========================================================================
  describe('Partial Month Credits (Both Mode)', () => {
    beforeEach(async () => {
      // Subscribe platform mid-month so it gets a partial-month credit
      ({ accessToken, customerId } = await setupBillingTest({
        mode: 'both',
        clockTime: '2025-01-15T00:00:00Z',
      }));
    });

    it('should create TWO reconciliation credits when both subs mid-month', async () => {
      // Platform was subscribed at Jan 15 in setupBillingTest.
      // Now subscribe seal at the same date.
      await setClockTime('2025-01-15T00:00:00Z');
      await subscribeAndEnable('seal', 'starter', accessToken);

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

      // Should have TWO credits: one for platform, one for seal
      // Platform Starter = $1 = 100 cents
      // Seal Starter = $9 = 900 cents
      // Jan: 31 days, subscribed day 15 → daysUsed = 17, daysNotUsed = 14
      // Platform credit = floor(100 * 14 / 31) = 45 cents
      // Seal credit = floor(900 * 14 / 31) = 406 cents
      expect(credits.length).toBe(2);

      const platformCredit = credits.find(c =>
        c.description?.includes('platform')
      );
      const sealCredit = credits.find(c =>
        c.description?.includes('seal')
      );

      expect(platformCredit).toBeDefined();
      expect(sealCredit).toBeDefined();

      expect(Number(platformCredit!.originalAmountUsdCents)).toBe(45);
      expect(Number(sealCredit!.originalAmountUsdCents)).toBe(406);
    });

    it('should include credit line items in DRAFT for credits with remaining balance', async () => {
      // Subscribe seal mid-month (platform already subscribed mid-month from setup)
      await setClockTime('2025-01-15T00:00:00Z');
      await subscribeAndEnable('seal', 'starter', accessToken);

      // Both credits were created (verified by prior test), but the platform
      // credit (45 cents) was consumed during seal subscription payment
      // (credits are a shared customer pool). Only the seal credit (406 cents)
      // has remaining balance.

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

      // Should have subscription line items for BOTH services
      const platformSub = lineItems.find(
        li => li.serviceType === 'platform' && li.itemType?.startsWith('subscription_')
      );
      const sealSub = lineItems.find(
        li => li.serviceType === 'seal' && li.itemType?.startsWith('subscription_')
      );
      expect(platformSub).toBeDefined();
      expect(sealSub).toBeDefined();

      // Should have 1 credit line item (seal only — platform credit was consumed)
      const creditItems = lineItems.filter(li => li.itemType === 'credit');
      expect(creditItems.length).toBe(1);

      const sealCreditItem = creditItems.find(
        li => li.description?.includes('seal')
      );
      expect(sealCreditItem).toBeDefined();
      expect(Number(sealCreditItem!.amountUsdCents)).toBe(-406);

      // DRAFT total is net (includes credit deductions)
      // Platform ($1) + Seal ($9) - Seal credit ($4.06) = $5.94
      expect(Number(drafts[0].amountUsdCents)).toBe(594);
    });
  });

  // =========================================================================
  // Section 1B: No duplicate credits in Next Scheduled Payment
  // =========================================================================
  describe('No Duplicate Credits in API Response', () => {
    it('should return exactly one credit line item per credit in getNextScheduledPayment', async () => {
      // Subscribe platform mid-month to produce a reconciliation credit
      ({ accessToken, customerId } = await setupBillingTest({
        mode: 'platform-only',
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
        mode: 'platform-only',
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
      // billing_records has no description column; identify by amount ($1 = 100 cents)
      const records = await db.query.billingRecords.findMany({
        where: and(
          eq(billingRecords.customerId, customerId),
          eq(billingRecords.status, 'paid')
        ),
      });

      // Should have at least one paid record with $1 (platform starter)
      const paidPlatform = records.find(r => Number(r.amountUsdCents) === 100);
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
      // Reset to get a customer with escrow but $0 balance
      await resetTestData(TEST_WALLET);
      const { accessToken: freshToken, customerId: freshId } =
        await setupBillingTest({ mode: 'seal-only', balance: 0 });

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

      // Verify subPendingInvoiceId is set
      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, freshId),
          eq(serviceInstances.serviceType, 'platform')
        ),
      });
      expect(service?.subPendingInvoiceId).not.toBeNull();
    });

    it('should fallback to stripe when escrow has insufficient funds for platform', async () => {
      // Reset — create customer with $0 escrow (insufficient for $1 platform)
      await resetTestData(TEST_WALLET);
      const { accessToken: freshToken } = await setupBillingTest({
        mode: 'seal-only',
        balance: 0,
      });

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
        mode: 'platform-only',
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

      // Verify service tier changed
      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'platform')
        ),
      });
      expect(service?.tier).toBe('pro');

      // Verify pro-rated billing record exists
      const records = await db.query.billingRecords.findMany({
        where: and(
          eq(billingRecords.customerId, customerId),
          eq(billingRecords.status, 'paid')
        ),
      });
      // Should have 2 paid records: initial subscription + upgrade
      const paidRecords = records.filter(
        r => r.status === 'paid' && r.description !== null
      );
      expect(paidRecords.length).toBeGreaterThanOrEqual(2);

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
      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'platform')
        ),
      });
      expect(service?.tier).toBe('pro');
      expect(service?.scheduledTier).toBe('starter');

      // DRAFT should show scheduled tier price ($1 = 100 cents)
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
      expect(Number(platformItem!.amountUsdCents)).toBe(100); // Starter = $1

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

      // Verify tier changed
      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'platform')
        ),
      });
      expect(service?.tier).toBe('starter');
      expect(service?.scheduledTier).toBeNull();

      await expectNoNotifications(customerId);
    });
  });

  // =========================================================================
  // Section 4: Platform Cancellation
  // =========================================================================
  describe('Platform Cancellation', () => {
    beforeEach(async () => {
      ({ accessToken, customerId } = await setupBillingTest({
        mode: 'platform-only',
      }));
    });

    it('should schedule platform cancellation for end of billing period', async () => {
      await setClockTime('2025-01-15T00:00:00Z');

      const result = await trpcMutation<any>(
        'services.scheduleCancellation',
        { serviceType: 'platform' },
        accessToken
      );

      expect(result.result?.data?.success).toBe(true);

      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'platform')
        ),
      });
      expect(service?.cancellationScheduledFor).toBeTruthy();
      // Platform is always-on: state stays enabled until cancellation processes
      expect(service?.state).toBe('enabled');

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

      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'platform')
        ),
      });
      expect(service?.cancellationScheduledFor).toBeNull();
      expect(service?.state).toBe('enabled');

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

      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'platform')
        ),
      });
      expect(service?.state).toBe('cancellation_pending');
      expect(service?.cancellationScheduledFor).toBeNull();
      expect(service?.cancellationEffectiveAt).toBeTruthy();

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
  // Section 5: Both-Mode Sanity
  // =========================================================================
  describe('Both Mode Sanity', () => {
    beforeEach(async () => {
      ({ accessToken, customerId } = await setupBillingTest({ mode: 'both' }));
    });

    it('should have separate billing records for platform and seal', async () => {
      await setClockTime('2025-01-05T00:00:00Z');
      await subscribeAndEnable('seal', 'starter', accessToken);

      const records = await db.query.billingRecords.findMany({
        where: and(
          eq(billingRecords.customerId, customerId),
          eq(billingRecords.status, 'paid')
        ),
      });

      // Identify platform vs seal records by their line items' service_type
      let platformRecordId: number | null = null;
      let sealRecordId: number | null = null;
      for (const r of records) {
        const items = await db.query.invoiceLineItems.findMany({
          where: eq(invoiceLineItems.billingRecordId, r.id),
        });
        if (items.some(li => li.serviceType === 'platform')) platformRecordId = r.id;
        if (items.some(li => li.serviceType === 'seal')) sealRecordId = r.id;
      }

      expect(platformRecordId).not.toBeNull();
      expect(sealRecordId).not.toBeNull();
      expect(platformRecordId).not.toBe(sealRecordId);

      // Verify amounts
      const platformRecord = records.find(r => r.id === platformRecordId)!;
      const sealRecord = records.find(r => r.id === sealRecordId)!;
      expect(Number(platformRecord.amountUsdCents)).toBe(100); // $1
      expect(Number(sealRecord.amountUsdCents)).toBe(900); // $9

      await expectNoNotifications(customerId);
    });

    it('should have separate DRAFT line items for platform and seal', async () => {
      await setClockTime('2025-01-05T00:00:00Z');
      await subscribeAndEnable('seal', 'starter', accessToken);

      const drafts = await db.query.billingRecords.findMany({
        where: and(
          eq(billingRecords.customerId, customerId),
          eq(billingRecords.status, 'draft')
        ),
      });
      expect(drafts.length).toBeGreaterThanOrEqual(1);

      const lineItems = await db.query.invoiceLineItems.findMany({
        where: eq(invoiceLineItems.billingRecordId, drafts[0].id),
      });

      const platformItem = lineItems.find(
        li => li.serviceType === 'platform' && li.itemType?.startsWith('subscription_')
      );
      const sealItem = lineItems.find(
        li => li.serviceType === 'seal' && li.itemType?.startsWith('subscription_')
      );

      expect(platformItem).toBeDefined();
      expect(sealItem).toBeDefined();

      // Platform Starter = $1 = 100 cents
      expect(Number(platformItem!.amountUsdCents)).toBe(100);
      // Seal Starter = $9 = 900 cents
      expect(Number(sealItem!.amountUsdCents)).toBe(900);

      // DRAFT total is net (includes credit deductions)
      // Platform ($1) + Seal ($9) - seal credit = net
      // Seal subscribed Jan 5: credit = floor(900 * 4 / 31) = 116
      // Net = 100 + 900 - 116 = 884
      expect(Number(drafts[0].amountUsdCents)).toBe(884);

      await expectNoNotifications(customerId);
    });

    it('should cancel platform independently of seal', async () => {
      await setClockTime('2025-01-05T00:00:00Z');
      await subscribeAndEnable('seal', 'starter', accessToken);

      // Cancel platform only
      await trpcMutation<any>(
        'services.scheduleCancellation',
        { serviceType: 'platform' },
        accessToken
      );

      // Platform should be scheduled for cancellation
      const platformService = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'platform')
        ),
      });
      expect(platformService?.cancellationScheduledFor).toBeTruthy();

      // Seal should be unaffected
      const sealService = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(sealService?.cancellationScheduledFor).toBeNull();
      expect(sealService?.state).toBe('enabled');

      await expectNoNotifications(customerId);
    });

    it('should run periodic billing for both platform and seal', async () => {
      await setClockTime('2025-01-05T00:00:00Z');
      await subscribeAndEnable('seal', 'starter', accessToken);

      // Advance to 1st of next month
      await setClockTime('2025-02-01T00:00:00Z');
      const result = await runPeriodicBillingJob(customerId);
      expect(result.success).toBe(true);

      // Both services should still be active
      const services = await db.query.serviceInstances.findMany({
        where: eq(serviceInstances.customerId, customerId),
      });
      const platform = services.find(s => s.serviceType === 'platform');
      const seal = services.find(s => s.serviceType === 'seal');

      expect(platform?.state).toBe('enabled');
      expect(seal?.state).toBe('enabled');

      await expectNoNotifications(customerId);
    });
  });
});
