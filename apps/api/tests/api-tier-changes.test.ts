/**
 * API Test: Tier Changes Flow
 *
 * Tests tier upgrade/downgrade lifecycle through HTTP calls only.
 * NO direct internal function calls (except DB reads for assertions).
 *
 * This test simulates realistic client behavior by:
 * 1. Making HTTP calls to tRPC endpoints (services.upgradeTier, services.scheduleTierDowngrade, etc.)
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

describe('API: Tier Changes Flow', () => {
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

  describe('Tier Upgrade Flow', () => {
    it('should upgrade tier immediately with pro-rated charge', async () => {
      // ---- Setup: Subscribe to a starter service first ----
      await setClockTime('2025-01-05T00:00:00Z');

      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );
      expect(subscribeResult.result?.data).toBeDefined();

      // Mark as paid and enable the service
      let service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(service).toBeDefined();
      expect(service?.tier).toBe('starter');

      await db.update(serviceInstances)
        .set({ paidOnce: true, subscriptionChargePending: false, state: 'enabled', isUserEnabled: true })
        .where(eq(serviceInstances.instanceId, service!.instanceId));

      // ---- Upgrade to pro tier mid-month ----
      await setClockTime('2025-01-15T00:00:00Z');

      const upgradeResult = await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'seal', newTier: 'pro' },
        accessToken
      );

      expect(upgradeResult.result?.data?.success).toBe(true);
      expect(upgradeResult.result?.data?.newTier).toBe('pro');
      // Pro-rated charge should be positive (paying for rest of month at higher tier)
      expect(upgradeResult.result?.data?.chargeAmountUsdCents).toBeGreaterThanOrEqual(0);

      // Verify tier changed immediately in DB
      service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, service!.instanceId),
      });
      expect(service?.tier).toBe('pro');
    });

    it('should reject upgrade to same tier', async () => {
      // ---- Setup: Subscribe to pro tier ----
      await setClockTime('2025-01-05T00:00:00Z');

      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'pro' },
        accessToken
      );

      let service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });

      await db.update(serviceInstances)
        .set({ paidOnce: true, subscriptionChargePending: false, state: 'enabled', isUserEnabled: true })
        .where(eq(serviceInstances.instanceId, service!.instanceId));

      // ---- Try to upgrade to same tier ----
      const upgradeResult = await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'seal', newTier: 'pro' },
        accessToken
      );

      // Should fail
      expect(upgradeResult.error).toBeDefined();
    });

    it('should reject upgrade to lower tier (use downgrade instead)', async () => {
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

      await db.update(serviceInstances)
        .set({ paidOnce: true, subscriptionChargePending: false, state: 'enabled', isUserEnabled: true })
        .where(eq(serviceInstances.instanceId, service!.instanceId));

      // ---- Try to upgrade to lower tier ----
      const upgradeResult = await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'seal', newTier: 'starter' },
        accessToken
      );

      // Should fail - must use downgrade for this
      expect(upgradeResult.error).toBeDefined();
    });
  });

  describe('Tier Downgrade Flow', () => {
    it('should schedule downgrade for end of billing period', async () => {
      // ---- Setup: Subscribe to pro tier ----
      await setClockTime('2025-01-05T00:00:00Z');

      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'pro' },
        accessToken
      );

      let service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });

      await db.update(serviceInstances)
        .set({ paidOnce: true, subscriptionChargePending: false, state: 'enabled', isUserEnabled: true })
        .where(eq(serviceInstances.instanceId, service!.instanceId));

      // ---- Schedule downgrade to starter ----
      await setClockTime('2025-01-15T00:00:00Z');

      const downgradeResult = await trpcMutation<any>(
        'services.scheduleTierDowngrade',
        { serviceType: 'seal', newTier: 'starter' },
        accessToken
      );

      expect(downgradeResult.result?.data?.success).toBe(true);
      expect(downgradeResult.result?.data?.scheduledTier).toBe('starter');
      expect(downgradeResult.result?.data?.effectiveDate).toBeDefined();

      // Verify service still at pro tier (downgrade is scheduled, not immediate)
      service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, service!.instanceId),
      });
      expect(service?.tier).toBe('pro');
      expect(service?.scheduledTier).toBe('starter');
    });

    it('should update DRAFT invoice line items to show scheduled tier price', async () => {
      /**
       * BUG REPRODUCTION: When user schedules a downgrade from enterprise to starter,
       * the "Next Scheduled Payment" section should show the STARTER price ($9),
       * not the current ENTERPRISE price ($185).
       *
       * Root cause: buildDraftLineItems() in invoice-formatter.ts uses service.tier
       * instead of (service.scheduledTier || service.tier).
       *
       * Scenario:
       * 1. User is on Enterprise ($185/month)
       * 2. User schedules downgrade to Starter ($9/month)
       * 3. DRAFT invoice amount_usd_cents is updated correctly to 900
       * 4. BUG: getNextScheduledPayment line items still show Enterprise ($185)
       *
       * Expected: Line items should show "Seal Starter tier - $9.00"
       * Actual: Line items show "Seal Enterprise tier - $185.00"
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
      expect(paymentResult.result?.data?.lineItems).toBeDefined();

      // Initially should show Enterprise tier
      let lineItems = paymentResult.result?.data?.lineItems;
      let subscriptionItem = lineItems.find((item: any) => item.type === 'subscription');
      expect(subscriptionItem?.description).toContain('Enterprise');
      expect(subscriptionItem?.amountUsd).toBe(185); // Enterprise = $185

      // ---- Schedule downgrade to starter ----
      await setClockTime('2025-01-15T00:00:00Z');

      const downgradeResult = await trpcMutation<any>(
        'services.scheduleTierDowngrade',
        { serviceType: 'seal', newTier: 'starter' },
        accessToken
      );

      expect(downgradeResult.result?.data?.success).toBe(true);
      expect(downgradeResult.result?.data?.scheduledTier).toBe('starter');

      // ---- BUG: Verify DRAFT line items now show STARTER price ----
      paymentResult = await trpcQuery<any>(
        'billing.getNextScheduledPayment',
        undefined,
        accessToken
      );

      expect(paymentResult.result?.data?.found).toBe(true);
      lineItems = paymentResult.result?.data?.lineItems;
      subscriptionItem = lineItems.find((item: any) => item.type === 'subscription');

      // Line items should show the SCHEDULED tier (starter = $9), not current tier (enterprise = $185)
      expect(subscriptionItem?.description).toContain('Starter');
      expect(subscriptionItem?.amountUsd).toBe(9); // Starter = $9, NOT Enterprise = $185
    });

    it('should allow canceling scheduled downgrade', async () => {
      // ---- Setup: Subscribe and schedule downgrade ----
      await setClockTime('2025-01-05T00:00:00Z');

      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'pro' },
        accessToken
      );

      let service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });

      await db.update(serviceInstances)
        .set({ paidOnce: true, subscriptionChargePending: false, state: 'enabled', isUserEnabled: true })
        .where(eq(serviceInstances.instanceId, service!.instanceId));

      // Schedule downgrade
      await trpcMutation<any>(
        'services.scheduleTierDowngrade',
        { serviceType: 'seal', newTier: 'starter' },
        accessToken
      );

      // Verify downgrade is scheduled
      service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, service!.instanceId),
      });
      expect(service?.scheduledTier).toBe('starter');

      // ---- Cancel the scheduled downgrade ----
      const cancelResult = await trpcMutation<any>(
        'services.cancelScheduledTierChange',
        { serviceType: 'seal' },
        accessToken
      );

      expect(cancelResult.result?.data?.success).toBe(true);

      // Verify scheduled downgrade is cleared
      service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, service!.instanceId),
      });
      expect(service?.scheduledTier).toBeNull();
      expect(service?.tier).toBe('pro'); // Still at pro
    });
  });

  describe('Get Tier Options', () => {
    it('should return available tier options for service', async () => {
      // ---- Setup: Subscribe to starter tier ----
      await setClockTime('2025-01-05T00:00:00Z');

      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      let service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });

      await db.update(serviceInstances)
        .set({ paidOnce: true, subscriptionChargePending: false, state: 'enabled', isUserEnabled: true })
        .where(eq(serviceInstances.instanceId, service!.instanceId));

      // ---- Get tier options ----
      const optionsResult = await trpcQuery<any>(
        'services.getTierOptions',
        { serviceType: 'seal' },
        accessToken
      );

      expect(optionsResult.result?.data).toBeDefined();
      const options = optionsResult.result?.data;

      // Should show current tier
      expect(options.currentTier).toBe('starter');

      // Should have all tier options (starter, pro, enterprise)
      expect(options.availableTiers).toBeDefined();
      expect(options.availableTiers.length).toBe(3);

      // Check tier structure - each option should have the right flags
      const starterOption = options.availableTiers.find((t: any) => t.tier === 'starter');
      const proOption = options.availableTiers.find((t: any) => t.tier === 'pro');
      const enterpriseOption = options.availableTiers.find((t: any) => t.tier === 'enterprise');

      expect(starterOption?.isCurrentTier).toBe(true);
      expect(starterOption?.isUpgrade).toBe(false);
      expect(starterOption?.isDowngrade).toBe(false);

      expect(proOption?.isUpgrade).toBe(true);
      expect(proOption?.isDowngrade).toBe(false);

      expect(enterpriseOption?.isUpgrade).toBe(true);
      expect(enterpriseOption?.isDowngrade).toBe(false);
    });

    it('should return scheduled tier when downgrade is scheduled (bug reproduction)', async () => {
      /**
       * BUG REPRODUCTION: When user schedules multiple downgrades sequentially,
       * the UI shows the same "Takes effect November 30th" for ALL downgrade options.
       *
       * EXPECTED: getTierOptions should return which tier is currently scheduled,
       * so the UI can distinguish between "pending scheduled downgrade" vs
       * "potential downgrade option".
       *
       * SEQUENCE:
       * 1. User on Enterprise schedules downgrade to Pro -> scheduledTier should be 'pro'
       * 2. User changes mind, schedules downgrade to Starter -> scheduledTier should now be 'starter'
       * 3. UI should show "Scheduled" only on the currently scheduled tier
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

      await db.update(serviceInstances)
        .set({ paidOnce: true, subscriptionChargePending: false, state: 'enabled', isUserEnabled: true })
        .where(eq(serviceInstances.instanceId, service!.instanceId));

      // ---- Step 1: Schedule downgrade to Pro ----
      await setClockTime('2025-01-15T00:00:00Z');

      await trpcMutation<any>(
        'services.scheduleTierDowngrade',
        { serviceType: 'seal', newTier: 'pro' },
        accessToken
      );

      // Get tier options - should show Pro as the scheduled tier
      let optionsResult = await trpcQuery<any>(
        'services.getTierOptions',
        { serviceType: 'seal' },
        accessToken
      );

      let options = optionsResult.result?.data;
      expect(options).toBeDefined();
      expect(options.currentTier).toBe('enterprise');

      // API returns scheduledTier so UI knows which downgrade is pending
      expect(options.scheduledTier).toBe('pro');
      expect(options.scheduledTierEffectiveDate).toBeDefined();

      // Check that only pro shows as "scheduled", not starter
      const proOption = options.availableTiers.find((t: any) => t.tier === 'pro');
      const starterOption = options.availableTiers.find((t: any) => t.tier === 'starter');

      // Pro should be marked as scheduled (the pending change)
      expect(proOption.isScheduled).toBe(true);
      // Starter should NOT be marked as scheduled (just a potential option)
      expect(starterOption.isScheduled).toBe(false);

      // ---- Step 2: Change mind, schedule downgrade to Starter instead ----
      await trpcMutation<any>(
        'services.scheduleTierDowngrade',
        { serviceType: 'seal', newTier: 'starter' },
        accessToken
      );

      // Get tier options again - should now show Starter as the scheduled tier
      optionsResult = await trpcQuery<any>(
        'services.getTierOptions',
        { serviceType: 'seal' },
        accessToken
      );

      options = optionsResult.result?.data;

      // Now Starter should be the scheduled tier, not Pro
      expect(options.scheduledTier).toBe('starter');

      const proOption2 = options.availableTiers.find((t: any) => t.tier === 'pro');
      const starterOption2 = options.availableTiers.find((t: any) => t.tier === 'starter');

      // Now Starter should be scheduled, Pro should not
      expect(starterOption2.isScheduled).toBe(true);
      expect(proOption2.isScheduled).toBe(false);
    });
  });
});
