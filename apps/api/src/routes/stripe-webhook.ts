/**
 * Stripe Webhook Handler
 *
 * Raw REST endpoint (not tRPC) — Stripe sends raw POST body that must be
 * verified with webhook secret before parsing.
 *
 * Mounted as a Fastify route because:
 * 1. Stripe sends raw JSON body (not tRPC envelope)
 * 2. Signature verification requires raw body bytes
 * 3. No auth required (verified via webhook secret)
 */

import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { db } from '@suiftly/database';
import { withCustomerLock, issueCredit, recalculateDraftInvoice, clearGracePeriod, logInternalError, logInternalErrorOnce } from '@suiftly/database/billing';
import { paymentWebhookEvents, customerPaymentMethods, customers, billingRecords, serviceInstances, invoicePayments } from '@suiftly/database/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { dbClockProvider } from '@suiftly/shared/db-clock';
import { config } from '../lib/config';

/**
 * Webhook secret override for tests.
 * When set, this takes priority over config.STRIPE_WEBHOOK_SECRET.
 * Set via POST /test/stripe/webhook-secret endpoint.
 */
export let webhookSecretOverride: string | null = null;

export function setWebhookSecretOverride(secret: string | null): void {
  webhookSecretOverride = secret;
}

/**
 * Verify Stripe webhook signature (v1 scheme).
 * Uses the standard Stripe-Signature header format:
 *   t=<timestamp>,v1=<signature>
 *
 * This avoids importing the full Stripe SDK just for signature verification.
 */
