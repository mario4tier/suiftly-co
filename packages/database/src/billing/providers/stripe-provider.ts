/**
 * Stripe Payment Provider
 *
 * Uses Stripe Payment Intents API with off_session for background charges.
 * Card was saved via SetupIntent (which collected 3DS consent).
 *
 * When requires_action occurs (3DS exemption denied):
 * - Returns { success: false, retryable: false }
 * - Provider chain falls through to next provider
 * - Dashboard shows "Complete payment" prompt for manual 3DS completion
 */

import { eq, and } from 'drizzle-orm';
import type { IPaymentProvider, ProviderChargeParams, ProviderChargeResult, ProviderInfo } from '@suiftly/shared/payment-provider';
import type { IStripeService } from '@suiftly/shared/stripe-service';
import type { DatabaseOrTransaction } from '../../db';
import { customers, customerPaymentMethods } from '../../schema';
import { logInternalError } from '../admin-notifications';

export class StripePaymentProvider implements IPaymentProvider {
  readonly type = 'stripe' as const;

  constructor(
    private stripeService: IStripeService,
    private db: DatabaseOrTransaction,
  ) {}

  async canPay(customerId: number, _amountUsdCents: number): Promise<boolean> {
    // Stripe can always attempt a charge if configured
    // (unlike escrow, no pre-check balance — Stripe handles insufficient funds)
    return this.isConfigured(customerId);
  }

  async isConfigured(customerId: number): Promise<boolean> {
    const customer = await this.getCustomer(customerId);
    if (!customer?.stripeCustomerId) return false;

    // Check that Stripe customer has at least one payment method.
    // Catch transient Stripe/network errors so the provider chain can
    // fall through to the next provider instead of aborting.
    try {
      const methods = await this.stripeService.getPaymentMethods(customer.stripeCustomerId);
      return methods.length > 0;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[StripeProvider] canPay failed for customer ${customerId}: ${msg}`);
      // Surface to admin — a persistent auth/config error here silently
      // demotes Stripe from the provider chain for this customer.
      try {
        await logInternalError(this.db, {
          severity: 'warning',
          category: 'billing',
          code: 'STRIPE_API_UNREACHABLE',
          message: `Stripe API error in canPay for customer ${customerId}: ${msg}`,
          details: { stack: error instanceof Error ? error.stack : undefined },
          customerId,
        });
      } catch { /* don't let notification failure affect the result */ }
      return false;
    }
  }

  async charge(params: ProviderChargeParams): Promise<ProviderChargeResult> {
    const customer = await this.getCustomer(params.customerId);
    if (!customer?.stripeCustomerId) {
      return { success: false, error: 'No Stripe customer configured', errorCode: 'account_not_configured', retryable: false };
    }

    // Wrap Stripe API call so transient network/API errors return a retryable
    // failure instead of throwing and aborting the entire provider chain.
    let result;
    try {
      result = await this.stripeService.charge({
        stripeCustomerId: customer.stripeCustomerId,
        amountUsdCents: params.amountUsdCents,
        description: params.description,
        idempotencyKey: `inv_${params.invoiceId}_stripe_r${params.retryCount}`,
        billingRecordId: params.invoiceId,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[StripeProvider] charge failed for customer ${params.customerId}, invoice ${params.invoiceId}: ${msg}`);
      // Surface to admin — Stripe charge threw an unexpected exception.
      try {
        await logInternalError(this.db, {
          severity: 'error',
          category: 'billing',
          code: 'STRIPE_CHARGE_EXCEPTION',
          message: `Stripe charge exception for customer ${params.customerId}, invoice ${params.invoiceId}: ${msg}`,
          details: { stack: error instanceof Error ? error.stack : undefined },
          customerId: params.customerId,
          invoiceId: params.invoiceId,
        });
      } catch { /* don't let notification failure affect the result */ }
      return { success: false, error: `Stripe API error: ${msg}`, retryable: true };
    }

    // Stripe signaled requires_action but did not supply a hosted invoice URL.
    // Without a URL, the user cannot complete 3DS; alert admin for investigation.
    if (result.requiresAction && !result.hostedInvoiceUrl) {
      try {
        await logInternalError(this.db, {
          severity: 'error',
          category: 'billing',
          code: 'STRIPE_REQUIRES_ACTION_NO_URL',
          message: `Stripe requires_action without hosted_invoice_url for customer ${params.customerId}, invoice ${params.invoiceId}`,
          details: {
            stripeInvoiceId: result.stripeInvoiceId,
            paymentIntentId: result.paymentIntentId,
            error: result.error,
          },
          customerId: params.customerId,
          invoiceId: params.invoiceId,
        });
      } catch { /* alert failure should not block the provider chain */ }
    }

    if (result.success && result.paymentIntentId) {
      return {
        success: true,
        // Prefer stripeInvoiceId for refund correlation; fall back to paymentIntentId
        referenceId: result.stripeInvoiceId ?? result.paymentIntentId,
        retryable: false,
      };
    }

    // requires_action (3DS) or other failure — not retryable via provider chain
    const errorCode = result.requiresAction
      ? 'requires_action' as const
      : result.errorCode === 'card_declined'
        ? 'card_declined' as const
        : undefined;

    return {
      success: false,
      error: result.error ?? 'Stripe charge failed',
      errorCode,
      hostedInvoiceUrl: result.hostedInvoiceUrl,
      stripeInvoiceId: result.stripeInvoiceId,
      retryable: result.retryable,
    };
  }

  async getInfo(customerId: number): Promise<ProviderInfo | null> {
    // Read cached card details from customer_payment_methods.providerConfig
    const [method] = await this.db
      .select()
      .from(customerPaymentMethods)
      .where(
        and(
          eq(customerPaymentMethods.customerId, customerId),
          eq(customerPaymentMethods.providerType, 'stripe'),
          eq(customerPaymentMethods.status, 'active'),
        ),
      )
      .limit(1);

    if (!method) return null;

    const config = method.providerConfig as { brand?: string; last4?: string } | null;
    const brand = config?.brand ?? 'Card';
    const last4 = config?.last4 ?? '****';

    return {
      type: 'stripe',
      displayLabel: `${brand.charAt(0).toUpperCase() + brand.slice(1)} ending in ${last4}`,
      details: config ?? {},
    };
  }

  private async getCustomer(customerId: number) {
    const [customer] = await this.db
      .select()
      .from(customers)
      .where(eq(customers.customerId, customerId))
      .limit(1);
    return customer;
  }
}
