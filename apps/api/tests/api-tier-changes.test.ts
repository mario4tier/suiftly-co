/**
 * API Test: Tier Changes Flow
 *
 * Tests tier upgrade/downgrade lifecycle through HTTP calls only.
 * NO direct internal function calls (except DB reads for assertions).
 *
 * Tiers apply only to the platform subscription (starter / pro).
 * Non-platform services (seal, grpc, graphql) derive their limits from
 * the platform tier at runtime and have no tier of their own.
 *
 * This test simulates realistic client behavior by:
 * 1. Making HTTP calls to tRPC endpoints (services.upgradeTier, services.scheduleTierDowngrade, etc.)
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
} from './helpers/http.js';
import { TEST_WALLET } from './helpers/auth.js';
import { INVOICE_LINE_ITEM_TYPE } from '@suiftly/shared/constants';
import { PLATFORM_TIER_PRICES_USD_CENTS } from '@suiftly/shared/pricing';
import { expectNoNotifications } from './helpers/notifications.js';
import { setupBillingTest } from './helpers/setup.js';

const SUBSCRIPTION_ITEM_TYPES = [
  INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_STARTER,
  INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_PRO,
] as const;

describe('API: Tier Changes Flow', () => {
  const STARTER_PRICE = PLATFORM_TIER_PRICES_USD_CENTS.starter;
  const PRO_PRICE = PLATFORM_TIER_PRICES_USD_CENTS.pro;


  let accessToken: string;
  let customerId: number;

  beforeEach(async () => {
    // Platform is subscribed at starter tier; seal/grpc/graphql auto-provisioned (disabled)
    ({ accessToken, customerId } = await setupBillingTest());
  });

  afterEach(async () => {
    // Reset clock
    await resetClock();
    // Clean up via HTTP
    await resetTestData(TEST_WALLET);
  });

  describe('Tier Upgrade Flow', () => {
    it('should upgrade tier immediately with pro-rated charge', async () => {
      // Platform is already at starter tier from beforeEach
      await setClockTime('2025-01-05T00:00:00Z');

      // Verify platform state via customer record
      let customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer).toBeDefined();
      expect(customer?.platformTier).toBe('starter');
      expect(customer?.paidOnce).toBe(true);

      // ---- Upgrade to pro tier mid-month ----
      await setClockTime('2025-01-15T00:00:00Z');

      const upgradeResult = await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'platform', newTier: 'pro' },
        accessToken
      );

      expect(upgradeResult.result?.data?.success).toBe(true);
      expect(upgradeResult.result?.data?.newTier).toBe('pro');
      // Pro-rated charge should be positive (paying for rest of month at higher tier)
      expect(upgradeResult.result?.data?.chargeAmountUsdCents).toBeGreaterThanOrEqual(0);

      // Verify tier changed immediately in DB
      customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.platformTier).toBe('pro');

      await expectNoNotifications(customerId);
    });

    it('should reject upgrade to same tier', async () => {
      // Platform starts at starter; upgrade to pro first, then try same-tier upgrade
      await setClockTime('2025-01-05T00:00:00Z');
      await ensureTestBalance(100, { walletAddress: TEST_WALLET });

      await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'platform', newTier: 'pro' },
        accessToken
      );

      // ---- Try to upgrade to same tier ----
      const upgradeResult = await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'platform', newTier: 'pro' },
        accessToken
      );

      // Should fail
      expect(upgradeResult.error).toBeDefined();

      await expectNoNotifications(customerId);
    });

    it('should reject upgrade to lower tier (use downgrade instead)', async () => {
      // Platform starts at starter; upgrade to pro, then try to "upgrade" back to starter
      await setClockTime('2025-01-05T00:00:00Z');
      await ensureTestBalance(100, { walletAddress: TEST_WALLET });

      await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'platform', newTier: 'pro' },
        accessToken
      );

      // ---- Try to upgrade to lower tier ----
      const upgradeResult = await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'platform', newTier: 'starter' },
        accessToken
      );

      // Should fail - must use downgrade for this
      expect(upgradeResult.error).toBeDefined();

      await expectNoNotifications(customerId);
    });
  });

  describe('Tier Downgrade Flow', () => {
    it('should schedule downgrade for end of billing period', async () => {
      // Upgrade platform to pro first
      await setClockTime('2025-01-05T00:00:00Z');
      await ensureTestBalance(100, { walletAddress: TEST_WALLET });

      await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'platform', newTier: 'pro' },
        accessToken
      );

      // ---- Schedule downgrade to starter ----
      await setClockTime('2025-01-15T00:00:00Z');

      const downgradeResult = await trpcMutation<any>(
        'services.scheduleTierDowngrade',
        { serviceType: 'platform', newTier: 'starter' },
        accessToken
      );

      expect(downgradeResult.result?.data?.success).toBe(true);
      expect(downgradeResult.result?.data?.scheduledTier).toBe('starter');
      expect(downgradeResult.result?.data?.effectiveDate).toBeDefined();

      // Verify customer still at pro tier (downgrade is scheduled, not immediate)
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.platformTier).toBe('pro');
      expect(customer?.scheduledPlatformTier).toBe('starter');

      await expectNoNotifications(customerId);
    });

    it('should update DRAFT invoice line items to show scheduled tier price', async () => {
      /**
       * BUG REPRODUCTION: When user schedules a downgrade from pro to starter,
       * the "Next Scheduled Payment" section should show the STARTER price ($2),
       * not the current PRO price ($39).
       *
       * Root cause: buildDraftLineItems() in invoice-formatter.ts uses service.tier
       * instead of (service.scheduledTier || service.tier).
       *
       * Scenario:
       * 1. User is on Pro ($39/month)
       * 2. User schedules downgrade to Starter ($2/month)
       * 3. DRAFT invoice amount_usd_cents is updated correctly to STARTER_PRICE
       * 4. BUG: getNextScheduledPayment line items still show Pro ($39)
       *
       * Expected: Line items should show "Platform Starter tier - $2.00"
       * Actual: Line items show "Platform Pro tier - $39.00"
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
      expect(paymentResult.result?.data?.lineItems).toBeDefined();

      // Initially should show Pro tier
      let lineItems = paymentResult.result?.data?.lineItems;
      let subscriptionItem = lineItems.find(
        (item: any) => SUBSCRIPTION_ITEM_TYPES.includes(item.itemType) && item.service === 'platform'
      );
      expect(subscriptionItem?.itemType).toBe(INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_PRO);
      expect(subscriptionItem?.amountUsd).toBe(PRO_PRICE / 100); // Pro = $39

      // ---- Schedule downgrade to starter ----
      await setClockTime('2025-01-15T00:00:00Z');

      const downgradeResult = await trpcMutation<any>(
        'services.scheduleTierDowngrade',
        { serviceType: 'platform', newTier: 'starter' },
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
      subscriptionItem = lineItems.find(
        (item: any) => SUBSCRIPTION_ITEM_TYPES.includes(item.itemType) && item.service === 'platform'
      );

      // Line items should show the SCHEDULED tier (starter = $2), not current tier (pro = $39)
      expect(subscriptionItem?.itemType).toBe(INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_STARTER);
      expect(subscriptionItem?.amountUsd).toBe(STARTER_PRICE / 100); // Starter = $2, NOT Pro = $39

      await expectNoNotifications(customerId);
    });

    it('should allow canceling scheduled downgrade', async () => {
      // Upgrade then schedule downgrade
      await setClockTime('2025-01-05T00:00:00Z');
      await ensureTestBalance(100, { walletAddress: TEST_WALLET });

      await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'platform', newTier: 'pro' },
        accessToken
      );

      // Schedule downgrade
      await trpcMutation<any>(
        'services.scheduleTierDowngrade',
        { serviceType: 'platform', newTier: 'starter' },
        accessToken
      );

      // Verify downgrade is scheduled
      let customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.scheduledPlatformTier).toBe('starter');

      // ---- Cancel the scheduled downgrade ----
      const cancelResult = await trpcMutation<any>(
        'services.cancelScheduledTierChange',
        { serviceType: 'platform' },
        accessToken
      );

      expect(cancelResult.result?.data?.success).toBe(true);

      // Verify scheduled downgrade is cleared
      customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.scheduledPlatformTier).toBeNull();
      expect(customer?.platformTier).toBe('pro'); // Still at pro

      await expectNoNotifications(customerId);
    });
  });

  describe('Get Tier Options', () => {
    it('should return available tier options for platform service', async () => {
      // Platform starts at starter
      await setClockTime('2025-01-05T00:00:00Z');

      // ---- Get tier options ----
      const optionsResult = await trpcQuery<any>(
        'services.getTierOptions',
        { serviceType: 'platform' },
        accessToken
      );

      expect(optionsResult.result?.data).toBeDefined();
      const options = optionsResult.result?.data;

      // Should show current tier
      expect(options.currentTier).toBe('starter');

      // Platform has exactly 2 tiers (starter and pro)
      expect(options.availableTiers).toBeDefined();
      expect(options.availableTiers.length).toBe(2);

      // Check tier structure
      const starterOption = options.availableTiers.find((t: any) => t.tier === 'starter');
      const proOption = options.availableTiers.find((t: any) => t.tier === 'pro');

      expect(starterOption?.isCurrentTier).toBe(true);
      expect(starterOption?.isUpgrade).toBe(false);
      expect(starterOption?.isDowngrade).toBe(false);

      expect(proOption?.isUpgrade).toBe(true);
      expect(proOption?.isDowngrade).toBe(false);

      await expectNoNotifications(customerId);
    });

    it('should return scheduled tier when downgrade is scheduled (bug reproduction)', async () => {
      /**
       * BUG REPRODUCTION: When user schedules a downgrade, the UI should show
       * which tier is currently scheduled so it can distinguish between
       * "pending scheduled downgrade" vs "potential downgrade option".
       *
       * SEQUENCE:
       * 1. User on Pro schedules downgrade to Starter -> scheduledTier should be 'starter'
       * 2. UI should show "Scheduled" only on the currently scheduled tier
       */
      // ---- Setup: Upgrade platform to pro ----
      await setClockTime('2025-01-05T00:00:00Z');
      await ensureTestBalance(100, { walletAddress: TEST_WALLET });

      await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'platform', newTier: 'pro' },
        accessToken
      );

      // ---- Schedule downgrade to starter ----
      await setClockTime('2025-01-15T00:00:00Z');

      await trpcMutation<any>(
        'services.scheduleTierDowngrade',
        { serviceType: 'platform', newTier: 'starter' },
        accessToken
      );

      // Get tier options — should show Starter as the scheduled tier
      const optionsResult = await trpcQuery<any>(
        'services.getTierOptions',
        { serviceType: 'platform' },
        accessToken
      );

      const options = optionsResult.result?.data;
      expect(options).toBeDefined();
      expect(options.currentTier).toBe('pro');

      // API returns scheduledTier so UI knows which downgrade is pending
      expect(options.scheduledTier).toBe('starter');
      expect(options.scheduledTierEffectiveDate).toBeDefined();

      // Starter should be marked as scheduled (the pending change)
      const starterOption = options.availableTiers.find((t: any) => t.tier === 'starter');
      expect(starterOption.isScheduled).toBe(true);

      await expectNoNotifications(customerId);
    });
  });
});