function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300
): { valid: boolean; error?: string } {
  if (!signatureHeader || !secret) {
    return { valid: false, error: 'Missing signature header or webhook secret' };
  }

  const elements = signatureHeader.split(',');
  const timestampStr = elements.find(e => e.startsWith('t='))?.slice(2);
  const signature = elements.find(e => e.startsWith('v1='))?.slice(3);

  if (!timestampStr || !signature) {
    return { valid: false, error: 'Invalid signature header format' };
  }

  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) {
    return { valid: false, error: 'Invalid timestamp in signature' };
  }

  // Check timestamp tolerance (prevent replay attacks)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return { valid: false, error: 'Webhook timestamp outside tolerance window' };
  }

  // Compute expected signature
  const signedPayload = `${timestampStr}.${rawBody}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  // Constant-time comparison
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return { valid: false, error: 'Signature mismatch' };
  }

  return { valid: true };
}

export async function registerStripeWebhook(server: FastifyInstance) {
  // Skip registration if Stripe is not configured
  // Note: webhookSecretOverride may be set later by tests, so we still register
  // if the default config secret exists
  if (!config.STRIPE_WEBHOOK_SECRET) {
    console.log('[Stripe Webhook] Skipped — STRIPE_WEBHOOK_SECRET not configured');
    return;
  }

  // Use Fastify register() to get an encapsulated context.
  // This lets us override the JSON content-type parser to receive the raw
  // body string (needed for Stripe signature verification) without affecting
  // the rest of the app's JSON parsing.
  await server.register(async function stripePlugin(instance) {
    instance.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: 1048576 }, // 1MB limit
      (_req, body, done) => {
        done(null, body);
      }
    );

    instance.post('/stripe/webhook', async (request, reply) => {
    const rawBody = request.body as string;
    const signatureHeader = request.headers['stripe-signature'] as string;

    // 1. Verify webhook signature
    const secret = webhookSecretOverride ?? config.STRIPE_WEBHOOK_SECRET;
    const verification = verifyStripeSignature(
      rawBody,
      signatureHeader,
      secret
    );

    if (!verification.valid) {
      console.error(`[Stripe Webhook] Signature verification failed: ${verification.error}`);
      return reply.status(400).send({ error: 'Invalid signature' });
    }

    // Parse the verified body
    let event: {
      id: string;
      type: string;
      data: { object: Record<string, unknown> };
    };

    try {
      event = JSON.parse(rawBody);
    } catch {
      console.error('[Stripe Webhook] Failed to parse event body');
      return reply.status(400).send({ error: 'Invalid JSON' });
    }

    // 2. Idempotency check — skip if already processed
    const existing = await db.query.paymentWebhookEvents.findFirst({
      where: eq(paymentWebhookEvents.eventId, event.id),
    });

    if (existing?.processed) {
      console.log(`[Stripe Webhook] Event ${event.id} already processed, skipping`);
      return reply.status(200).send({ received: true, duplicate: true });
    }

    // Record the event (if not already recorded)
    if (!existing) {
      await db.insert(paymentWebhookEvents).values({
        eventId: event.id,
        providerType: 'stripe',
        eventType: event.type,
        processed: false,
        data: rawBody,
      });
    }

    // 3. Handle event types
    try {
      if (!event.data?.object) {
        console.error(`[Stripe Webhook] Event ${event.id} missing data.object`);
        return reply.status(200).send({ received: true });
      }

      switch (event.type) {
        case 'invoice.paid':
          await handleInvoicePaid(event.data.object);
          break;

        case 'payment_intent.succeeded':
          await handlePaymentIntentSucceeded(event.data.object);
          break;

        case 'payment_intent.payment_failed':
          await handlePaymentIntentFailed(event.data.object);
          break;

        case 'setup_intent.succeeded':
          await handleSetupIntentSucceeded(event.data.object);
          break;

        default:
          console.log(`[Stripe Webhook] Unhandled event type: ${event.type}`);
      }

      // 4. Mark event as processed
      await db.update(paymentWebhookEvents)
        .set({ processed: true, processedAt: new Date() })
        .where(eq(paymentWebhookEvents.eventId, event.id));

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      console.error(`[Stripe Webhook] Error processing event ${event.id}:`, error);

      // Notify admin with stack trace. Stripe will retry (we return 500),
      // but persistent failures need human investigation.
      try {
        await logInternalError(db, {
          severity: 'error',
          category: 'billing',
          code: 'WEBHOOK_PROCESSING_ERROR',
          message: `Failed to process Stripe webhook event ${event.id} (${event.type}): ${message}`,
          details: { eventId: event.id, eventType: event.type, stack },
        });
      } catch {
        // Don't let notification failure affect the 500 response
      }

      // Return 500 so Stripe retries delivery. The idempotency check at the top
      // (existing?.processed) ensures re-delivery of already-processed events is
      // a no-op. Unprocessed events (processed=false) will be retried correctly.
      return reply.status(500).send({ error: 'Internal error processing webhook event' });
    }

    // 5. Return 200 on success (Stripe retries on non-2xx)
    return reply.status(200).send({ received: true });
    });
  }); // end stripePlugin

  console.log('[Stripe Webhook] Registered POST /stripe/webhook');
}

/**
 * Handle invoice.paid
 *
 * Fires when a Stripe invoice is paid — either immediately (synchronous charge)
 * or after the user completes 3DS on the Stripe-hosted invoice page.
 *
 * Full reconciliation:
 * 1. Create invoice_payments row (sourceType='stripe')
 * 2. Update billing_records: status='paid', amountPaidUsdCents, paymentActionUrl=null
 * 3. Clear subPendingInvoiceId on matching service_instances
 * 4. Set paidOnce on service_instances and customers
 * 5. Issue reconciliation credit (partial month pro-rata)
 * 6. Recalculate DRAFT invoice
 *
 * Uses metadata.billing_record_id (set by StripePaymentProvider) to find the
 * matching billing_records row.
 */
async function handleInvoicePaid(invoice: Record<string, unknown>) {
  const stripeInvoiceId = invoice.id as string;
  const metadata = invoice.metadata as Record<string, string> | null;
  const billingRecordId = metadata?.billing_record_id
    ? parseInt(metadata.billing_record_id, 10)
    : undefined;
  const amountPaid = typeof invoice.amount_paid === 'number'
    ? invoice.amount_paid
    : undefined;

  console.log(`[Stripe Webhook] invoice.paid: ${stripeInvoiceId}, billingRecordId: ${billingRecordId}, amountPaid: ${amountPaid}`);

  if (!billingRecordId || isNaN(billingRecordId)) {
    console.log(`[Stripe Webhook] invoice.paid: no billing_record_id in metadata, skipping`);
    // A paid Stripe invoice has no matching billing record — could be a manual charge,
    // metadata drift, or a bug. Notify admin so they can investigate.
    await logInternalError(db, {
      severity: 'warning',
      category: 'billing',
      code: 'WEBHOOK_INVOICE_NO_BILLING_RECORD',
      message: `Stripe invoice ${stripeInvoiceId} paid but has no billing_record_id in metadata`,
      details: { stripeInvoiceId, amountPaid, metadata },
    });
    return;
  }

  // Find the billing record
  const record = await db.query.billingRecords.findFirst({
    where: eq(billingRecords.id, billingRecordId),
  });

  if (!record) {
    console.log(`[Stripe Webhook] invoice.paid: billing record ${billingRecordId} not found, skipping`);
    await logInternalError(db, {
      severity: 'error',
      category: 'billing',
      code: 'WEBHOOK_INVOICE_RECORD_NOT_FOUND',
      message: `Stripe invoice ${stripeInvoiceId} references billing record ${billingRecordId} which does not exist`,
      details: { stripeInvoiceId, billingRecordId, amountPaid },
      invoiceId: billingRecordId,
    });
    return;
  }

  // Skip if already paid — but notify admin since Stripe charged an already-settled invoice.
  // This can happen if the provider chain fell through to escrow (which succeeded) but the
  // customer later completes 3DS on the stale Stripe-hosted page, causing a double charge.
  if (record.status === 'paid') {
    console.log(`[Stripe Webhook] invoice.paid: billing record ${billingRecordId} already paid, skipping`);
    await logInternalError(db, {
      severity: 'warning',
      category: 'billing',
      code: 'WEBHOOK_INVOICE_ALREADY_PAID',
      message: `Stripe invoice ${stripeInvoiceId} paid but billing record ${billingRecordId} was already paid — possible double charge`,
      details: { stripeInvoiceId, billingRecordId, amountPaid, existingStatus: record.status },
      customerId: record.customerId,
      invoiceId: billingRecordId,
    });
    return;
  }

  const customerId = record.customerId;
  const invoiceAmount = amountPaid ?? Number(record.amountUsdCents);

  // Alert admin if Stripe's amount_paid differs from our expected amount.
  // Could indicate Stripe-side adjustments (coupons, tax, partial payment).
  // We still proceed with Stripe's amount as authoritative, but flag for review.
  // Uses logInternalErrorOnce — this runs before the lock, so if reconciliation
  // throws (500 → Stripe retries), we don't create duplicate notifications.
  if (amountPaid != null && amountPaid !== Number(record.amountUsdCents)) {
    await logInternalErrorOnce(db, {
      severity: 'warning',
      category: 'billing',
      code: 'WEBHOOK_AMOUNT_MISMATCH',
      message: `Stripe invoice ${stripeInvoiceId} amount_paid (${amountPaid}) differs from billing record ${billingRecordId} amount (${record.amountUsdCents})`,
      details: {
        stripeInvoiceId,
        stripeAmountPaid: amountPaid,
        expectedAmountCents: Number(record.amountUsdCents),
        difference: amountPaid - Number(record.amountUsdCents),
      },
      customerId,
      invoiceId: billingRecordId,
    });
  }

  // Sync clock from test_kv before use (ensures correct time in test environments)
  await dbClockProvider.syncFromTestKv();
  const clock = dbClockProvider.getClock();

  // Acquire customer lock and perform all reconciliation atomically
  await withCustomerLock(db, customerId, async (tx) => {
    // Re-check billing record status after acquiring lock (double-check)
    const [freshRecord] = await tx
      .select()
      .from(billingRecords)
      .where(eq(billingRecords.id, billingRecordId))
      .limit(1);

    if (!freshRecord || freshRecord.status === 'paid') {
      console.log(`[Stripe Webhook] invoice.paid: billing record ${billingRecordId} already paid (after lock), skipping`);
      return;
    }

    // 1. Create invoice_payments row
    await tx.insert(invoicePayments).values({
      billingRecordId,
      sourceType: 'stripe',
      providerReferenceId: stripeInvoiceId,
      creditId: null,
      escrowTransactionId: null,
      amountUsdCents: invoiceAmount,
    });

    // 2. Update billing_records: status='paid', amount, clear stale failure metadata.
    //    Keep retryCount as audit trail (how many attempts before success).
    //    Clear failureReason/lastRetryAt/paymentActionUrl so they don't leak into
    //    UI, alerts, or retry heuristics for what is now a paid invoice.
    await tx
      .update(billingRecords)
      .set({
        status: 'paid',
        amountPaidUsdCents: invoiceAmount,
        paymentActionUrl: null,
        failureReason: null,
        lastRetryAt: null,
      })
      .where(eq(billingRecords.id, billingRecordId));

    // 3. Clear subPendingInvoiceId on service_instances that reference this invoice,
    //    and set paidOnce ONLY on those specific services (not all customer services).
    const pendingServices = await tx
      .select({ instanceId: serviceInstances.instanceId, serviceType: serviceInstances.serviceType })
      .from(serviceInstances)
      .where(
        and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.subPendingInvoiceId, billingRecordId)
        )
      );

    if (pendingServices.length > 0) {
      const instanceIds = pendingServices.map(s => s.instanceId);
      await tx
        .update(serviceInstances)
        .set({ subPendingInvoiceId: null, paidOnce: true })
        .where(inArray(serviceInstances.instanceId, instanceIds));
    }

    // 4. Set paidOnce on customer and clear grace period.
    //    If the customer entered grace period due to the failed 3DS charge,
    //    completing 3DS should lift the grace period (just like retryFailedPayments does).
    await tx
      .update(customers)
      .set({ paidOnce: true })
      .where(eq(customers.customerId, customerId));
    await clearGracePeriod(tx, customerId);

    // 5. Issue reconciliation credit for partial month.
    //    Use the billing record's period start date (when the subscription was created),
    //    NOT clock.today(). For 3DS completions, the webhook can fire days/weeks after
    //    the original charge attempt, and using today would give the wrong credit amount.
    const subscriptionDate = new Date(freshRecord.billingPeriodStart);
    const daysInMonth = getDaysInMonth(subscriptionDate.getUTCFullYear(), subscriptionDate.getUTCMonth() + 1);
    const dayOfMonth = subscriptionDate.getUTCDate();
    const daysUsed = daysInMonth - dayOfMonth + 1; // +1 because subscription day is included
    const daysNotUsed = daysInMonth - daysUsed;

    // Use the invoice amount as the monthly price for reconciliation
    const monthlyPrice = Number(freshRecord.amountUsdCents);
    const reconciliationCreditCents = Math.floor(
      (monthlyPrice * daysNotUsed) / daysInMonth
    );

    if (reconciliationCreditCents > 0) {
      // Use the service type from the pending service if available
      const serviceType = pendingServices[0]?.serviceType ?? 'unknown';

      await issueCredit(
        tx,
        customerId,
        reconciliationCreditCents,
        'reconciliation',
        `Partial month credit for ${serviceType} (${daysNotUsed}/${daysInMonth} days unused)`,
        null // Never expires
      );
    }

    // 6. Recalculate DRAFT invoice
    try {
      await recalculateDraftInvoice(tx, customerId, clock);
    } catch (err) {
      // Non-fatal: DRAFT recalculation failure shouldn't block payment reconciliation.
      // But notify admin — a stale DRAFT could go unnoticed for a full billing cycle.
      console.error(`[Stripe Webhook] invoice.paid: failed to recalculate DRAFT for customer ${customerId}:`, err);
      try {
        await logInternalError(tx, {
          severity: 'warning',
          category: 'billing',
          code: 'WEBHOOK_DRAFT_RECALC_FAILED',
          message: `DRAFT recalculation failed after webhook reconciliation for customer ${customerId}`,
          details: { error: err instanceof Error ? err.message : String(err), billingRecordId },
          customerId,
          invoiceId: billingRecordId,
        });
      } catch { /* don't let notification failure break reconciliation */ }
    }

    console.log(`[Stripe Webhook] invoice.paid: fully reconciled billing record ${billingRecordId} for customer ${customerId}`);
  });
}

/**
 * Get number of days in a month (UTC-based)
 */
function getDaysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Handle payment_intent.succeeded
 *
 * For off_session charges that succeed synchronously, the invoice_payments row
 * and billing_records status were already set by StripePaymentProvider.charge().
 * This webhook is a confirmation — no DB action needed.
 *
 * TODO: For charges that required 3DS (requires_action), the provider chain
 * fell through to the next provider. If the user later completes 3DS via
 * the Stripe-hosted page, this webhook fires and we should reconcile:
 * 1. Find the invoice by paymentIntent metadata
 * 2. If still unpaid, create invoice_payment row + mark paid
 */
async function handlePaymentIntentSucceeded(paymentIntent: Record<string, unknown>) {
  const intentId = paymentIntent.id as string;
  const stripeCustomerId = paymentIntent.customer as string | null;
  const metadata = paymentIntent.metadata as Record<string, string> | null;
  const billingRecordId = metadata?.billing_record_id;

  console.log(`[Stripe Webhook] payment_intent.succeeded: ${intentId}, customer: ${stripeCustomerId}, billingRecord: ${billingRecordId}`);
  // Reconciliation is handled by invoice.paid webhook (not here).
  // PaymentIntents are created internally by Stripe Invoices API.
}

/**
 * Handle payment_intent.payment_failed
 *
 * The provider chain already handles failures by falling through to the next
 * provider. This webhook provides additional context for logging/auditing.
 */
async function handlePaymentIntentFailed(paymentIntent: Record<string, unknown>) {
  const intentId = paymentIntent.id as string;
  const lastError = paymentIntent.last_payment_error as Record<string, unknown> | null;
  const errorMessage = lastError?.message as string || 'Unknown error';

  console.log(`[Stripe Webhook] payment_intent.payment_failed: ${intentId}, error: ${errorMessage}`);
}

/**
 * Handle setup_intent.succeeded
 * Records the payment method details in customer_payment_methods.
 * This fires after the user completes the Stripe card setup flow (including 3DS).
 */
async function handleSetupIntentSucceeded(setupIntent: Record<string, unknown>) {
  const paymentMethodId = setupIntent.payment_method as string;
  const stripeCustomerId = setupIntent.customer as string;
  const metadata = setupIntent.metadata as Record<string, string> | null;

  console.log(`[Stripe Webhook] setup_intent.succeeded: pm=${paymentMethodId}, customer=${stripeCustomerId}`);

  if (!stripeCustomerId || !paymentMethodId) {
    console.error('[Stripe Webhook] setup_intent.succeeded missing customer or payment_method');
    return;
  }

  // Find the customer by stripeCustomerId (outside lock — read-only, no race)
  const customer = await db.query.customers.findFirst({
    where: eq(customers.stripeCustomerId, stripeCustomerId),
  });

  if (!customer) {
    console.error(`[Stripe Webhook] No customer found for stripeCustomerId: ${stripeCustomerId}`);
    return;
  }

  // Acquire customer lock to prevent race conditions with concurrent payment method
  // additions (e.g., user adding via API while webhook fires simultaneously).
  // Without the lock, both could read the same maxPriority and insert at the same priority.
  await withCustomerLock(db, customer.customerId, async (tx) => {
    // Upsert the payment method details into customer_payment_methods
    // The row may already exist from billing.addPaymentMethod — update providerRef + providerConfig
    // First try by providerRef (idempotent re-delivery), then by customerId + providerType
    let existingMethod = await tx.query.customerPaymentMethods.findFirst({
      where: eq(customerPaymentMethods.providerRef, paymentMethodId),
    });

    if (!existingMethod) {
      // addPaymentMethod('stripe') creates the row with providerRef=null —
      // find it by customerId + providerType + active status
      existingMethod = await tx.query.customerPaymentMethods.findFirst({
        where: and(
          eq(customerPaymentMethods.customerId, customer.customerId),
          eq(customerPaymentMethods.providerType, 'stripe'),
          eq(customerPaymentMethods.status, 'active'),
        ),
      });
    }

    const cardDetails = metadata?.card_brand && metadata?.card_last4
      ? { brand: metadata.card_brand, last4: metadata.card_last4 }
      : null;

    if (existingMethod) {
      // Update with confirmed card details + providerRef (may be null from addPaymentMethod)
      await tx.update(customerPaymentMethods)
        .set({
          status: 'active',
          providerRef: paymentMethodId,
          providerConfig: cardDetails ? JSON.stringify(cardDetails) : existingMethod.providerConfig,
          updatedAt: new Date(),
        })
        .where(eq(customerPaymentMethods.id, existingMethod.id));
    } else {
      // Determine next priority for this customer
      const existingMethods = await tx.select()
        .from(customerPaymentMethods)
        .where(eq(customerPaymentMethods.customerId, customer.customerId));

      const maxPriority = existingMethods.reduce((max, m) => Math.max(max, m.priority), 0);

      await tx.insert(customerPaymentMethods).values({
        customerId: customer.customerId,
        providerType: 'stripe',
        status: 'active',
        priority: maxPriority + 1,
        providerRef: paymentMethodId,
        providerConfig: cardDetails ? JSON.stringify(cardDetails) : null,
      });
    }

    console.log(`[Stripe Webhook] Payment method ${paymentMethodId} saved for customer ${customer.customerId}`);
  });
}
