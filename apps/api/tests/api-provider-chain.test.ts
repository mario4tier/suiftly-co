/**
 * API Test: Provider Chain & Service Gates
 *
 * Tests the payment provider chain (escrow → stripe → paypal fallback)
 * and service gate behavior (retry pending invoices on enable/key creation).
 *
 * Tests use /test/stripe/config to inject failures and control mock behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import { serviceInstances, customers, billingRecords } from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import {
  setClockTime,
  resetClock,
  trpcMutation,
  trpcQuery,
  restCall,
  resetTestData,
  ensureTestBalance,
  subscribeAndEnable,
  reconcilePendingPayments,
} from './helpers/http.js';
import { login, TEST_WALLET } from './helpers/auth.js';

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

      // Subscribe — escrow should handle the charge
      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      expect(subscribeResult.result?.data).toBeDefined();
      expect(subscribeResult.result?.data.paymentPending).toBe(false);
      expect(subscribeResult.result?.data.tier).toBe('starter');
    });

    it('should leave invoice pending when no payment methods configured', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // No payment methods, no escrow account
      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      expect(subscribeResult.result?.data).toBeDefined();
      expect(subscribeResult.result?.data.paymentPending).toBe(true);

      // Verify service has pending invoice
      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(service?.subPendingInvoiceId).not.toBeNull();
    });

    it('should fallback to stripe when escrow has insufficient funds', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Create escrow with $1 (insufficient for $9 starter)
      await ensureTestBalance(1, { walletAddress: TEST_WALLET });

      // Add escrow as priority 1
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'escrow' },
        accessToken
      );

      // Add stripe as priority 2
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      // Subscribe — escrow should fail, stripe should succeed
      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      expect(subscribeResult.result?.data).toBeDefined();
      expect(subscribeResult.result?.data.paymentPending).toBe(false);
    });

    it('should handle 3DS-requiring stripe gracefully (falls through)', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Configure stripe mock to require 3DS
      await restCall('POST', '/test/stripe/config', {
        forceChargeRequiresAction: true,
      });

      // Add only stripe as payment method
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      // Subscribe — stripe requires action, so payment should be pending
      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      expect(subscribeResult.result?.data).toBeDefined();
      expect(subscribeResult.result?.data.paymentPending).toBe(true);
    });
  });

  // =========================================================================
  // Service Gate (toggleService)
  // =========================================================================
  describe('Service Gate - toggleService', () => {
    it('should retry pending invoice on enable after deposit succeeds', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Subscribe without funds → pending
      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
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

      // Try to enable — should retry payment and succeed
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
    });

    it('should fail when no payment methods configured', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Subscribe without funds → pending
      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      // Try to enable without any payment methods
      const toggleResult = await trpcMutation<any>(
        'services.toggleService',
        { serviceType: 'seal', enabled: true },
        accessToken
      );

      expect(toggleResult.error).toBeDefined();
      expect(toggleResult.error.data?.code).toBe('PRECONDITION_FAILED');
    });
  });
});
