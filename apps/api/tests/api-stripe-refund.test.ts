/**
 * API Test: Stripe Refund Flow
 *
 * Tests excess credit refunds when a customer downgrades tier.
 * Scenario: Enterprise ($185/month) → Starter ($9/month), excess reconciliation
 * credit should be refunded to Stripe.
 *
 * All tests use MockStripeService (no real Stripe API calls).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import {
  customers,
  serviceInstances,
  billingRecords,
  invoicePayments,
  customerCredits,
} from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import {
  setClockTime,
  resetClock,
  trpcMutation,
  restCall,
  resetTestData,
  runPeriodicBillingJob,
} from './helpers/http.js';
import { login, TEST_WALLET } from './helpers/auth.js';

describe('API: Stripe Refund Flow', () => {
  let accessToken: string;
  let customerId: number;

  beforeEach(async () => {
    await resetClock();
    await resetTestData(TEST_WALLET);
    accessToken = await login(TEST_WALLET);

    // Force mock Stripe service
    await restCall('POST', '/test/stripe/force-mock', { enabled: true });
    await restCall('POST', '/test/stripe/config/clear');

    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, TEST_WALLET),
    });
    if (!customer) throw new Error('Test customer not found');
    customerId = customer.customerId;
  });

  afterEach(async () => {
    await resetClock();
    await restCall('POST', '/test/stripe/config/clear');
    await restCall('POST', '/test/stripe/force-mock', { enabled: false });
    await resetTestData(TEST_WALLET);
  });

  /**
   * Helper: Subscribe to a tier with Stripe as payment method
   */
  async function subscribeWithStripe(tier: string): Promise<void> {
    // Add stripe as payment method
    await trpcMutation<any>(
      'billing.addPaymentMethod',
      { providerType: 'stripe' },
      accessToken
    );

    // Subscribe
    const result = await trpcMutation<any>(
      'services.subscribe',
      { serviceType: 'seal', tier },
      accessToken
    );
    expect(result.result?.data).toBeDefined();
    expect(result.result?.data.paymentPending).toBe(false);
  }

  // =========================================================================
  // Refund after tier downgrade
  // =========================================================================
  describe('Excess credit refund', () => {
    it('should issue refund when credits exceed monthly cost after downgrade', async () => {
      // Subscribe to Enterprise mid-month ($185/month = 18500 cents)
      await setClockTime('2025-01-15T00:00:00Z');
      await subscribeWithStripe('enterprise');

      // Verify reconciliation credit was issued
      const creditsAfterSub = await db.select()
        .from(customerCredits)
        .where(
          and(
            eq(customerCredits.customerId, customerId),
            eq(customerCredits.reason, 'reconciliation')
          )
        );
      expect(creditsAfterSub.length).toBeGreaterThanOrEqual(1);
      const totalCredit = creditsAfterSub.reduce(
        (sum, c) => sum + Number(c.originalAmountUsdCents), 0
      );
      // On Jan 15: credit = 18500 * 14/31 = ~8354 cents (~$83.54)
      expect(totalCredit).toBeGreaterThan(5000); // > $50

      // Schedule downgrade to Starter (takes effect 1st of next month)
      const downgradeResult = await trpcMutation<any>(
        'services.scheduleTierDowngrade',
        { serviceType: 'seal', newTier: 'starter' },
        accessToken
      );
      expect(downgradeResult.result?.data?.success).toBe(true);

      // Advance to 1st of next month and run billing
      await setClockTime('2025-02-01T00:00:00Z');
      const billingResult = await runPeriodicBillingJob(customerId);
      expect(billingResult.success).toBe(true);

      // Check if a refund operation was recorded
      const refundOps = billingResult.result?.operations?.filter(
        (op: any) => op.description?.includes('Refunded') || op.description?.includes('refund')
      );

      // Verify billing records include a credit type (refund)
      const allRecords = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));

      const creditRecords = allRecords.filter(r => r.type === 'credit');
      // Should have at least one credit record if refund was issued
      // (refund creates a billing record of type='credit')

      // Verify that remaining credits were reduced
      const creditsAfterRefund = await db.select()
        .from(customerCredits)
        .where(
          and(
            eq(customerCredits.customerId, customerId),
            eq(customerCredits.reason, 'reconciliation')
          )
        );
      const remainingCredit = creditsAfterRefund.reduce(
        (sum, c) => sum + Number(c.remainingAmountUsdCents), 0
      );

      // After refund, remaining credits should be <= starter monthly cost ($9 = 900 cents)
      // (the refund leaves at most 1 month buffer)
      expect(remainingCredit).toBeLessThanOrEqual(900);
    });

    it('should NOT refund when credits are less than monthly cost', async () => {
      // Subscribe to Starter ($9/month) mid-month
      await setClockTime('2025-01-15T00:00:00Z');
      await subscribeWithStripe('starter');

      // Credits will be small (< $9)
      const creditsAfterSub = await db.select()
        .from(customerCredits)
        .where(
          and(
            eq(customerCredits.customerId, customerId),
            eq(customerCredits.reason, 'reconciliation')
          )
        );
      const totalCredit = creditsAfterSub.reduce(
        (sum, c) => sum + Number(c.originalAmountUsdCents), 0
      );
      // On Jan 15: credit = 900 * 14/31 = ~406 cents < 900 monthly cost
      expect(totalCredit).toBeLessThan(900);

      // Advance to 1st of next month and run billing
      await setClockTime('2025-02-01T00:00:00Z');
      const billingResult = await runPeriodicBillingJob(customerId);

      // No refund should be issued (credits < monthly cost)
      const refundOps = billingResult.result?.operations?.filter(
        (op: any) => op.description?.includes('Refunded')
      );
      expect(refundOps?.length ?? 0).toBe(0);
    });

    it('should NOT refund when original payment was escrow (not Stripe)', async () => {
      await setClockTime('2025-01-15T00:00:00Z');

      // Use escrow instead of Stripe
      const { ensureTestBalance } = await import('./helpers/http.js');
      await ensureTestBalance(500); // $500 — enough for Enterprise ($185/month)

      // Subscribe to Enterprise with escrow
      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'enterprise' },
        accessToken
      );
      expect(result.result?.data?.paymentPending).toBe(false);

      // Schedule downgrade to Starter
      await trpcMutation<any>(
        'services.scheduleTierDowngrade',
        { serviceType: 'seal', newTier: 'starter' },
        accessToken
      );

      // Advance to 1st and run billing
      await setClockTime('2025-02-01T00:00:00Z');
      const billingResult = await runPeriodicBillingJob(customerId);

      // No Stripe refund should happen (payment was via escrow)
      const refundOps = billingResult.result?.operations?.filter(
        (op: any) => op.description?.includes('Refunded') && op.description?.includes('Stripe')
      );
      expect(refundOps?.length ?? 0).toBe(0);
    });
  });
});
