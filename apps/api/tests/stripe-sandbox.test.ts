/**
 * Stripe Sandbox Integration Tests
 *
 * Tests the real StripeService against Stripe's test mode API.
 * These tests make actual API calls to Stripe sandbox — they are slower
 * but verify real API behavior.
 *
 * Skips gracefully if STRIPE_SECRET_KEY is not configured.
 *
 * Test cards: https://docs.stripe.com/testing#cards
 * - tok_visa: Success
 * - tok_chargeDeclined: Card declined (may fail at attach or charge time)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Stripe from 'stripe';
import { StripeService } from '@suiftly/database/stripe-service';

// Sandbox tests need longer timeouts (multiple Stripe API calls per test)
const SANDBOX_TIMEOUT = 30_000;

// Load Stripe key from ~/.suiftly.env if available
function getStripeTestKey(): string | undefined {
  try {
    const fs = require('fs');
    const path = require('path');
    const envPath = path.join(require('os').homedir(), '.suiftly.env');
    const content = fs.readFileSync(envPath, 'utf-8');
    const match = content.match(/^STRIPE_SECRET_KEY=(.+)$/m);
    const key = match?.[1]?.trim();
    if (key && key.startsWith('sk_test_')) return key;
    return undefined;
  } catch {
    return undefined;
  }
}

const STRIPE_SECRET_KEY = getStripeTestKey();
const hasStripeKey = !!STRIPE_SECRET_KEY;

// Helper to conditionally skip
const describeStripe = hasStripeKey ? describe : describe.skip;

describeStripe('Stripe Sandbox: RealStripeService', () => {
  let service: StripeService;
  let stripe: Stripe;
  let testCustomerId: string;
  const cleanupCustomerIds: string[] = [];

  beforeAll(() => {
    service = new StripeService(STRIPE_SECRET_KEY!);
    stripe = new Stripe(STRIPE_SECRET_KEY!, { typescript: true });
  });

  afterAll(async () => {
    // Cleanup: delete test customers
    for (const id of cleanupCustomerIds) {
      try {
        await stripe.customers.del(id);
      } catch {
        // Ignore cleanup errors
      }
    }
  }, SANDBOX_TIMEOUT);

  // =========================================================================
  // createCustomer
  // =========================================================================
  describe('createCustomer', () => {
    it('should create a Stripe customer with metadata', async () => {
      const result = await service.createCustomer({
        customerId: 999001,
        walletAddress: '0xtest_sandbox_wallet_001',
        email: 'sandbox-test@suiftly.io',
      });

      expect(result.stripeCustomerId).toBeDefined();
      expect(result.stripeCustomerId).toMatch(/^cus_/);

      testCustomerId = result.stripeCustomerId;
      cleanupCustomerIds.push(testCustomerId);

      // Verify on Stripe's side
      const customer = await stripe.customers.retrieve(testCustomerId);
      expect(customer.deleted).toBeFalsy();
      if (!customer.deleted) {
        expect(customer.metadata.suiftly_customer_id).toBe('999001');
        expect(customer.metadata.wallet_address).toBe('0xtest_sandbox_wallet_001');
        expect(customer.email).toBe('sandbox-test@suiftly.io');
      }
    }, SANDBOX_TIMEOUT);
  });

  // =========================================================================
  // createSetupIntent
  // =========================================================================
  describe('createSetupIntent', () => {
    it('should create a SetupIntent for the customer', async () => {
      const result = await service.createSetupIntent(testCustomerId);

      expect(result.clientSecret).toBeDefined();
      expect(result.clientSecret).toContain('_secret_');
      expect(result.setupIntentId).toBeDefined();
      expect(result.setupIntentId).toMatch(/^seti_/);

      // Verify on Stripe's side
      const si = await stripe.setupIntents.retrieve(result.setupIntentId);
      expect(si.customer).toBe(testCustomerId);
      expect(si.usage).toBe('off_session');
    }, SANDBOX_TIMEOUT);
  });

  // =========================================================================
  // charge (requires a payment method attached to the customer)
  // =========================================================================
  describe('charge', () => {
    let paymentMethodId: string;

    beforeAll(async () => {
      // Attach a test card (4242) to the customer for charging
      const pm = await stripe.paymentMethods.create({
        type: 'card',
        card: { token: 'tok_visa' },
      });
      await stripe.paymentMethods.attach(pm.id, { customer: testCustomerId });
      paymentMethodId = pm.id;

      // Set as default payment method for invoices
      await stripe.customers.update(testCustomerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    }, SANDBOX_TIMEOUT);

    it('should charge successfully with a valid card', async () => {
      const result = await service.charge({
        stripeCustomerId: testCustomerId,
        amountUsdCents: 500, // $5.00
        description: 'Sandbox test charge',
        idempotencyKey: `test_charge_success_${Date.now()}`,
      });

      expect(result.success).toBe(true);
      expect(result.paymentIntentId).toBeDefined();
      expect(result.paymentIntentId).toMatch(/^in_/); // Invoice ID
      expect(result.retryable).toBe(false);
      expect(result.error).toBeUndefined();
    }, SANDBOX_TIMEOUT);

    it('should respect idempotency (same key returns same result)', async () => {
      const idempotencyKey = `test_idem_${Date.now()}`;

      const result1 = await service.charge({
        stripeCustomerId: testCustomerId,
        amountUsdCents: 300,
        description: 'Idempotency test',
        idempotencyKey,
      });

      const result2 = await service.charge({
        stripeCustomerId: testCustomerId,
        amountUsdCents: 300,
        description: 'Idempotency test',
        idempotencyKey,
      });

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      // Same idempotency key should return the same invoice
      expect(result1.paymentIntentId).toBe(result2.paymentIntentId);
    }, SANDBOX_TIMEOUT);
  });

  // =========================================================================
  // charge with declined card
  // =========================================================================
  describe('charge - error handling', () => {
    it('should return failure when customer has no payment method', async () => {
      // A customer with no default payment method — Stripe cannot charge them.
      // Tests our charge() method's catch block for non-card Stripe errors.
      const cust = await stripe.customers.create({
        metadata: { test: 'no_pm_charge_test' },
      });
      cleanupCustomerIds.push(cust.id);

      const result = await service.charge({
        stripeCustomerId: cust.id,
        amountUsdCents: 500,
        description: 'No payment method test',
        idempotencyKey: `test_no_pm_${Date.now()}`,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    }, SANDBOX_TIMEOUT);

    it('should handle a declined card', async () => {
      // tok_chargeDeclined may fail at attach time (newer Stripe API) or
      // at charge time (older behavior). Either way, the decline is caught.
      const cust = await stripe.customers.create({
        metadata: { test: 'declined_card_test' },
      });
      cleanupCustomerIds.push(cust.id);

      const pm = await stripe.paymentMethods.create({
        type: 'card',
        card: { token: 'tok_chargeDeclined' },
      });

      try {
        await stripe.paymentMethods.attach(pm.id, { customer: cust.id });
        await stripe.customers.update(cust.id, {
          invoice_settings: { default_payment_method: pm.id },
        });
      } catch (err) {
        // Declined at attach/setup time — Stripe catches it early.
        // Verify it's a card-related error, then test passes.
        expect(err).toBeInstanceOf(Stripe.errors.StripeCardError);
        return;
      }

      // If attach succeeded, the decline should happen at charge time
      const result = await service.charge({
        stripeCustomerId: cust.id,
        amountUsdCents: 500,
        description: 'Decline test',
        idempotencyKey: `test_decline_${Date.now()}`,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.retryable).toBe(false);
    }, SANDBOX_TIMEOUT);
  });

  // =========================================================================
  // getPaymentMethods
  // =========================================================================
  describe('getPaymentMethods', () => {
    it('should list payment methods for the customer', async () => {
      const methods = await service.getPaymentMethods(testCustomerId);

      expect(methods.length).toBeGreaterThanOrEqual(1);
      const card = methods[0];
      expect(card.id).toMatch(/^pm_/);
      expect(card.brand).toBe('visa');
      expect(card.last4).toBe('4242');
      expect(card.expMonth).toBeGreaterThan(0);
      expect(card.expYear).toBeGreaterThan(2020);
    }, SANDBOX_TIMEOUT);

    it('should return empty array for customer with no cards', async () => {
      const emptyCust = await stripe.customers.create({
        metadata: { test: 'no_cards' },
      });
      cleanupCustomerIds.push(emptyCust.id);

      const methods = await service.getPaymentMethods(emptyCust.id);
      expect(methods).toEqual([]);
    }, SANDBOX_TIMEOUT);
  });

  // =========================================================================
  // deletePaymentMethod
  // =========================================================================
  describe('deletePaymentMethod', () => {
    it('should detach a payment method', async () => {
      // Create and attach a card to delete
      const cust = await stripe.customers.create({
        metadata: { test: 'delete_pm' },
      });
      cleanupCustomerIds.push(cust.id);

      const pm = await stripe.paymentMethods.create({
        type: 'card',
        card: { token: 'tok_visa' },
      });
      await stripe.paymentMethods.attach(pm.id, { customer: cust.id });

      // Verify it's attached
      const before = await service.getPaymentMethods(cust.id);
      expect(before.length).toBe(1);

      // Delete it
      await service.deletePaymentMethod(pm.id);

      // Verify it's detached
      const after = await service.getPaymentMethods(cust.id);
      expect(after.length).toBe(0);
    }, SANDBOX_TIMEOUT);
  });

  // =========================================================================
  // isMock
  // =========================================================================
  describe('isMock', () => {
    it('should return false for real service', () => {
      expect(service.isMock()).toBe(false);
    });
  });
});
