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
  customerCredits,
  adminNotifications,
} from '@suiftly/database/schema';
import { eq, and, isNull } from 'drizzle-orm';
import {
  resetTestData,
  restCall,
  trpcMutation,
  setClockTime,
  resetClock,
  addStripePaymentMethod,
} from './helpers/http.js';
import { login, TEST_WALLET } from './helpers/auth.js';
import { clearNotifications, expectNotifications, expectNoNotifications } from './helpers/notifications.js';

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
    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, TEST_WALLET),
    });
    if (!customer) throw new Error('Test customer not found');
    customerId = customer.customerId;
    await clearNotifications(customerId);

    // Set webhook secret override so tests use our known test secret
    await restCall('POST', '/test/stripe/webhook-secret', { secret: WEBHOOK_SECRET });
    // Force mock Stripe service
    await restCall('POST', '/test/stripe/force-mock', { enabled: true });
    await restCall('POST', '/test/stripe/config/clear');
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
        id: `evt_test_3_${Date.now()}`,
        type: 'unknown.event',
        data: { object: {} },
      };

      const result = await sendWebhookEvent(event);

      expect(result.status).toBe(200);
      expect(result.data?.received).toBe(true);
      await expectNoNotifications(customerId);
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

      const eventId = `evt_setup_1_${Date.now()}`;
      const event = {
        id: eventId,
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

      // Verify event was recorded and processed
      const webhookEvent = await db.query.paymentWebhookEvents.findFirst({
        where: eq(paymentWebhookEvents.eventId, eventId),
      });
      expect(webhookEvent).toBeDefined();
      expect(webhookEvent?.processed).toBe(true);
      expect(webhookEvent?.eventType).toBe('setup_intent.succeeded');

      // Verify payment method was saved to customer_payment_methods
      const paymentMethod = await db.query.customerPaymentMethods.findFirst({
        where: and(
          eq(customerPaymentMethods.customerId, customerId),
          eq(customerPaymentMethods.providerType, 'stripe'),
          eq(customerPaymentMethods.status, 'active'),
        ),
      });
      expect(paymentMethod).toBeDefined();
      expect(paymentMethod?.providerRef).toBe('pm_test_visa_4242');

      // Only tolerate STRIPE_API_UNREACHABLE (GM's mock doesn't know the customer).
      // Do NOT tolerate WEBHOOK_GM_QUEUE_FAILED here — this test exercises the
      // webhook path that queues GM sync-customer, so GM unreachable is a real failure.
      await expectNoNotifications(customerId, { tolerateCodes: ['warning:STRIPE_API_UNREACHABLE'] });
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
        id: `evt_setup_idem_${Date.now()}`,
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
      // Same rationale: only tolerate the expected GM mock mismatch, not GM unreachable
      await expectNoNotifications(customerId, { tolerateCodes: ['warning:STRIPE_API_UNREACHABLE'] });
    });
  });

  // =========================================================================
  // payment_intent.succeeded
  // =========================================================================
  describe('payment_intent.succeeded', () => {
    it('should process and return 200', async () => {
      const eventId = `evt_pi_success_1_${Date.now()}`;
      const event = {
        id: eventId,
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
        where: eq(paymentWebhookEvents.eventId, eventId),
      });
      expect(webhookEvent).toBeDefined();
      expect(webhookEvent?.processed).toBe(true);
      await expectNoNotifications(customerId);
    });
  });

  // =========================================================================
  // payment_intent.payment_failed
  // =========================================================================
  describe('payment_intent.payment_failed', () => {
    it('should process and return 200', async () => {
      // Clear stale system-level STRIPE_PAYMENT_FAILED_NO_METADATA from prior runs
      await db.delete(adminNotifications)
        .where(and(
          eq(adminNotifications.code, 'STRIPE_PAYMENT_FAILED_NO_METADATA'),
          isNull(adminNotifications.customerId),
        ));

      const eventId = `evt_pi_failed_1_${Date.now()}`;
      const event = {
        id: eventId,
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
        where: eq(paymentWebhookEvents.eventId, eventId),
      });
      expect(webhookEvent).toBeDefined();
      expect(webhookEvent?.processed).toBe(true);

      // Verify: exactly one system-level STRIPE_PAYMENT_FAILED_NO_METADATA notification.
      // This event has no billing_record_id metadata and uses a fake Stripe customer,
      // so the handler logs a system-level (null customerId) notification.
      const sysNotifs = await db.select()
        .from(adminNotifications)
        .where(and(
          eq(adminNotifications.code, 'STRIPE_PAYMENT_FAILED_NO_METADATA'),
          isNull(adminNotifications.customerId),
        ));
      expect(sysNotifs.length).toBe(1);

      // No customer-scoped notifications
      await expectNoNotifications(customerId);
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

      // Add Stripe as only payment method (setup + webhook)
      await addStripePaymentMethod(accessToken);

      // Accept TOS and subscribe to platform — Stripe requires 3DS → payment pending
      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'starter' },
        accessToken
      );
      expect(result.result?.data?.paymentPending).toBe(true);

      // Find the pending billing record with paymentActionUrl (3DS stays pending)
      const records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));

      const failedRecord = records.find(r => r.status === 'pending' && r.paymentActionUrl);
      if (!failedRecord) throw new Error('No pending billing record with paymentActionUrl found');

      // Extract the mock invoice ID from the paymentActionUrl
      // URL format: https://invoice.stripe.com/i/mock/in_mock_X
      const urlParts = failedRecord.paymentActionUrl!.split('/');
      const stripeInvoiceId = urlParts[urlParts.length - 1];

      // Clear 3DS config so it doesn't interfere with other tests
      await restCall('POST', '/test/stripe/config/clear');

      // Clear notifications from setup (GM sync-customer may fire STRIPE_API_UNREACHABLE)
      await clearNotifications(customerId);

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
            amount_paid: 100, // $1 platform starter
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
      expect(Number(record.amountPaidUsdCents)).toBe(100);
      expect(record.paymentActionUrl).toBeNull();

      // Verify invoice_payments row was created
      const payments = await db.select()
        .from(invoicePayments)
        .where(eq(invoicePayments.billingRecordId, billingRecordId));
      const stripePayment = payments.find(p => p.sourceType === 'stripe');
      expect(stripePayment).toBeDefined();
      expect(stripePayment!.providerReferenceId).toBe(stripeInvoiceId);
      expect(Number(stripePayment!.amountUsdCents)).toBe(100);
      await expectNoNotifications(customerId, { tolerateGM: true });
    });

    it('should set paidOnce on service and customer', async () => {
      const { billingRecordId, stripeInvoiceId } = await subscribeWith3DSPending();

      const event = {
        id: `evt_inv_paid_once_${Date.now()}`,
        type: 'invoice.paid',
        data: {
          object: {
            id: stripeInvoiceId,
            amount_paid: 100,
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

      // paidOnce is now on customer (verified above)
      await expectNoNotifications(customerId, { tolerateGM: true });
    });

    it('should clear pendingInvoiceId', async () => {
      const { billingRecordId, stripeInvoiceId } = await subscribeWith3DSPending();

      // Verify pendingInvoiceId is set before webhook
      const customerBefore = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customerBefore?.pendingInvoiceId).not.toBeNull();

      const event = {
        id: `evt_inv_clear_pending_${Date.now()}`,
        type: 'invoice.paid',
        data: {
          object: {
            id: stripeInvoiceId,
            amount_paid: 100,
            metadata: { billing_record_id: String(billingRecordId) },
          },
        },
      };

      await sendWebhookEvent(event);

      // Verify pendingInvoiceId is cleared
      const customerAfter = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customerAfter?.pendingInvoiceId).toBeNull();
      await expectNoNotifications(customerId, { tolerateGM: true });
    });

    it('should issue reconciliation credit', async () => {
      const { billingRecordId, stripeInvoiceId } = await subscribeWith3DSPending();

      const event = {
        id: `evt_inv_credit_${Date.now()}`,
        type: 'invoice.paid',
        data: {
          object: {
            id: stripeInvoiceId,
            amount_paid: 100,
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
      // Credit = 100 * 14 / 31 = 45 cents
      expect(credits.length).toBeGreaterThanOrEqual(1);
      const totalCredit = credits.reduce((sum, c) => sum + Number(c.originalAmountUsdCents), 0);
      expect(totalCredit).toBeGreaterThan(0);
      await expectNoNotifications(customerId, { tolerateGM: true });
    });

    it('should be idempotent (duplicate delivery)', async () => {
      const { billingRecordId, stripeInvoiceId } = await subscribeWith3DSPending();

      const event = {
        id: `evt_inv_idem_${Date.now()}`,
        type: 'invoice.paid',
        data: {
          object: {
            id: stripeInvoiceId,
            amount_paid: 100,
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
      await expectNoNotifications(customerId, { tolerateGM: true });
    });

    it('should block while stale claim exists, then reprocess after row is deleted', async () => {
      // Tests the idempotency contract:
      // 1. A claimed (processed=false) row blocks reprocessing
      // 2. Deleting the stale row (as the catch block does on failure) unblocks retry
      // 3. The next attempt processes successfully
      //
      // Note: this simulates the catch-block cleanup via direct DB manipulation
      // because forcing a real handler exception requires test infrastructure
      // that would add production complexity. The catch-block delete is 3 lines
      // of straightforward code (db.delete where eventId).
      const { billingRecordId, stripeInvoiceId } = await subscribeWith3DSPending();
      const eventId = `evt_inv_retry_${Date.now()}`;

      const event = {
        id: eventId,
        type: 'invoice.paid',
        data: {
          object: {
            id: stripeInvoiceId,
            amount_paid: 100,
            metadata: { billing_record_id: String(billingRecordId) },
          },
        },
      };

      // Step 1: Insert a stale claimed row (simulates failed prior attempt
      // where the catch-block delete also failed — the stuck-event edge case)
      await db.insert(paymentWebhookEvents).values({
        eventId,
        providerType: 'stripe',
        eventType: 'invoice.paid',
        processed: false,
        data: JSON.stringify(event),
      });

      // Step 2: Retry arrives — blocked by existing row
      const stuckResult = await sendWebhookEvent(event);
      expect(stuckResult.status).toBe(200);
      expect(stuckResult.data?.duplicate).toBe(true);

      // Verify: billing record still pending (event wasn't processed)
      let [record] = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.id, billingRecordId));
      expect(record.status).toBe('pending');

      // Step 3: Delete stale row (simulates catch-block cleanup or admin intervention)
      await db.delete(paymentWebhookEvents)
        .where(eq(paymentWebhookEvents.eventId, eventId));

      // Step 4: Next retry succeeds — fresh insert, full processing
      const retryResult = await sendWebhookEvent(event);
      expect(retryResult.status).toBe(200);
      expect(retryResult.data?.duplicate).toBeUndefined();

      // Verify: billing record is now paid
      [record] = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.id, billingRecordId));
      expect(record.status).toBe('paid');

      // Verify: event row is marked processed
      const webhookEvent = await db.query.paymentWebhookEvents.findFirst({
        where: eq(paymentWebhookEvents.eventId, eventId),
      });
      expect(webhookEvent?.processed).toBe(true);

      await expectNoNotifications(customerId, { tolerateGM: true });
    });

    it('should skip refund when webhook confirms same Stripe charge already processed synchronously', async () => {
      const { billingRecordId, stripeInvoiceId } = await subscribeWith3DSPending();

      // Simulate: the synchronous invoices.pay() path already reconciled this charge.
      // This creates the invoice_payments row that processInvoicePayment would create,
      // AND marks the billing record as paid.
      await db.insert(invoicePayments).values({
        billingRecordId,
        sourceType: 'stripe',
        providerReferenceId: stripeInvoiceId,
        creditId: null,
        escrowTransactionId: null,
        amountUsdCents: 100,
      });
      await db.update(billingRecords)
        .set({ status: 'paid', amountPaidUsdCents: 100 })
        .where(eq(billingRecords.id, billingRecordId));

      // Send invoice.paid webhook for the SAME Stripe invoice
      const event = {
        id: `evt_inv_same_charge_${Date.now()}`,
        type: 'invoice.paid',
        data: {
          object: {
            id: stripeInvoiceId,
            amount_paid: 100,
            metadata: { billing_record_id: String(billingRecordId) },
          },
        },
      };

      const result = await sendWebhookEvent(event);
      expect(result.status).toBe(200);

      // Verify: no notifications at all (not a double charge)
      await expectNoNotifications(customerId, { tolerateGM: true });

      // Verify: billing record unchanged
      const [record] = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.id, billingRecordId));
      expect(record.status).toBe('paid');
      expect(Number(record.amountPaidUsdCents)).toBe(100);
    });

    it('should auto-refund when non-Stripe provider has same reference ID (cross-provider collision)', async () => {
      const { billingRecordId, stripeInvoiceId } = await subscribeWith3DSPending();

      // Simulate: a non-Stripe provider (e.g., PayPal) paid with the same reference ID.
      // This is unlikely in practice but tests that the sourceType filter prevents
      // a cross-provider collision from suppressing the refund.
      await db.insert(invoicePayments).values({
        billingRecordId,
        sourceType: 'paypal',
        providerReferenceId: stripeInvoiceId, // Same reference as the Stripe invoice
        creditId: null,
        escrowTransactionId: null,
        amountUsdCents: 100,
      });
      await db.update(billingRecords)
        .set({ status: 'paid', amountPaidUsdCents: 100 })
        .where(eq(billingRecords.id, billingRecordId));

      // Send invoice.paid webhook — should refund because the existing payment
      // is PayPal, not Stripe, despite having the same providerReferenceId
      const event = {
        id: `evt_inv_cross_provider_${Date.now()}`,
        type: 'invoice.paid',
        data: {
          object: {
            id: stripeInvoiceId,
            amount_paid: 100,
            metadata: { billing_record_id: String(billingRecordId) },
          },
        },
      };

      const result = await sendWebhookEvent(event);
      expect(result.status).toBe(200);

      // Verify: DOUBLE_CHARGE_AUTO_REFUNDED on this specific invoice
      await expectNotifications(customerId, ['error:DOUBLE_CHARGE_AUTO_REFUNDED'], { forInvoice: billingRecordId, tolerateGM: true });
      // Verify: no unexpected notifications on other invoices (customer-wide check)
      await expectNotifications(customerId, ['error:DOUBLE_CHARGE_AUTO_REFUNDED'], { tolerateGM: true });
    });

    it('should auto-refund when billing record is already paid by another provider', async () => {
      const { billingRecordId, stripeInvoiceId } = await subscribeWith3DSPending();

      // Simulate: another provider (e.g., escrow) already paid this invoice
      // before the customer completed 3DS on the Stripe-hosted page.
      await db.update(billingRecords)
        .set({ status: 'paid', amountPaidUsdCents: 100 })
        .where(eq(billingRecords.id, billingRecordId));

      // Send invoice.paid webhook (customer completed 3DS on stale page)
      const event = {
        id: `evt_inv_double_${Date.now()}`,
        type: 'invoice.paid',
        data: {
          object: {
            id: stripeInvoiceId,
            amount_paid: 100,
            metadata: { billing_record_id: String(billingRecordId) },
          },
        },
      };

      const result = await sendWebhookEvent(event);
      expect(result.status).toBe(200);

      // Verify: DOUBLE_CHARGE_AUTO_REFUNDED on this specific invoice
      await expectNotifications(customerId, ['error:DOUBLE_CHARGE_AUTO_REFUNDED'], { forInvoice: billingRecordId, tolerateGM: true });
      // Verify: no unexpected notifications on other invoices (customer-wide check)
      await expectNotifications(customerId, ['error:DOUBLE_CHARGE_AUTO_REFUNDED'], { tolerateGM: true });

      // Verify: billing record stays paid (not double-credited)
      const [record] = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.id, billingRecordId));
      expect(record.status).toBe('paid');
      expect(Number(record.amountPaidUsdCents)).toBe(100);
    });
  });

  // =========================================================================
  // Signature Failure — Admin Notification
  // =========================================================================
  describe('Signature failure notification', () => {
    it('should create admin notification on invalid webhook signature', async () => {
      // Clear stale system-level WEBHOOK_SIGNATURE_FAILED rows from prior runs
      // so we can assert exactly 1 was created by this test
      await db.delete(adminNotifications)
        .where(and(
          eq(adminNotifications.code, 'WEBHOOK_SIGNATURE_FAILED'),
          isNull(adminNotifications.customerId),
        ));

      const event = { id: 'evt_sig_fail_1', type: 'test', data: { object: {} } };
      const result = await sendWebhookEvent(event, 't=1234567890,v1=invalidsignature');

      expect(result.status).toBe(400);

      // Verify: exactly one WEBHOOK_SIGNATURE_FAILED was created by this test
      const notifications = await db.select()
        .from(adminNotifications)
        .where(and(
          eq(adminNotifications.code, 'WEBHOOK_SIGNATURE_FAILED'),
          isNull(adminNotifications.customerId),
        ));
      expect(notifications.length).toBe(1);
      expect(notifications[0].category).toBe('security');
    });
  });
});
