/**
 * API Test: Stripe Webhook
 *
 * Tests the Stripe webhook handler at POST /stripe/webhook.
 * Verifies signature verification, idempotency, and event handling.
 *
 * Uses HMAC-SHA256 to create valid Stripe webhook signatures.
 * The webhook secret is set to 'whsec_test_secret_for_development_only' by config.ts default.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { db } from '@suiftly/database';
import {
  customers,
  customerPaymentMethods,
  paymentWebhookEvents,
  billingRecords,
  invoicePayments,
  serviceInstances,
  customerCredits,
} from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import {
  resetTestData,
  restCall,
  ensureTestBalance,
  trpcMutation,
  setClockTime,
  resetClock,
} from './helpers/http.js';
import { login, TEST_WALLET } from './helpers/auth.js';

const API_BASE = 'http://localhost:22700';
const WEBHOOK_SECRET = 'whsec_test_secret_for_development_only';

/**
 * Create a Stripe webhook signature for the given body.
 * Matches the Stripe v1 signature format: t=<timestamp>,v1=<signature>
 */
function createStripeSignature(body: string, secret: string, timestamp?: number): string {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${ts}.${body}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');
  return `t=${ts},v1=${signature}`;
}

/**
 * Send a webhook event to the Stripe webhook endpoint
 */
