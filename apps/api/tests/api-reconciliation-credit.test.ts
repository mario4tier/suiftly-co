/**
 * API Test: Reconciliation Credit Bug
 *
 * BUG REPRODUCTION: When user changes tier while initial payment is pending,
 * the reconciliation credit should be based on the tier that was ACTUALLY CHARGED,
 * not the original subscription tier.
 *
 * Scenario:
 * 1. User subscribes to starter ($9/month) - payment fails (no funds)
 * 2. User upgrades to enterprise ($185/month) - tier changes, no payment needed (paidOnce=false)
 * 3. User deposits funds -> reconcilePayments runs
 * 4. BUG: Credit is calculated based on starter ($9) instead of enterprise ($185)
 *
 * Expected: Credit should be ~$166 (enterprise × 27/30 days)
 * Actual: Credit was $8.10 (starter × 27/30 days)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import { serviceInstances, customers, customerCredits, billingRecords } from '@suiftly/database/schema';
import { eq, and, desc, ne } from 'drizzle-orm';
import {
  setClockTime,
  resetClock,
  ensureTestBalance,
  trpcMutation,
  resetTestData,
  restCall,
} from './helpers/http.js';
import { login, TEST_WALLET } from './helpers/auth.js';
import { TIER_PRICES_USD_CENTS } from '@suiftly/shared/pricing';

describe('API: Reconciliation Credit Calculation', () => {
  let accessToken: string;
  let customerId: number;

  beforeEach(async () => {
    // Reset clock to real time first
    await resetClock();

    // Reset test customer data via HTTP
    await resetTestData(TEST_WALLET);

    // Login FIRST - creates customer
    accessToken = await login(TEST_WALLET);

    // Get customer ID for DB assertions
    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, TEST_WALLET),
    });
    if (!customer) {
      throw new Error('Test customer not found after login');
    }
    customerId = customer.customerId;

    // Withdraw all funds to ensure payment will fail
    // First check balance
    const balanceResult = await restCall<any>('GET', `/test/wallet/balance?walletAddress=${TEST_WALLET}`);
    if (balanceResult.data?.balanceUsd > 0) {
      await restCall('POST', '/test/wallet/withdraw', {
        walletAddress: TEST_WALLET,
        amountUsd: balanceResult.data.balanceUsd,
      });
    }
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

      // ---- Step 1: Subscribe to starter tier with no funds ----
      await setClockTime('2025-01-03T00:00:00Z'); // Day 3 of January

      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      // Subscription created but payment pending (due to insufficient funds)
      expect(subscribeResult.result?.data).toBeDefined();
      expect(subscribeResult.result?.data?.paymentPending).toBe(true);

      // Verify service state
      let service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(service?.tier).toBe('starter');
      expect(service?.paidOnce).toBe(false);
      expect(service?.subPendingInvoiceId).not.toBeNull();

      // No credits should exist yet (payment failed)
      let credits = await db.query.customerCredits.findMany({
        where: eq(customerCredits.customerId, customerId),
      });
      expect(credits.length).toBe(0);

      // ---- Step 2: Upgrade to enterprise tier (still no payment) ----
      // Since paidOnce=false, tier change should be immediate without charge
      const upgradeResult = await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'seal', newTier: 'enterprise' },
        accessToken
      );

      expect(upgradeResult.result?.data?.success).toBe(true);
      expect(upgradeResult.result?.data?.newTier).toBe('enterprise');
      expect(upgradeResult.result?.data?.chargeAmountUsdCents).toBe(0); // No charge for unpaid users

      // Verify tier changed
      service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(service?.tier).toBe('enterprise');
      expect(service?.paidOnce).toBe(false);
      // subPendingInvoiceId should still be set (not yet paid)
      expect(service?.subPendingInvoiceId).not.toBeNull();

      // Still no credits
      credits = await db.query.customerCredits.findMany({
        where: eq(customerCredits.customerId, customerId),
      });
      expect(credits.length).toBe(0);

      // ---- Step 3: Deposit funds - triggers reconcilePayments ----
      const depositResult = await trpcMutation<any>(
        'billing.deposit',
        { amountUsd: 300 }, // $300 to cover enterprise ($185)
        accessToken
      );

      expect(depositResult.result?.data?.success).toBe(true);
      // Should have reconciled 1 pending charge
      expect(depositResult.result?.data?.reconciledCharges).toBe(1);

      // ---- Step 4: Verify the reconciliation credit ----
      // Now check the credit that was created
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
      // Enterprise tier = $185/month = 18500 cents
      // Credit = 18500 * 2 / 31 = 1193 cents (~$11.93)
      const daysInJanuary = 31;
      const dayOfMonth = 3;
      const daysUsed = daysInJanuary - dayOfMonth + 1; // +1 because day 3 is used
      const daysNotUsed = daysInJanuary - daysUsed;

      // BUG: The credit should be based on enterprise ($185), not starter ($9)
      // Expected: 18500 * 2 / 31 = 1193 cents
      // BUG gives: 900 * 2 / 31 = 58 cents
      const expectedCreditCents = Math.floor(
        (TIER_PRICES_USD_CENTS.enterprise * daysNotUsed) / daysInJanuary
      );

      expect(Number(credits[0].originalAmountUsdCents)).toBe(expectedCreditCents);

      // Verify service state after reconciliation
      service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(service?.paidOnce).toBe(true);
      expect(service?.subPendingInvoiceId).toBeNull();
    });

    it('should update pending billing record when tier changes while unpaid', async () => {
      /**
       * RELATED BUG: When tier changes while unpaid, the pending billing record
       * should be updated to the new tier price.
       */

      // ---- Subscribe to starter with no funds ----
      await setClockTime('2025-01-03T00:00:00Z');

      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      // Check billing record (could be pending or failed based on payment attempt)
      // We need any non-draft, non-paid record
      let records = await db.query.billingRecords.findMany({
        where: and(
          eq(billingRecords.customerId, customerId),
          ne(billingRecords.status, 'draft'),
          ne(billingRecords.status, 'paid')
        ),
      });
      expect(records.length).toBe(1);
      expect(Number(records[0].amountUsdCents)).toBe(TIER_PRICES_USD_CENTS.starter);

      // ---- Upgrade to enterprise ----
      await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'seal', newTier: 'enterprise' },
        accessToken
      );

      // The pending/failed billing record should now be enterprise price ($185)
      records = await db.query.billingRecords.findMany({
        where: and(
          eq(billingRecords.customerId, customerId),
          ne(billingRecords.status, 'draft'),
          ne(billingRecords.status, 'paid')
        ),
      });
      expect(records.length).toBe(1);
      // BUG: Currently returns 900 (starter) instead of 18500 (enterprise)
      expect(Number(records[0].amountUsdCents)).toBe(TIER_PRICES_USD_CENTS.enterprise);
    });

    it('should calculate correct credit when downgrading while unpaid', async () => {
      /**
       * Edge case: User subscribes to enterprise, downgrades to starter before paying.
       * Credit should be based on starter (the tier actually charged).
       */

      // ---- Subscribe to enterprise with no funds ----
      await setClockTime('2025-01-03T00:00:00Z');

      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'enterprise' },
        accessToken
      );

      // Verify enterprise subscription pending
      let service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(service?.tier).toBe('enterprise');
      expect(service?.subPendingInvoiceId).not.toBeNull();

      // ---- Downgrade to starter (immediate since unpaid) ----
      const downgradeResult = await trpcMutation<any>(
        'services.scheduleTierDowngrade',
        { serviceType: 'seal', newTier: 'starter' },
        accessToken
      );

      expect(downgradeResult.result?.data?.success).toBe(true);
      // For unpaid users, downgrade is immediate
      expect(downgradeResult.result?.data?.effectiveDate).toBeDefined();

      // Verify tier changed to starter
      service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(service?.tier).toBe('starter');

      // ---- Deposit and pay ----
      const depositResult = await trpcMutation<any>(
        'billing.deposit',
        { amountUsd: 50 }, // $50 to cover starter ($9)
        accessToken
      );

      expect(depositResult.result?.data?.success).toBe(true);

      // ---- Verify credit is based on starter (the tier that was charged) ----
      const credits = await db.query.customerCredits.findMany({
        where: eq(customerCredits.customerId, customerId),
      });

      expect(credits.length).toBe(1);

      // Credit should be based on starter ($9), not enterprise ($185)
      const daysInJanuary = 31;
      const dayOfMonth = 3;
      const daysUsed = daysInJanuary - dayOfMonth + 1;
      const daysNotUsed = daysInJanuary - daysUsed;

      // Expected: 900 * 2 / 31 = 58 cents
      const expectedCreditCents = Math.floor(
        (TIER_PRICES_USD_CENTS.starter * daysNotUsed) / daysInJanuary
      );

      expect(Number(credits[0].originalAmountUsdCents)).toBe(expectedCreditCents);
    });
  });
});
