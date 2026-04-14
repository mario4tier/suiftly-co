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
import { withCustomerLock, finalizeSuccessfulPayment, logInternalError, logInternalErrorOnce } from '@suiftly/database/billing';
import { getStripeService } from '@suiftly/database/stripe-mock';
import { paymentWebhookEvents, customerPaymentMethods, customers, billingRecords, invoicePayments } from '@suiftly/database/schema';
import { eq, and, gt } from 'drizzle-orm';
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

  // Constant-time comparison (timingSafeEqual throws RangeError if lengths differ)
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false, error: 'Signature mismatch' };
  }

  return { valid: true };
}

/**
 * Resolve customerId from a Stripe event object's metadata.
 * Tries billing_record_id first (authoritative), then stripeCustomerId fallback.
 * Returns null if neither resolves. Non-throwing.
 */
async function resolveCustomerIdFromEvent(
  obj: Record<string, unknown> | undefined,
): Promise<number | null> {
  if (!obj) return null;
  try {
    const metadata = obj.metadata as Record<string, string> | undefined;
    const billingRecordIdStr = metadata?.billing_record_id;
    if (billingRecordIdStr) {
      const brId = parseInt(billingRecordIdStr, 10);
      if (!isNaN(brId)) {
        const rec = await db.query.billingRecords.findFirst({
          columns: { customerId: true },
          where: eq(billingRecords.id, brId),
        });
        if (rec) return rec.customerId;
      }
    }
    const stripeCustomerId = obj.customer as string | undefined;
    if (stripeCustomerId) {
      const cust = await db.query.customers.findFirst({
        columns: { customerId: true },
        where: eq(customers.stripeCustomerId, stripeCustomerId),
      });
      if (cust) return cust.customerId;
    }
  } catch { /* non-fatal */ }
  return null;
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
      // Notify admin — persistent failures indicate misconfiguration or an attack.
      // Uses logInternalErrorOnce with synthetic invoiceId to deduplicate under rapid fire.
      try {
        await logInternalErrorOnce(db, {
          severity: 'warning',
          category: 'security',
          code: 'WEBHOOK_SIGNATURE_FAILED',
          message: `Stripe webhook signature verification failed: ${verification.error}`,
          details: {
            error: verification.error,
            ip: request.ip,
            userAgent: request.headers['user-agent'],
          },
          invoiceId: -1,
        });
      } catch { /* don't block the 400 response */ }
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

    // 2. Atomic idempotency — INSERT ON CONFLICT DO NOTHING ensures exactly one
    // request processes each event. All conflicts return 200 (duplicate).
    //
    // Retry-after-failure: the catch block deletes the row on failure, so
    // Stripe's next retry (sequential, ~1 min+ later) inserts fresh.
    //
    // Architecture note: Stripe delivers events sequentially to a single
    // endpoint with exponential backoff. True concurrent delivery only occurs
    // with multi-instance deployments behind a load balancer. If we scale to
    // multiple instances, this should be replaced with a PostgreSQL advisory
    // lock (pg_advisory_xact_lock) on a hash of the event ID.
    const insertResult = await db.insert(paymentWebhookEvents).values({
      eventId: event.id,
      providerType: 'stripe',
      eventType: event.type,
      processed: false,
      data: rawBody,
    }).onConflictDoNothing();

    if (insertResult.rowCount === 0) {
      console.log(`[Stripe Webhook] Event ${event.id} already claimed, skipping`);
      return reply.status(200).send({ received: true, duplicate: true });
    }

    // Resolve customerId from event payload for the webhook event row.
    // This enables customer-scoped cleanup in resetTestData.
    const webhookCustomerId = await resolveCustomerIdFromEvent(
      event.data?.object as Record<string, unknown> | undefined,
    );

    // Set customerId on the webhook event row (for customer-scoped cleanup)
    if (webhookCustomerId) {
      await db.update(paymentWebhookEvents)
        .set({ customerId: webhookCustomerId })
        .where(eq(paymentWebhookEvents.eventId, event.id));
    }

    // 3. Handle event types
    try {
      if (!event.data?.object) {
        console.error(`[Stripe Webhook] Event ${event.id} missing data.object`);
        // Mark processed so retries don't get stuck — a malformed event won't
        // become valid on retry, and leaving it unprocessed blocks the event ID.
        await db.update(paymentWebhookEvents)
          .set({ processed: true, processedAt: new Date() })
          .where(eq(paymentWebhookEvents.eventId, event.id));
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

      // Delete the event row so Stripe's next retry inserts fresh and reprocesses.
      // If this delete fails (extremely unlikely — same DB connection), the row
      // stays processed=false and the event is stuck. A periodic cleanup job
      // could handle that edge case if needed.
      try {
        await db.delete(paymentWebhookEvents)
          .where(eq(paymentWebhookEvents.eventId, event.id));
      } catch {
        // Non-fatal — event stays claimed but unprocessed
      }

      // Notify admin. Each failed attempt logs separately (Stripe retries ~7
      // times over 3 days), which gives admins visibility into persistent vs
      // transient failures. The eventId in details links related notifications.
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

      // Return 500 so Stripe retries delivery.
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
 * 3. Finalize: clear pendingInvoiceId, set paidOnce, clear grace period,
 *    issue reconciliation credit, recalculate DRAFT (via finalizeSuccessfulPayment)
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

  // Already paid — check whether this webhook is confirming the same Stripe charge
  // that was already processed synchronously (via invoices.pay() in the provider chain),
  // or whether it's a genuine double charge (e.g., customer completed 3DS on a stale
  // Stripe-hosted page after escrow already paid).
  if (record.status === 'paid') {
    // Check if an invoice_payments row already exists for this exact Stripe invoice ID.
    // If so, this webhook is just the async confirmation of a charge we already reconciled
    // synchronously — not a double charge. No refund needed.
    const [existingPayment] = await db.select({ paymentId: invoicePayments.paymentId })
      .from(invoicePayments)
      .where(and(
        eq(invoicePayments.billingRecordId, billingRecordId),
        eq(invoicePayments.sourceType, 'stripe'),
        eq(invoicePayments.providerReferenceId, stripeInvoiceId),
      ))
      .limit(1);

    if (existingPayment) {
      console.log(`[Stripe Webhook] invoice.paid: billing record ${billingRecordId} already paid by same Stripe invoice ${stripeInvoiceId} — webhook confirmation, no action needed`);
      return;
    }

    // Genuine double charge: a different provider (or different Stripe invoice) already paid.
    console.log(`[Stripe Webhook] invoice.paid: billing record ${billingRecordId} already paid by another source — auto-refunding Stripe charge ${stripeInvoiceId}`);
    const stripeService = getStripeService();
    try {
      const refundResult = await stripeService.refund({
        stripeInvoiceId: stripeInvoiceId,
        amountUsdCents: amountPaid ?? Number(record.amountUsdCents),
        reason: `Auto-refund: billing record ${billingRecordId} already paid by another source`,
      });
      await logInternalError(db, {
        severity: 'error',
        category: 'billing',
        code: 'DOUBLE_CHARGE_AUTO_REFUNDED',
        message: `Auto-refunded Stripe charge on already-paid invoice ${billingRecordId}`,
        details: { stripeInvoiceId, refundId: refundResult.refundId, refundSuccess: refundResult.success, amountPaid },
        customerId: record.customerId,
        invoiceId: billingRecordId,
      });
    } catch (err) {
      // Refund failed — escalate so admin can manually refund
      await logInternalError(db, {
        severity: 'error',
        category: 'billing',
        code: 'DOUBLE_CHARGE_REFUND_FAILED',
        message: `MANUAL ACTION REQUIRED: Stripe charged already-paid invoice ${billingRecordId} and auto-refund failed`,
        details: { stripeInvoiceId, error: err instanceof Error ? err.message : String(err), amountPaid },
        customerId: record.customerId,
        invoiceId: billingRecordId,
      });
    }
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

    // 2. Update billing_records: status='paid', clear stale failure metadata.
    //    Keep retryCount as audit trail (how many attempts before success).
    //    Clear failureReason/lastRetryAt/paymentActionUrl so they don't leak into
    //    UI, alerts, or retry heuristics for what is now a paid invoice.
    //    amountPaidUsdCents: ADD Stripe payment to any credits already applied
    //    (credits are applied before the provider chain and NOT rolled back on failure,
    //    so freshRecord.amountPaidUsdCents may already include credit payments).
    const existingPaidCents = Number(freshRecord.amountPaidUsdCents ?? 0);
    await tx
      .update(billingRecords)
      .set({
        status: 'paid',
        amountPaidUsdCents: existingPaidCents + invoiceAmount,
        paymentActionUrl: null,
        pendingStripeInvoiceId: null,
        failureReason: null,
        lastRetryAt: null,
      })
      .where(eq(billingRecords.id, billingRecordId));

    // 3. Finalize: clear pendingInvoiceId, set paidOnce, clear grace period,
    //    issue reconciliation credit, and recalculate DRAFT — all via shared function.
    await finalizeSuccessfulPayment(tx, customerId, billingRecordId, clock);

    console.log(`[Stripe Webhook] invoice.paid: fully reconciled billing record ${billingRecordId} for customer ${customerId}`);
  });
}

/**
 * Handle payment_intent.succeeded
 *
 * Intentionally a no-op. We use the Invoices API, so Stripe always fires
 * invoice.paid alongside payment_intent.succeeded — handleInvoicePaid is
 * the canonical reconciliation path (including late 3DS completion).
 *
 * If another provider already paid the invoice, handleInvoicePaid auto-refunds
 * the duplicate Stripe charge (Fix 1a). If 3DS times out, reconcileStuckInvoices
 * voids the Stripe invoice (Fix 2).
 */
async function handlePaymentIntentSucceeded(paymentIntent: Record<string, unknown>) {
  const intentId = paymentIntent.id as string;
  const stripeCustomerId = paymentIntent.customer as string | null;
  const metadata = paymentIntent.metadata as Record<string, string> | null;
  const billingRecordId = metadata?.billing_record_id;

  // Intentionally a no-op for reconciliation. invoice.paid is the canonical path
  // for Invoices API charges. If invoice.paid never arrives (Stripe bug/misconfiguration),
  // reconcileStuckInvoices (10-min threshold) catches it. Adding reconciliation here
  // would race with handleInvoicePaid (both fire within seconds of each other).
  console.log(`[Stripe Webhook] payment_intent.succeeded: ${intentId}, customer: ${stripeCustomerId}, billingRecordId: ${billingRecordId ?? 'none'}`);
}

/**
 * Handle payment_intent.payment_failed
 *
 * The provider chain already handles failures by falling through to the next
 * provider and records failureReason on the billing record. The retry-exhaustion
 * path notifies admins via PAYMENT_RETRIES_EXHAUSTED.
 *
 * This webhook provides additional context: Stripe-side error details that may
 * not be in our billing record (e.g., decline codes, issuer messages).
 */
async function handlePaymentIntentFailed(paymentIntent: Record<string, unknown>) {
  const intentId = paymentIntent.id as string;
  const lastError = paymentIntent.last_payment_error as Record<string, unknown> | null;
  const errorMessage = lastError?.message as string || 'Unknown error';
  const declineCode = lastError?.decline_code as string | undefined;
  const metadata = paymentIntent.metadata as Record<string, string> | null;
  const billingRecordId = metadata?.billing_record_id;

  console.log(`[Stripe Webhook] payment_intent.payment_failed: ${intentId}, error: ${errorMessage}, decline: ${declineCode}`);

  // Resolve customerId once for admin notification triage
  const customerId = await resolveCustomerIdFromEvent(paymentIntent) ?? undefined;

  // Log to admin notifications for visibility into Stripe-side failure details.
  // Uses logInternalErrorOnce keyed on invoiceId to avoid noise from Stripe retries.
  const parsedInvoiceId = billingRecordId ? parseInt(billingRecordId, 10) : undefined;
  if (parsedInvoiceId && !isNaN(parsedInvoiceId)) {
    try {
      await logInternalErrorOnce(db, {
        severity: 'warning',
        category: 'billing',
        code: 'STRIPE_PAYMENT_FAILED',
        message: `Stripe payment failed for invoice ${parsedInvoiceId}: ${errorMessage}`,
        details: { intentId, errorMessage, declineCode },
        customerId,
        invoiceId: parsedInvoiceId,
      });
    } catch { /* don't block webhook response */ }
  } else {
    // No billing_record_id — could be a manual charge, misconfigured invoice metadata,
    // or a payment intent from a different integration. Log for admin triage.
    // Use logInternalError (not Once) because each distinct intentId is a separate event
    // worth investigating — the synthetic invoiceId:-2 dedup key was too coarse.
    try {
      await logInternalError(db, {
        severity: 'info',
        category: 'billing',
        code: 'STRIPE_PAYMENT_FAILED_NO_METADATA',
        message: `Stripe payment_intent.payment_failed without billing_record_id: ${intentId}`,
        details: { intentId, stripeCustomerId: paymentIntent.customer, errorMessage, declineCode, metadata },
        customerId,
      });
    } catch { /* don't block webhook response */ }
  }
}

/**
 * Handle setup_intent.succeeded
 * Records the payment method details in customer_payment_methods.
 * This fires after the user completes the Stripe card setup flow (including 3DS).
 */
export async function handleSetupIntentSucceeded(setupIntent: Record<string, unknown>) {
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
    await logInternalError(db, {
      severity: 'warning',
      category: 'billing',
      code: 'WEBHOOK_SETUP_INTENT_NO_CUSTOMER',
      message: `setup_intent.succeeded: no customer found for stripeCustomerId ${stripeCustomerId} — possible data inconsistency`,
      details: { stripeCustomerId, paymentMethodId, metadata },
    });
    return;
  }

  // Acquire customer lock to prevent race conditions with concurrent payment method
  // additions (e.g., user adding via API while webhook fires simultaneously).
  // Without the lock, both could read the same maxPriority and insert at the same priority.
  await withCustomerLock(db, customer.customerId, async (tx) => {
    // Upsert the payment method details into customer_payment_methods.
    // First try by providerRef (idempotent re-delivery of the same webhook).
    // Then check for an existing active stripe row (e.g., from a previous setup
    // that was interrupted, or a re-add after removal).
    let existingMethod = await tx.query.customerPaymentMethods.findFirst({
      where: eq(customerPaymentMethods.providerRef, paymentMethodId),
    });

    if (!existingMethod) {
      // Check for an existing active stripe method for this customer
      existingMethod = await tx.query.customerPaymentMethods.findFirst({
        where: and(
          eq(customerPaymentMethods.customerId, customer.customerId),
          eq(customerPaymentMethods.providerType, 'stripe'),
          eq(customerPaymentMethods.status, 'active'),
        ),
      });
    }

    // Get card details: prefer Stripe API (authoritative), fall back to metadata (mock mode).
    // This ordering ensures live card data is never overwritten by stale metadata
    // if concurrent setup_intent.succeeded webhooks race (e.g., multiple browser tabs).
    let cardDetails: { brand: string; last4: string } | null = null;
    try {
      const stripeService = getStripeService();
      const methods = await stripeService.getPaymentMethods(stripeCustomerId);
      const pm = methods.find(m => m.id === paymentMethodId);
      if (pm) {
        cardDetails = { brand: pm.brand, last4: pm.last4 };
      }
    } catch (err) {
      console.error('[Stripe Webhook] Failed to fetch card details from Stripe:', err);
      try {
        await logInternalError(db, {
          severity: 'info',
          category: 'billing',
          code: 'CARD_DETAILS_FETCH_FAILED',
          message: `Failed to fetch card details for payment method ${paymentMethodId}`,
          details: { error: err instanceof Error ? err.message : String(err), stripeCustomerId },
          customerId: customer.customerId,
        });
      } catch { /* don't block webhook */ }
    }
    // Fallback: use metadata (mock mode provides card_brand/card_last4 on SetupIntent)
    if (!cardDetails && metadata?.card_brand && metadata?.card_last4) {
      cardDetails = { brand: metadata.card_brand, last4: metadata.card_last4 };
    }

    if (existingMethod) {
      // Update with confirmed card details + providerRef (may be null from addPaymentMethod)
      await tx.update(customerPaymentMethods)
        .set({
          status: 'active',
          providerRef: paymentMethodId,
          providerConfig: cardDetails ?? existingMethod.providerConfig,
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
        providerConfig: cardDetails ?? null,
      });
    }

    console.log(`[Stripe Webhook] Payment method ${paymentMethodId} saved for customer ${customer.customerId}`);

    // Set as default payment method on the Stripe customer so invoices.pay()
    // can charge without an explicit payment_method parameter.
    try {
      const stripeService = getStripeService();
      await stripeService.setDefaultPaymentMethod(stripeCustomerId, paymentMethodId);
      console.log(`[Stripe Webhook] Set default payment method ${paymentMethodId} on Stripe customer ${stripeCustomerId}`);
    } catch (err) {
      console.error(`[Stripe Webhook] Failed to set default payment method on Stripe customer:`, err);
    }

    // Clear failure metadata on recent failed invoices so the reactive retry (GM
    // sync below) can charge the new card. We keep retryCount intact to preserve
    // Stripe idempotency key uniqueness — resetting to 0 would collide with the
    // original attempt's key within Stripe's 24h window, returning a cached
    // requires_action result instead of charging the new card.
    // The reactive path (retryUnpaidInvoices without limits) ignores retryCount,
    // so exhausted invoices are still retried.
    //
    // Scoped to invoices created in the last 90 days to avoid reviving very old
    // failures (e.g., from cancelled services months ago). 90 days covers 3
    // billing cycles — any invoice older than that should be handled manually.
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const resetResult = await tx.update(billingRecords)
      .set({ failureReason: null, lastRetryAt: null })
      .where(
        and(
          eq(billingRecords.customerId, customer.customerId),
          eq(billingRecords.status, 'failed'),
          gt(billingRecords.createdAt, ninetyDaysAgo),
        )
      )
      .returning({ id: billingRecords.id });

    if (resetResult.length > 0) {
      console.log(`[Stripe Webhook] Cleared failure metadata on ${resetResult.length} failed invoice(s) for customer ${customer.customerId}: [${resetResult.map(r => r.id).join(', ')}]`);
    }

  });

  // Fire-and-forget: queue payment retry via GM task queue.
  // This triggers retryUnpaidInvoices (no retryCount limit) reactively,
  // so the customer doesn't have to wait for the periodic cycle.
  // If this call fails, the periodic processor will still pick up the invoices
  // because we cleared failure metadata (failureReason, lastRetryAt) above.
  try {
    const gmUrl = config.GM_URL || 'http://localhost:22600';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const gmResponse = await fetch(`${gmUrl}/api/queue/sync-customer/${customer.customerId}?source=api&async=true`, {
      method: 'POST',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (gmResponse.ok) {
      console.log(`[Stripe Webhook] Queued payment retry for customer ${customer.customerId}`);
    } else {
      console.error(`[Stripe Webhook] GM sync-customer returned ${gmResponse.status}`);
      try {
        await logInternalError(db, {
          severity: 'warning',
          category: 'billing',
          code: 'WEBHOOK_GM_QUEUE_FAILED',
          message: `GM sync-customer returned ${gmResponse.status} while queuing Stripe webhook retry for customer ${customer.customerId}`,
          details: { status: gmResponse.status, statusText: gmResponse.statusText },
          customerId: customer.customerId,
        });
      } catch { /* avoid blocking webhook response on alert failure */ }
    }
  } catch (err: any) {
    // Non-fatal: periodic processor will retry on next cycle (failureReason was cleared above)
    console.error(`[Stripe Webhook] Failed to queue payment retry:`, err.name === 'AbortError' ? 'timeout' : err.message);
    try {
      await logInternalError(db, {
        severity: 'warning',
        category: 'billing',
        code: 'WEBHOOK_GM_QUEUE_FAILED',
        message: `Error queueing GM sync-customer after Stripe webhook for customer ${customer.customerId}`,
        details: { error: err instanceof Error ? err.message : String(err) },
        customerId: customer.customerId,
      });
    } catch { /* avoid blocking webhook response on alert failure */ }
  }
}