async function sendWebhookEvent(event: Record<string, unknown>, signatureHeader?: string) {
  const body = JSON.stringify(event);
  const signature = signatureHeader ?? createStripeSignature(body, WEBHOOK_SECRET);

  const response = await fetch(`${API_BASE}/stripe/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': signature,
    },
    body,
  });

  return {
    status: response.status,
    data: await response.json().catch(() => null),
  };
}

describe('API: Stripe Webhook', () => {
  let accessToken: string;
  let customerId: number;

  beforeEach(async () => {
    await resetClock();
    await resetTestData(TEST_WALLET);
    accessToken = await login(TEST_WALLET);

    // Set webhook secret override so tests use our known test secret
    await restCall('POST', '/test/stripe/webhook-secret', { secret: WEBHOOK_SECRET });
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
    // Clear webhook secret override
    await restCall('POST', '/test/stripe/webhook-secret', { secret: null });
    await restCall('POST', '/test/stripe/config/clear');
    await restCall('POST', '/test/stripe/force-mock', { enabled: false });
    await resetTestData(TEST_WALLET);
  });

  // =========================================================================
  // Signature Verification
  // =========================================================================
  describe('Signature Verification', () => {
    it('should reject missing signature header', async () => {
      const body = JSON.stringify({ id: 'evt_test_1', type: 'test' });

      const response = await fetch(`${API_BASE}/stripe/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Invalid signature');
    });

    it('should reject invalid signature', async () => {
      const event = { id: 'evt_test_2', type: 'test', data: { object: {} } };
      const result = await sendWebhookEvent(event, 't=1234567890,v1=invalidsignature');

      expect(result.status).toBe(400);
      expect(result.data?.error).toBe('Invalid signature');
    });

    it('should accept valid signature', async () => {
      const event = {
        id: 'evt_test_3',
        type: 'unknown.event',
        data: { object: {} },
      };

      const result = await sendWebhookEvent(event);

      expect(result.status).toBe(200);
      expect(result.data?.received).toBe(true);
    });
  });

  // =========================================================================
  // setup_intent.succeeded
  // =========================================================================
  describe('setup_intent.succeeded', () => {
    it('should save payment method to customer_payment_methods', async () => {
      // Setup: create Stripe customer for this customer
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      // Get the stripeCustomerId that was created
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.stripeCustomerId).toBeDefined();

      const event = {
        id: 'evt_setup_1',
        type: 'setup_intent.succeeded',
        data: {
          object: {
            payment_method: 'pm_test_visa_4242',
            customer: customer!.stripeCustomerId,
            metadata: {
              card_brand: 'visa',
              card_last4: '4242',
            },
          },
        },
      };

      const result = await sendWebhookEvent(event);
      expect(result.status).toBe(200);

      // Verify event was recorded
      const webhookEvent = await db.query.paymentWebhookEvents.findFirst({
        where: eq(paymentWebhookEvents.eventId, 'evt_setup_1'),
      });
      expect(webhookEvent).toBeDefined();
      expect(webhookEvent?.processed).toBe(true);
      expect(webhookEvent?.eventType).toBe('setup_intent.succeeded');
    });

    it('should handle duplicate events idempotently', async () => {
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });

      const event = {
        id: 'evt_setup_idem',
        type: 'setup_intent.succeeded',
        data: {
          object: {
            payment_method: 'pm_test_idem',
            customer: customer!.stripeCustomerId,
            metadata: { card_brand: 'mastercard', card_last4: '5555' },
          },
        },
      };

      // Send same event twice
      const result1 = await sendWebhookEvent(event);
      expect(result1.status).toBe(200);

      const result2 = await sendWebhookEvent(event);
      expect(result2.status).toBe(200);
      expect(result2.data?.duplicate).toBe(true);
    });
  });

  // =========================================================================
  // payment_intent.succeeded
  // =========================================================================
  describe('payment_intent.succeeded', () => {
    it('should process and return 200', async () => {
      const event = {
        id: 'evt_pi_success_1',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_test_123',
            customer: 'cus_mock_1',
            amount: 900,
            currency: 'usd',
          },
        },
      };

      const result = await sendWebhookEvent(event);

      expect(result.status).toBe(200);
      expect(result.data?.received).toBe(true);

      // Verify event was recorded
      const webhookEvent = await db.query.paymentWebhookEvents.findFirst({
        where: eq(paymentWebhookEvents.eventId, 'evt_pi_success_1'),
      });
      expect(webhookEvent).toBeDefined();
      expect(webhookEvent?.processed).toBe(true);
    });
  });

  // =========================================================================
  // payment_intent.payment_failed
  // =========================================================================
  describe('payment_intent.payment_failed', () => {
    it('should process and return 200', async () => {
      const event = {
        id: 'evt_pi_failed_1',
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: 'pi_test_failed',
            customer: 'cus_mock_1',
            last_payment_error: {
              message: 'Your card was declined',
              code: 'card_declined',
            },
          },
        },
      };

      const result = await sendWebhookEvent(event);

      expect(result.status).toBe(200);
      expect(result.data?.received).toBe(true);

      // Verify event was recorded
      const webhookEvent = await db.query.paymentWebhookEvents.findFirst({
        where: eq(paymentWebhookEvents.eventId, 'evt_pi_failed_1'),
      });
      expect(webhookEvent).toBeDefined();
      expect(webhookEvent?.processed).toBe(true);
    });
  });

  // =========================================================================
  // invoice.paid — Full Reconciliation
  // =========================================================================
  describe('invoice.paid reconciliation', () => {
    /**
     * Helper: Subscribe with Stripe 3DS forced, so we get a pending billing record
     * with paymentActionUrl set. Returns the billing record ID.
     */
    async function subscribeWith3DSPending(): Promise<{
      billingRecordId: number;
      stripeInvoiceId: string;
    }> {
      await setClockTime('2025-01-15T00:00:00Z');

      // Force mock Stripe to require 3DS
      await restCall('POST', '/test/stripe/force-mock', { enabled: true });
      await restCall('POST', '/test/stripe/config', { forceChargeRequiresAction: true });

      // Add Stripe as only payment method
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      // Subscribe — Stripe requires 3DS → payment pending
      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );
      expect(result.result?.data?.paymentPending).toBe(true);

      // Find the failed billing record with paymentActionUrl
      const records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));

      const failedRecord = records.find(r => r.status === 'failed' && r.paymentActionUrl);
      if (!failedRecord) throw new Error('No failed billing record with paymentActionUrl found');

      // Extract the mock invoice ID from the paymentActionUrl
      // URL format: https://invoice.stripe.com/i/mock/in_mock_X
      const urlParts = failedRecord.paymentActionUrl!.split('/');
      const stripeInvoiceId = urlParts[urlParts.length - 1];

      // Clear 3DS config so it doesn't interfere with other tests
      await restCall('POST', '/test/stripe/config/clear');

      return {
        billingRecordId: failedRecord.id,
        stripeInvoiceId,
      };
    }

    it('should create invoice_payments row and mark billing record paid', async () => {
      const { billingRecordId, stripeInvoiceId } = await subscribeWith3DSPending();

      // Send invoice.paid webhook
      const event = {
        id: `evt_inv_paid_${Date.now()}`,
        type: 'invoice.paid',
        data: {
          object: {
            id: stripeInvoiceId,
            amount_paid: 900, // $9 starter
            metadata: {
              billing_record_id: String(billingRecordId),
            },
          },
        },
      };

      const result = await sendWebhookEvent(event);
      expect(result.status).toBe(200);

      // Verify billing record is now paid
      const [record] = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.id, billingRecordId));
      expect(record.status).toBe('paid');
      expect(Number(record.amountPaidUsdCents)).toBe(900);
      expect(record.paymentActionUrl).toBeNull();

      // Verify invoice_payments row was created
      const payments = await db.select()
        .from(invoicePayments)
        .where(eq(invoicePayments.billingRecordId, billingRecordId));
      const stripePayment = payments.find(p => p.sourceType === 'stripe');
      expect(stripePayment).toBeDefined();
      expect(stripePayment!.providerReferenceId).toBe(stripeInvoiceId);
      expect(Number(stripePayment!.amountUsdCents)).toBe(900);
    });

    it('should set paidOnce on service and customer', async () => {
      const { billingRecordId, stripeInvoiceId } = await subscribeWith3DSPending();

      const event = {
        id: `evt_inv_paid_once_${Date.now()}`,
        type: 'invoice.paid',
        data: {
          object: {
            id: stripeInvoiceId,
            amount_paid: 900,
            metadata: { billing_record_id: String(billingRecordId) },
          },
        },
      };

      await sendWebhookEvent(event);

      // Verify paidOnce on customer
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.paidOnce).toBe(true);

      // Verify paidOnce on service instance
      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(service?.paidOnce).toBe(true);
    });

    it('should clear subPendingInvoiceId', async () => {
      const { billingRecordId, stripeInvoiceId } = await subscribeWith3DSPending();

      // Verify subPendingInvoiceId is set before webhook
      const serviceBefore = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(serviceBefore?.subPendingInvoiceId).not.toBeNull();

      const event = {
        id: `evt_inv_clear_pending_${Date.now()}`,
        type: 'invoice.paid',
        data: {
          object: {
            id: stripeInvoiceId,
            amount_paid: 900,
            metadata: { billing_record_id: String(billingRecordId) },
          },
        },
      };

      await sendWebhookEvent(event);

      // Verify subPendingInvoiceId is cleared
      const serviceAfter = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(serviceAfter?.subPendingInvoiceId).toBeNull();
    });

    it('should issue reconciliation credit', async () => {
      const { billingRecordId, stripeInvoiceId } = await subscribeWith3DSPending();

      const event = {
        id: `evt_inv_credit_${Date.now()}`,
        type: 'invoice.paid',
        data: {
          object: {
            id: stripeInvoiceId,
            amount_paid: 900,
            metadata: { billing_record_id: String(billingRecordId) },
          },
        },
      };

      await sendWebhookEvent(event);

      // Verify reconciliation credit was issued
      const credits = await db.select()
        .from(customerCredits)
        .where(
          and(
            eq(customerCredits.customerId, customerId),
            eq(customerCredits.reason, 'reconciliation')
          )
        );

      // Should have at least one reconciliation credit (partial month)
      // On Jan 15, days used = 31 - 15 + 1 = 17, days not used = 14
      // Credit = 900 * 14 / 31 = 406 cents
      expect(credits.length).toBeGreaterThanOrEqual(1);
      const totalCredit = credits.reduce((sum, c) => sum + Number(c.originalAmountUsdCents), 0);
      expect(totalCredit).toBeGreaterThan(0);
    });

    it('should be idempotent (duplicate delivery)', async () => {
      const { billingRecordId, stripeInvoiceId } = await subscribeWith3DSPending();

      const event = {
        id: `evt_inv_idem_${Date.now()}`,
        type: 'invoice.paid',
        data: {
          object: {
            id: stripeInvoiceId,
            amount_paid: 900,
            metadata: { billing_record_id: String(billingRecordId) },
          },
        },
      };

      // Send twice
      const result1 = await sendWebhookEvent(event);
      expect(result1.status).toBe(200);

      const result2 = await sendWebhookEvent(event);
      expect(result2.status).toBe(200);
      // Second delivery should be caught by the idempotency check
      expect(result2.data?.duplicate).toBe(true);

      // Verify only one invoice_payments row was created
      const payments = await db.select()
        .from(invoicePayments)
        .where(eq(invoicePayments.billingRecordId, billingRecordId));
      const stripePayments = payments.filter(p => p.sourceType === 'stripe');
      expect(stripePayments.length).toBe(1);
    });
  });
});
