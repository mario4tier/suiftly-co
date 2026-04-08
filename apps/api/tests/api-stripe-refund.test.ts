/**
 * API Test: Stripe Refund Flow
 *
 * Tests excess credit refunds when a customer downgrades platform tier.
 * Scenario: Pro ($29/month) → Starter ($1/month) mid-month, excess reconciliation
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
  customerCredits,
} from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import {
  setClockTime,
  resetClock,
  trpcMutation,
  restCall,
  resetTestData,
  ensureTestBalance,
  addStripePaymentMethod,
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

    // Small balance — insufficient for platform Pro ($29) so Stripe handles it
    await ensureTestBalance(2, { walletAddress: TEST_WALLET });
  });

  afterEach(async () => {
    await resetClock();
    await restCall('POST', '/test/stripe/config/clear');
    await restCall('POST', '/test/stripe/force-mock', { enabled: false });
    await resetTestData(TEST_WALLET);
  });

  /**
   * Helper: Subscribe to platform tier with Stripe as payment method.
   * Escrow has $2 (insufficient for Pro = $29, sufficient for Starter = $1).
   */
  async function subscribePlatformWithStripe(tier: string): Promise<void> {
    // Accept TOS (required for platform subscribe)
    await trpcMutation<any>('billing.acceptTos', {}, accessToken);

    // Add Stripe as payment method
    await addStripePaymentMethod(accessToken);

    // Subscribe to platform (Stripe will handle Pro charge since escrow < $29)
    const result = await trpcMutation<any>(
      'services.subscribe',
      { serviceType: 'platform', tier },
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
      // Subscribe to Platform Pro mid-month ($29/month = 2900 cents) via Stripe
      await setClockTime('2025-01-15T00:00:00Z');
      await subscribePlatformWithStripe('pro');

      // Verify reconciliation credit was issued (paid for unused days at start of month)
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
      // On Jan 15: credit = 2900 * 14/31 ≈ 1309 cents (~$13.09)
      expect(totalCredit).toBeGreaterThan(1000); // > $10

      // Schedule downgrade to Starter (takes effect 1st of next month)
      const downgradeResult = await trpcMutation<any>(
        'services.scheduleTierDowngrade',
        { serviceType: 'platform', newTier: 'starter' },
        accessToken
      );
      expect(downgradeResult.result?.data?.success).toBe(true);

      // Advance to 1st of next month and run billing
      await setClockTime('2025-02-01T00:00:00Z');
      const billingResult = await runPeriodicBillingJob(customerId);
      expect(billingResult.success).toBe(true);

      // Verify that remaining credits were reduced (refund consumed excess credits)
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

      // After refund, remaining credits should be <= total monthly cost (platform starter $1 = 100 cents)
      // The refund leaves at most 1 month buffer.
      expect(remainingCredit).toBeLessThanOrEqual(100);
    });

    it('should NOT refund when credits are less than monthly cost', async () => {
      // Subscribe to Platform Starter mid-month ($1/month = 100 cents) via Stripe
      await setClockTime('2025-01-15T00:00:00Z');
      await subscribePlatformWithStripe('starter');

      // Credits will be small (< $1)
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
      // On Jan 15: credit = 100 * 14/31 ≈ 45 cents < 100 monthly cost
      expect(totalCredit).toBeLessThan(100);

      // Advance to 1st of next month and run billing (no downgrade — still at starter)
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

      // Accept TOS and fund with enough for Platform Pro via escrow
      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      await ensureTestBalance(500, { walletAddress: TEST_WALLET }); // $500 — enough for Pro ($29)
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'escrow' },
        accessToken
      );

      // Subscribe to Platform Pro with escrow
      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'pro' },
        accessToken
      );
      expect(result.result?.data?.paymentPending).toBe(false);

      // Schedule downgrade to Starter
      await trpcMutation<any>(
        'services.scheduleTierDowngrade',
        { serviceType: 'platform', newTier: 'starter' },
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
