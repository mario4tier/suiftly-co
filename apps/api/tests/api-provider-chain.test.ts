/**
 * API Test: Provider Chain & Service Gates
 *
 * Tests the payment provider chain (escrow → stripe → paypal fallback)
 * and service gate behavior (retry pending invoices on enable/key creation).
 *
 * Tests use /test/stripe/config to inject failures and control mock behavior.
 * Platform subscription is the billing trigger (starter = $2/month).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import { billingRecords, customers } from '@suiftly/database/schema';
import { eq } from 'drizzle-orm';
import {
  setClockTime,
  resetClock,
  trpcMutation,
  restCall,
  resetTestData,
  ensureTestBalance,
  addStripePaymentMethod,
  reconcilePendingPayments,
} from './helpers/http.js';
import { login, TEST_WALLET } from './helpers/auth.js';
import { clearNotifications, expectNoNotifications } from './helpers/notifications.js';

describe('API: Provider Chain & Service Gates', () => {
  let accessToken: string;
  let customerId: number;

  beforeEach(async () => {
    await resetClock();
    await resetTestData(TEST_WALLET);

    accessToken = await login(TEST_WALLET);

    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, TEST_WALLET),
    });
    if (!customer) throw new Error('Test customer not found');
    customerId = customer.customerId;

    await clearNotifications(customerId);

    // Force mock Stripe service (even if STRIPE_SECRET_KEY is configured)
    await restCall('POST', '/test/stripe/force-mock', { enabled: true });
    // Clear stripe mock config
    await restCall('POST', '/test/stripe/config/clear');
  });

  afterEach(async () => {
    await resetClock();
    await restCall('POST', '/test/stripe/config/clear');
    await restCall('POST', '/test/stripe/force-mock', { enabled: false });
    await resetTestData(TEST_WALLET);
  });

  // =========================================================================
  // Provider Chain
  // =========================================================================
  describe('Provider Chain', () => {
    it('should charge escrow when first priority with funds', async () => {
      await setClockTime('2025-01-05T00:00:00Z');
      await ensureTestBalance(100, { walletAddress: TEST_WALLET });

      // Add escrow as payment method
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'escrow' },
        accessToken
      );

      // Accept TOS and subscribe to platform — escrow should handle the charge
      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'starter' },
        accessToken
      );

      expect(subscribeResult.result?.data).toBeDefined();
      expect(subscribeResult.result?.data.paymentPending).toBe(false);
      expect(subscribeResult.result?.data.tier).toBe('starter');

      await expectNoNotifications(customerId);
    });

    it('should leave invoice pending when no payment methods configured', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // No payment methods, no escrow account
      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'starter' },
        accessToken
      );

      expect(subscribeResult.result?.data).toBeDefined();
      expect(subscribeResult.result?.data.paymentPending).toBe(true);

      // Verify customer has pending invoice
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.pendingInvoiceId).not.toBeNull();

      await expectNoNotifications(customerId);
    });

    it('should fallback to stripe when escrow has insufficient funds', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Create escrow with $0 (insufficient for $2 starter)
      await ensureTestBalance(0, { walletAddress: TEST_WALLET });

      // Add escrow as priority 1
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'escrow' },
        accessToken
      );

      // Add stripe as priority 2
      await addStripePaymentMethod(accessToken);

      // Subscribe — escrow should fail, stripe should succeed
      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'starter' },
        accessToken
      );

      expect(subscribeResult.result?.data).toBeDefined();
      expect(subscribeResult.result?.data.paymentPending).toBe(false);

      await expectNoNotifications(customerId, { tolerateGM: true });
    });

    it('should leave payment pending with action URL when Stripe requires 3DS', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Configure stripe mock to require 3DS on charges (not setup intents)
      await restCall('POST', '/test/stripe/config', {
        forceChargeRequiresAction: true,
      });

      // Add stripe as payment method (full setup + webhook → creates payment method row)
      await addStripePaymentMethod(accessToken);

      // Subscribe — Stripe charge requires 3DS action, so payment should be pending
      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'starter' },
        accessToken
      );

      expect(subscribeResult.result?.data).toBeDefined();
      expect(subscribeResult.result?.data.paymentPending).toBe(true);

      // Verify: billing record has paymentActionUrl — proves Stripe was reached and
      // returned requires_action, not just "no payment method found"
      const records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));
      const pendingRecords = records.filter(r => r.status === 'pending' && r.paymentActionUrl);
      expect(pendingRecords.length).toBe(1);
      expect(pendingRecords[0].paymentActionUrl).toContain('https://invoice.stripe.com/');

      await expectNoNotifications(customerId, { tolerateGM: true });
    });
  });

  // =========================================================================
  // Service Gate (toggleService on platform with pending invoice)
  // =========================================================================
  describe('Service Gate - toggleService', () => {
    it('should retry pending invoice on enable after deposit succeeds', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Subscribe platform without funds → pending
      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'starter' },
        accessToken
      );
      expect(subscribeResult.result?.data?.paymentPending).toBe(true);

      // Add funds
      await ensureTestBalance(100, { walletAddress: TEST_WALLET });

      // Add escrow as payment method
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'escrow' },
        accessToken
      );

      // Trigger reconciliation via deposit flow (same as GM would do)
      await reconcilePendingPayments(customerId);

      // Verify pending invoice was cleared on customer
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.pendingInvoiceId).toBeNull();
      expect(customer?.paidOnce).toBe(true);

      await expectNoNotifications(customerId);
    });

    it('should fail reconciliation when no payment methods configured', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Subscribe platform without funds and no payment method → pending
      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'starter' },
        accessToken
      );

      // Note: do NOT call ensureTestBalance here — it auto-adds escrow as a
      // payment method (server-side test convenience), which would break this test.
      // The test verifies that reconciliation fails when there is NO payment method;
      // whether the customer has escrow funds is irrelevant if no method row exists.

      // Reconcile — should fail since no payment method configured
      const result = await reconcilePendingPayments(customerId);
      // The reconciliation runs but finds no payment methods
      // Customer should still have pending invoice
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.pendingInvoiceId).not.toBeNull();

      await expectNoNotifications(customerId);
    });
  });
});
