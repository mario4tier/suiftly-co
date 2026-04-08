/**
 * API Test: Reconciliation Credit Bug
 *
 * BUG REPRODUCTION: When user changes platform tier while initial payment is pending,
 * the reconciliation credit should be based on the tier that was ACTUALLY CHARGED,
 * not the original subscription tier.
 *
 * Scenario:
 * 1. User subscribes to platform starter ($2/month) - payment fails (no funds)
 * 2. User upgrades to platform pro ($39/month) - tier changes, no payment needed (paidOnce=false)
 * 3. User deposits funds -> reconcilePayments runs
 * 4. BUG: Credit is calculated based on starter ($2) instead of pro ($39)
 *
 * Expected: Credit should be ~$2.51 (pro × 2/31 days)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import { customers, customerCredits, billingRecords } from '@suiftly/database/schema';
import { eq, and, desc, ne } from 'drizzle-orm';
import {
  setClockTime,
  resetClock,
  trpcMutation,
  resetTestData,
  reconcilePendingPayments,
} from './helpers/http.js';
import { login, TEST_WALLET } from './helpers/auth.js';
import { PLATFORM_TIER_PRICES_USD_CENTS } from '@suiftly/shared/pricing';
import { expectNoNotifications, clearNotifications } from './helpers/notifications.js';

describe('API: Reconciliation Credit Calculation', () => {
  let accessToken: string;
  let customerId: number;

  beforeEach(async () => {
    // Set up customer WITHOUT subscribing to platform — these tests need to test platform billing
    await resetClock();
    await resetTestData(TEST_WALLET);
    accessToken = await login(TEST_WALLET);

    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, TEST_WALLET),
    });
    if (!customer) throw new Error('Test customer not found after login');
    customerId = customer.customerId;

    await clearNotifications(customerId);
  });

  afterEach(async () => {
    await resetClock();
    await resetTestData(TEST_WALLET);
  });

  describe('Tier Change Before Payment', () => {
    it('should calculate reconciliation credit based on tier that was charged, not original tier', async () => {
      /**
       * BUG REPRODUCTION:
       * When user subscribes to tier A, changes to tier B before paying, then pays,
       * the credit should be based on tier B (the tier actually charged),
       * not tier A (the original subscription).
       */

      // ---- Step 1: Subscribe to platform starter with no funds ----
      await setClockTime('2025-01-03T00:00:00Z'); // Day 3 of January

      // Accept TOS but don't deposit funds
      await trpcMutation<any>('billing.acceptTos', {}, accessToken);

      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'starter' },
        accessToken
      );

      // Subscription created but payment pending (due to insufficient funds)
      expect(subscribeResult.result?.data).toBeDefined();
      expect(subscribeResult.result?.data?.paymentPending).toBe(true);

      // Verify customer billing state
      let customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.platformTier).toBe('starter');
      expect(customer?.paidOnce).toBe(false);
      expect(customer?.pendingInvoiceId).not.toBeNull();

      // No credits should exist yet (payment failed)
      let credits = await db.query.customerCredits.findMany({
        where: eq(customerCredits.customerId, customerId),
      });
      expect(credits.length).toBe(0);

      // ---- Step 2: Upgrade to pro tier (still no payment) ----
      // Since paidOnce=false, tier change should be immediate without charge
      const upgradeResult = await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'platform', newTier: 'pro' },
        accessToken
      );

      expect(upgradeResult.result?.data?.success).toBe(true);
      expect(upgradeResult.result?.data?.newTier).toBe('pro');
      expect(upgradeResult.result?.data?.chargeAmountUsdCents).toBe(0); // No charge for unpaid users

      // Verify tier changed
      customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.platformTier).toBe('pro');
      expect(customer?.paidOnce).toBe(false);
      // pendingInvoiceId should still be set (not yet paid)
      expect(customer?.pendingInvoiceId).not.toBeNull();

      // Still no credits
      credits = await db.query.customerCredits.findMany({
        where: eq(customerCredits.customerId, customerId),
      });
      expect(credits.length).toBe(0);

      // ---- Step 3: Add escrow payment method + deposit funds ----
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'escrow' },
        accessToken
      );

      const depositResult = await trpcMutation<any>(
        'billing.deposit',
        { amountUsd: 50 }, // $50 to cover pro ($39)
        accessToken
      );

      expect(depositResult.result?.data?.success).toBe(true);

      // Trigger reconciliation (now async via GM)
      await reconcilePendingPayments(customerId);

      // ---- Step 4: Verify the reconciliation credit ----
      credits = await db.query.customerCredits.findMany({
        where: eq(customerCredits.customerId, customerId),
        orderBy: [desc(customerCredits.createdAt)],
      });

      // Should have exactly one credit
      expect(credits.length).toBe(1);

      // Calculate expected credit:
      // Day 3 of 31-day month
      // Days used = from day 3 to day 31 = 29 days
      // Days not used = 31 - 29 = 2 days
      // Pro tier = $39/month = 3900 cents
      // Credit = 3900 * 2 / 31 = 251 cents (~$2.51)
      const daysInJanuary = 31;
      const dayOfMonth = 3;
      const daysUsed = daysInJanuary - dayOfMonth + 1; // +1 because day 3 is used
      const daysNotUsed = daysInJanuary - daysUsed;

      // Expected: 3900 * 2 / 31 = 251 cents
      const expectedCreditCents = Math.floor(
        (PLATFORM_TIER_PRICES_USD_CENTS.pro * daysNotUsed) / daysInJanuary
      );

      expect(Number(credits[0].originalAmountUsdCents)).toBe(expectedCreditCents);

      // Verify customer state after reconciliation
      customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.paidOnce).toBe(true);
      expect(customer?.pendingInvoiceId).toBeNull();

      await expectNoNotifications(customerId);
    });

    it('should update pending billing record when tier changes while unpaid', async () => {
      /**
       * RELATED BUG: When tier changes while unpaid, the pending billing record
       * should be updated to the new tier price.
       */

      await setClockTime('2025-01-03T00:00:00Z');

      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'starter' },
        accessToken
      );

      // Check billing record
      let records = await db.query.billingRecords.findMany({
        where: and(
          eq(billingRecords.customerId, customerId),
          ne(billingRecords.status, 'draft'),
          ne(billingRecords.status, 'paid')
        ),
      });
      expect(records.length).toBe(1);
      expect(Number(records[0].amountUsdCents)).toBe(PLATFORM_TIER_PRICES_USD_CENTS.starter);

      // Upgrade to pro
      await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'platform', newTier: 'pro' },
        accessToken
      );

      // The pending/failed billing record should now be pro price ($39)
      records = await db.query.billingRecords.findMany({
        where: and(
          eq(billingRecords.customerId, customerId),
          ne(billingRecords.status, 'draft'),
          ne(billingRecords.status, 'paid')
        ),
      });
      expect(records.length).toBe(1);
      expect(Number(records[0].amountUsdCents)).toBe(PLATFORM_TIER_PRICES_USD_CENTS.pro);

      await expectNoNotifications(customerId);
    });

    it('should calculate correct credit when downgrading while unpaid', async () => {
      /**
       * Edge case: User subscribes to pro, downgrades to starter before paying.
       * Credit should be based on starter (the tier actually charged).
       */

      await setClockTime('2025-01-03T00:00:00Z');

      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'pro' },
        accessToken
      );

      // Verify pro subscription pending
      let customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.platformTier).toBe('pro');
      expect(customer?.pendingInvoiceId).not.toBeNull();

      // Downgrade to starter (immediate since unpaid)
      const downgradeResult = await trpcMutation<any>(
        'services.scheduleTierDowngrade',
        { serviceType: 'platform', newTier: 'starter' },
        accessToken
      );

      expect(downgradeResult.result?.data?.success).toBe(true);
      expect(downgradeResult.result?.data?.effectiveDate).toBeDefined();

      // Verify tier changed to starter
      customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.platformTier).toBe('starter');

      // Add escrow payment method + deposit and pay
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'escrow' },
        accessToken
      );

      await trpcMutation<any>(
        'billing.deposit',
        { amountUsd: 5 }, // $5 to cover starter ($2)
        accessToken
      );

      // Trigger reconciliation
      await reconcilePendingPayments(customerId);

      // Verify credit is based on starter (the tier that was charged)
      const credits = await db.query.customerCredits.findMany({
        where: eq(customerCredits.customerId, customerId),
      });

      expect(credits.length).toBe(1);

      // Credit should be based on starter ($2), not pro ($39)
      const daysInJanuary = 31;
      const dayOfMonth = 3;
      const daysUsed = daysInJanuary - dayOfMonth + 1;
      const daysNotUsed = daysInJanuary - daysUsed;

      // Expected: 100 * 2 / 31 = 6 cents
      const expectedCreditCents = Math.floor(
        (PLATFORM_TIER_PRICES_USD_CENTS.starter * daysNotUsed) / daysInJanuary
      );

      expect(Number(credits[0].originalAmountUsdCents)).toBe(expectedCreditCents);

      await expectNoNotifications(customerId);
    });
  });

  describe('Reconciliation Credit Idempotency', () => {
    it('should not issue duplicate reconciliation credits when called multiple times', async () => {
      /**
       * The processor is fire-and-forget: the same invoice can be retried
       * by multiple paths (retryPendingInvoice, retryUnpaidInvoices, webhook).
       * issueReconciliationCredit must be idempotent — calling it twice for the
       * same invoice/scenario should only produce one credit.
       */

      await setClockTime('2025-01-03T00:00:00Z');

      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'starter' },
        accessToken
      );

      // Add escrow payment method, deposit funds and reconcile
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'escrow' },
        accessToken
      );

      await trpcMutation<any>(
        'billing.deposit',
        { amountUsd: 5 },
        accessToken
      );

      await reconcilePendingPayments(customerId);

      // Should have exactly one reconciliation credit
      let credits = await db.query.customerCredits.findMany({
        where: and(
          eq(customerCredits.customerId, customerId),
          eq(customerCredits.reason, 'reconciliation'),
        ),
      });
      expect(credits.length).toBe(1);
      const firstCreditAmount = Number(credits[0].originalAmountUsdCents);

      // Reconcile AGAIN (simulates duplicate queue dispatch)
      await reconcilePendingPayments(customerId);

      // Should still have exactly one reconciliation credit (idempotent)
      credits = await db.query.customerCredits.findMany({
        where: and(
          eq(customerCredits.customerId, customerId),
          eq(customerCredits.reason, 'reconciliation'),
        ),
      });
      expect(credits.length).toBe(1);
      expect(Number(credits[0].originalAmountUsdCents)).toBe(firstCreditAmount);

      await expectNoNotifications(customerId);
    });
  });
});
