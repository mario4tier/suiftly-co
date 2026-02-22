/**
 * API Test: Stripe Payment Flow
 *
 * Tests the Stripe payment path through tRPC endpoints, verifying:
 * - Stripe as sole payment provider (subscribe, charge, billing records)
 * - Stripe charge failure handling (mock config for declined, retryable errors)
 * - Stripe retry on service enable after fixing mock config
 * - Billing record and invoice_payment population after Stripe charge
 * - Provider chain: Stripe fallback when escrow fails
 *
 * All tests use MockStripeService (no real Stripe API calls).
 * Uses /test/stripe/config to control mock behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import {
  customers,
  serviceInstances,
  customerPaymentMethods,
} from '@suiftly/database/schema';
import { billingRecords } from '@suiftly/database/schema';
import { invoicePayments } from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import {
  setClockTime,
  resetClock,
  trpcMutation,
  restCall,
  resetTestData,
  ensureTestBalance,
} from './helpers/http.js';
import { login, TEST_WALLET } from './helpers/auth.js';

describe('API: Stripe Payment Flow', () => {
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
  // Stripe as sole provider — successful subscription charge
  // =========================================================================
  describe('Stripe as sole provider', () => {
    it('should charge via Stripe when it is the only payment method', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Add stripe as only payment method
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      // Subscribe to seal starter ($9/month)
      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.paymentPending).toBe(false);
      expect(result.result?.data.tier).toBe('starter');

      // Verify billing record was created and marked as paid
      const records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));

      // Should have at least one paid record (subscription charge)
      const paidRecords = records.filter(r => r.status === 'paid');
      expect(paidRecords.length).toBeGreaterThanOrEqual(1);

      // Verify invoice_payment was created with 'stripe' source type
      const paidRecord = paidRecords[0];
      const payments = await db.select()
        .from(invoicePayments)
        .where(eq(invoicePayments.billingRecordId, paidRecord.id));

      expect(payments.length).toBeGreaterThanOrEqual(1);
      const stripePayment = payments.find(p => p.sourceType === 'stripe');
      expect(stripePayment).toBeDefined();
      expect(stripePayment!.providerReferenceId).toBeDefined();
      expect(stripePayment!.amountUsdCents).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Stripe charge declined — retryable vs non-retryable
  // =========================================================================
  describe('Stripe charge failure', () => {
    it('should leave payment pending when Stripe charge is declined', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Configure mock to decline charges
      await restCall('POST', '/test/stripe/config', {
        forceCardDeclined: true,
      });

      // Add stripe as only payment method
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      // Subscribe — Stripe declines, payment should be pending
      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.paymentPending).toBe(true);

      // Verify service has pending invoice
      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(service?.subPendingInvoiceId).not.toBeNull();
    });

    it('should leave payment pending when Stripe charge fails with generic error', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Configure mock to fail with generic error
      await restCall('POST', '/test/stripe/config', {
        forceChargeFailure: true,
        forceChargeFailureMessage: 'Processing error',
      });

      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.paymentPending).toBe(true);
    });
  });

  // =========================================================================
  // Stripe retry on enable (subscribe without payment → add Stripe → enable)
  // =========================================================================
  describe('Stripe retry on enable', () => {
    it('should pay pending invoice via Stripe when enabled after adding Stripe', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Subscribe without any payment methods → payment pending
      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );
      expect(subscribeResult.result?.data?.paymentPending).toBe(true);

      // Add Stripe as payment method (no prior charge attempt = fresh idempotency key)
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      // Enable — retries pending invoice via Stripe (first attempt) → succeeds
      const toggleResult = await trpcMutation<any>(
        'services.toggleService',
        { serviceType: 'seal', enabled: true },
        accessToken
      );

      expect(toggleResult.result?.data).toBeDefined();
      expect(toggleResult.result?.data.isUserEnabled).toBe(true);

      // Verify pending invoice was cleared
      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(service?.subPendingInvoiceId).toBeNull();

      // Verify billing record is now paid with Stripe source
      const records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));
      const paidRecords = records.filter(r => r.status === 'paid');
      expect(paidRecords.length).toBeGreaterThanOrEqual(1);

      const payments = await db.select()
        .from(invoicePayments)
        .where(eq(invoicePayments.billingRecordId, paidRecords[0].id));
      const stripePayment = payments.find(p => p.sourceType === 'stripe');
      expect(stripePayment).toBeDefined();
      expect(stripePayment!.providerReferenceId).toBeDefined();
    });
  });

  // =========================================================================
  // Provider chain: escrow insufficient → Stripe fallback
  // =========================================================================
  describe('Escrow to Stripe fallback', () => {
    it('should use Stripe when escrow has insufficient funds and verify billing record', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Create escrow with $1 (insufficient for $9 starter)
      await ensureTestBalance(1, { walletAddress: TEST_WALLET });

      // Add escrow (priority 1) + stripe (priority 2)
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'escrow' },
        accessToken
      );
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      // Subscribe — escrow fails, stripe succeeds
      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.paymentPending).toBe(false);

      // Verify the invoice_payment source is stripe (not escrow)
      const records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));

      const paidRecords = records.filter(r => r.status === 'paid');
      expect(paidRecords.length).toBeGreaterThanOrEqual(1);

      const payments = await db.select()
        .from(invoicePayments)
        .where(eq(invoicePayments.billingRecordId, paidRecords[0].id));

      // Should have at least one stripe payment (escrow may have partial credit)
      const stripePayment = payments.find(p => p.sourceType === 'stripe');
      expect(stripePayment).toBeDefined();
      expect(stripePayment!.providerReferenceId).toBeDefined();
    });
  });

  // =========================================================================
  // 3DS requires_action — Stripe requires authentication
  // =========================================================================
  describe('Stripe 3DS (requires_action)', () => {
    it('should leave payment pending and set paymentActionUrl when Stripe requires 3DS', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Configure mock to require 3DS
      await restCall('POST', '/test/stripe/config', {
        forceChargeRequiresAction: true,
      });

      // Add stripe as only payment method
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      // Subscribe — Stripe requires 3DS, payment should be pending
      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.paymentPending).toBe(true);

      // Verify paymentActionUrl was set on the billing record
      const records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));

      const failedRecords = records.filter(r => r.status === 'failed');
      expect(failedRecords.length).toBeGreaterThanOrEqual(1);
      expect(failedRecords[0].paymentActionUrl).toBeDefined();
      expect(failedRecords[0].paymentActionUrl).toContain('https://invoice.stripe.com/');
    });

    it('should return paymentActionUrl in error when Stripe requires 3DS on retry', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Configure mock to require 3DS
      await restCall('POST', '/test/stripe/config', {
        forceChargeRequiresAction: true,
      });

      // Subscribe without payment methods → pending
      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );
      expect(subscribeResult.result?.data?.paymentPending).toBe(true);

      // Add Stripe with 3DS still configured
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      // Enable — retry via Stripe, but 3DS is required → still fails
      const toggleResult = await trpcMutation<any>(
        'services.toggleService',
        { serviceType: 'seal', enabled: true },
        accessToken
      );

      // Should fail because Stripe requires 3DS which can't be done server-side
      expect(toggleResult.error).toBeDefined();
      expect(toggleResult.error.data?.code).toBe('PRECONDITION_FAILED');

      // Error message should mention authentication/3DS
      expect(toggleResult.error.message).toContain('authentication');
    });
  });

  // =========================================================================
  // Stripe card declined is non-retryable
  // =========================================================================
  describe('Card declined retryable behavior', () => {
    it('should treat card_declined as non-retryable (billing record has failed status)', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Configure mock to decline charges
      await restCall('POST', '/test/stripe/config', {
        forceCardDeclined: true,
      });

      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      // Subscribe — Stripe declines
      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      // Verify billing record is failed (not retryable = not retried automatically)
      const records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));

      const failedRecord = records.find(r => r.status === 'failed');
      expect(failedRecord).toBeDefined();
      expect(failedRecord!.failureReason).toContain('declined');

      // Service should have pending invoice (needs manual retry after fixing card)
      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(service?.subPendingInvoiceId).not.toBeNull();
    });
  });

  // =========================================================================
  // Stripe customer ID persistence
  // =========================================================================
  describe('Stripe customer management', () => {
    it('should create Stripe customer on first addPaymentMethod and persist it', async () => {
      // First addPaymentMethod creates the Stripe customer
      const result = await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      expect(result.result?.data?.success).toBe(true);

      // Verify stripeCustomerId was saved to customers table
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.stripeCustomerId).toBeDefined();
      expect(customer?.stripeCustomerId).toContain('cus_mock_');

      // Verify payment method was created
      const methods = await db.select()
        .from(customerPaymentMethods)
        .where(and(
          eq(customerPaymentMethods.customerId, customerId),
          eq(customerPaymentMethods.providerType, 'stripe'),
          eq(customerPaymentMethods.status, 'active')
        ));
      expect(methods).toHaveLength(1);
    });
  });

  // =========================================================================
  // Error code propagation
  // =========================================================================
  describe('Error code propagation', () => {
    it('should have card_declined errorCode when Stripe mock declines', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Configure mock to decline charges
      await restCall('POST', '/test/stripe/config', {
        forceCardDeclined: true,
      });

      // Add stripe as only payment method
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      // Subscribe — Stripe declines
      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      expect(result.result?.data?.paymentPending).toBe(true);

      // Verify billing record has failed status with card_declined-related failure
      const records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));

      const failedRecord = records.find(r => r.status === 'failed');
      expect(failedRecord).toBeDefined();
      expect(failedRecord!.failureReason).toContain('declined');
    });
  });
});
