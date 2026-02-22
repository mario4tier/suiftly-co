/**
 * Real Stripe Service Implementation
 *
 * Uses the Stripe Invoices API for charges (not raw PaymentIntents).
 * Follows the same IStripeService interface as MockStripeService.
 *
 * Key design decisions (from PAYMENT_DESIGN.md):
 * - Invoices API: Creates Invoice + InvoiceItem, finalizes, pays. Stripe creates PaymentIntents internally.
 * - SetupIntent with usage: 'off_session' for saving cards with 3DS consent.
 * - auto_advance: false — we control finalization timing.
 * - automatic_tax: { enabled: false } — flip to true when nexus is reached.
 * - Idempotency keys on all mutating API calls.
 */

import Stripe from 'stripe';
import type {
  IStripeService,
  StripeChargeParams,
  StripeChargeResult,
  StripePaymentMethod,
  StripeRefundParams,
  StripeRefundResult,
} from '@suiftly/shared/stripe-service';

export class StripeService implements IStripeService {
  private stripe: Stripe;

  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey, {
      typescript: true,
    });
  }

  async createCustomer(params: {
    customerId: number;
    walletAddress: string;
    email?: string;
  }): Promise<{ stripeCustomerId: string }> {
    const customer = await this.stripe.customers.create({
      metadata: {
        suiftly_customer_id: String(params.customerId),
        wallet_address: params.walletAddress,
      },
      ...(params.email ? { email: params.email } : {}),
    });

    return { stripeCustomerId: customer.id };
  }

  async createSetupIntent(stripeCustomerId: string): Promise<{
    clientSecret: string;
    setupIntentId: string;
  }> {
    const setupIntent = await this.stripe.setupIntents.create({
      customer: stripeCustomerId,
      usage: 'off_session',
      payment_method_types: ['card'],
      metadata: {
        stripe_customer_id: stripeCustomerId,
      },
    });

    if (!setupIntent.client_secret) {
      throw new Error('Stripe SetupIntent created without client_secret');
    }

    return {
      clientSecret: setupIntent.client_secret,
      setupIntentId: setupIntent.id,
    };
  }

  async charge(params: StripeChargeParams): Promise<StripeChargeResult> {
    // Track invoice ID so catch block can recover 3DS context if invoices.pay() throws
    let createdInvoiceId: string | undefined;

    try {
      // Step 1: Create a draft invoice
      const invoice = await this.stripe.invoices.create(
        {
          customer: params.stripeCustomerId,
          auto_advance: false,
          collection_method: 'charge_automatically',
          metadata: {
            idempotency_key: params.idempotencyKey,
            description: params.description,
            ...(params.billingRecordId != null ? { billing_record_id: String(params.billingRecordId) } : {}),
          },
          automatic_tax: { enabled: false },
        },
        {
          idempotencyKey: `${params.idempotencyKey}_invoice`,
        },
      );

      createdInvoiceId = invoice.id;

      // Step 2: Add invoice item with the charge amount
      await this.stripe.invoiceItems.create(
        {
          customer: params.stripeCustomerId,
          invoice: invoice.id,
          amount: params.amountUsdCents,
          currency: 'usd',
          description: params.description,
        },
        {
          idempotencyKey: `${params.idempotencyKey}_item`,
        },
      );

      // Step 3: Finalize the invoice
      await this.stripe.invoices.finalizeInvoice(
        invoice.id,
        {},
        {
          idempotencyKey: `${params.idempotencyKey}_finalize`,
        },
      );

      // Step 4: Pay the invoice (Stripe creates PaymentIntent internally)
      const paidInvoice = await this.stripe.invoices.pay(
        invoice.id,
        {},
        {
          idempotencyKey: `${params.idempotencyKey}_pay`,
        },
      );

      // Use invoice ID as the reference. In Stripe SDK v20, payment_intent
      // is not a top-level field on Invoice. The invoice ID is our reference
      // for the charge (stored in invoice_payments.providerReferenceId).
      const referenceId = paidInvoice.id;

      // Check if payment requires action (3DS)
      if (paidInvoice.status === 'open') {
        // Try to get clientSecret for inline 3DS completion:
        // 1. confirmation_secret on the invoice (Stripe SDK v20+)
        // 2. Fall back to PaymentIntent's client_secret if available
        let clientSecret = paidInvoice.confirmation_secret?.client_secret ?? undefined;
        if (!clientSecret) {
          const invoiceAny = paidInvoice as unknown as Record<string, unknown>;
          const piId = typeof invoiceAny.payment_intent === 'string'
            ? invoiceAny.payment_intent
            : undefined;
          if (piId) {
            try {
              const pi = await this.stripe.paymentIntents.retrieve(piId);
              clientSecret = pi.client_secret ?? undefined;
            } catch {
              // Ignore — hostedInvoiceUrl is the primary 3DS mechanism
            }
          }
        }

        return {
          success: false,
          paymentIntentId: referenceId,
          stripeInvoiceId: paidInvoice.id,
          error: 'Card requires authentication',
          errorCode: 'requires_action',
          requiresAction: true,
          clientSecret,
          hostedInvoiceUrl: paidInvoice.hosted_invoice_url ?? undefined,
          retryable: false,
        };
      }

      if (paidInvoice.status === 'paid') {
        return {
          success: true,
          paymentIntentId: referenceId,
          stripeInvoiceId: paidInvoice.id,
          retryable: false,
        };
      }

      // Unexpected status
      return {
        success: false,
        paymentIntentId: referenceId,
        error: `Unexpected invoice status: ${paidInvoice.status}`,
        retryable: true,
      };
    } catch (err) {
      if (err instanceof Stripe.errors.StripeCardError) {
        // authentication_required means 3DS was triggered — recover invoice context
        // so the billing layer can store paymentActionUrl for the user
        if (err.code === 'authentication_required' && createdInvoiceId) {
          try {
            const inv = await this.stripe.invoices.retrieve(createdInvoiceId);
            return {
              success: false,
              paymentIntentId: createdInvoiceId,
              stripeInvoiceId: createdInvoiceId,
              error: 'Card requires authentication',
              errorCode: 'requires_action',
              requiresAction: true,
              hostedInvoiceUrl: inv.hosted_invoice_url ?? undefined,
              retryable: false,
            };
          } catch {
            // Fall through to generic card_declined if invoice retrieval fails
          }
        }

        return {
          success: false,
          error: err.message,
          errorCode: 'card_declined',
          retryable: false,
        };
      }

      if (err instanceof Stripe.errors.StripeError) {
        const retryable =
          err.type === 'StripeRateLimitError' ||
          err.type === 'StripeAPIError' ||
          err.type === 'StripeConnectionError';

        return {
          success: false,
          error: err.message,
          retryable,
        };
      }

      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Stripe charge failed: ${message}`,
        retryable: false,
      };
    }
  }

  async getPaymentMethods(stripeCustomerId: string): Promise<StripePaymentMethod[]> {
    const methods = await this.stripe.paymentMethods.list({
      customer: stripeCustomerId,
      type: 'card',
    });

    // Get the customer's default payment method
    const customer = await this.stripe.customers.retrieve(stripeCustomerId);
    const defaultPmId =
      !customer.deleted && typeof customer.invoice_settings?.default_payment_method === 'string'
        ? customer.invoice_settings.default_payment_method
        : undefined;

    return methods.data.map(pm => ({
      id: pm.id,
      brand: pm.card?.brand ?? 'unknown',
      last4: pm.card?.last4 ?? '****',
      expMonth: pm.card?.exp_month ?? 0,
      expYear: pm.card?.exp_year ?? 0,
      isDefault: pm.id === defaultPmId,
    }));
  }

  async deletePaymentMethod(paymentMethodId: string): Promise<void> {
    await this.stripe.paymentMethods.detach(paymentMethodId);
  }

  async refund(params: StripeRefundParams): Promise<StripeRefundResult> {
    try {
      // Retrieve invoice to get the charge. In Stripe SDK v20+, 'charge' is not
      // a direct top-level field. We use expand to get it, or fall back to
      // payment_intent for refund.
      const invoice = await this.stripe.invoices.retrieve(params.stripeInvoiceId, {
        expand: ['charge'],
      });

      // Try to get charge ID from the invoice (may be on the expanded object)
      const invoiceAny = invoice as unknown as Record<string, unknown>;
      const chargeId = typeof invoiceAny.charge === 'string'
        ? invoiceAny.charge
        : typeof invoiceAny.charge === 'object' && invoiceAny.charge !== null
          ? (invoiceAny.charge as { id: string }).id
          : undefined;

      // Idempotency key based on invoice + amount to prevent duplicate refunds on retry
      const idempotencyKey = `refund_${params.stripeInvoiceId}_${params.amountUsdCents}`;
      const metadata = params.reason ? { reason: params.reason } : undefined;

      if (!chargeId) {
        // Fall back to refunding via payment_intent
        const piId = typeof invoiceAny.payment_intent === 'string'
          ? invoiceAny.payment_intent
          : undefined;

        if (!piId) {
          return { success: false, error: 'Invoice has no associated charge or payment_intent' };
        }

        const refund = await this.stripe.refunds.create(
          {
            payment_intent: piId,
            amount: params.amountUsdCents,
            reason: 'requested_by_customer',
            ...(metadata ? { metadata } : {}),
          },
          { idempotencyKey },
        );
        return { success: true, refundId: refund.id };
      }

      const refund = await this.stripe.refunds.create(
        {
          charge: chargeId,
          amount: params.amountUsdCents,
          reason: 'requested_by_customer',
          ...(metadata ? { metadata } : {}),
        },
        { idempotencyKey },
      );

      return { success: true, refundId: refund.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Stripe refund failed: ${message}` };
    }
  }

  isMock(): boolean {
    return false;
  }
}
