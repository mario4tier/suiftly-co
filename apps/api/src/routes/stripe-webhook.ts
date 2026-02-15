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
import { paymentWebhookEvents, customerPaymentMethods, customers } from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import { config } from '../lib/config';

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
    const verification = verifyStripeSignature(
      rawBody,
      signatureHeader,
      config.STRIPE_WEBHOOK_SECRET
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
      console.error(`[Stripe Webhook] Error processing event ${event.id}:`, error);
      // Still return 200 to prevent Stripe retries — the event is recorded
      // and can be reprocessed manually if needed
    }

    // 5. Always return 200 (Stripe retries on non-2xx)
    return reply.status(200).send({ received: true });
    });
  }); // end stripePlugin

  console.log('[Stripe Webhook] Registered POST /stripe/webhook');
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

  console.log(`[Stripe Webhook] payment_intent.succeeded: ${intentId}, customer: ${stripeCustomerId}`);
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

  // Find the customer by stripeCustomerId
  const customer = await db.query.customers.findFirst({
    where: eq(customers.stripeCustomerId, stripeCustomerId),
  });

  if (!customer) {
    console.error(`[Stripe Webhook] No customer found for stripeCustomerId: ${stripeCustomerId}`);
    return;
  }

  // Upsert the payment method details into customer_payment_methods
  // The row may already exist from billing.addPaymentMethod — update providerRef + providerConfig
  // First try by providerRef (idempotent re-delivery), then by customerId + providerType
  let existingMethod = await db.query.customerPaymentMethods.findFirst({
    where: eq(customerPaymentMethods.providerRef, paymentMethodId),
  });

  if (!existingMethod) {
    // addPaymentMethod('stripe') creates the row with providerRef=null —
    // find it by customerId + providerType + active status
    existingMethod = await db.query.customerPaymentMethods.findFirst({
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
    await db.update(customerPaymentMethods)
      .set({
        status: 'active',
        providerRef: paymentMethodId,
        providerConfig: cardDetails ? JSON.stringify(cardDetails) : existingMethod.providerConfig,
        updatedAt: new Date(),
      })
      .where(eq(customerPaymentMethods.id, existingMethod.id));
  } else {
    // Determine next priority for this customer
    const existingMethods = await db.select()
      .from(customerPaymentMethods)
      .where(eq(customerPaymentMethods.customerId, customer.customerId));

    const maxPriority = existingMethods.reduce((max, m) => Math.max(max, m.priority), 0);

    await db.insert(customerPaymentMethods).values({
      customerId: customer.customerId,
      providerType: 'stripe',
      status: 'active',
      priority: maxPriority + 1,
      providerRef: paymentMethodId,
      providerConfig: cardDetails ? JSON.stringify(cardDetails) : null,
    });
  }

  console.log(`[Stripe Webhook] Payment method ${paymentMethodId} saved for customer ${customer.customerId}`);
}
