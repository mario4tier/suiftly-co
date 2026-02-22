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

    // Check that Stripe customer has at least one payment method
    const methods = await this.stripeService.getPaymentMethods(customer.stripeCustomerId);
    return methods.length > 0;
  }

  async charge(params: ProviderChargeParams): Promise<ProviderChargeResult> {
    const customer = await this.getCustomer(params.customerId);
    if (!customer?.stripeCustomerId) {
      return { success: false, error: 'No Stripe customer configured', errorCode: 'account_not_configured', retryable: false };
    }

    const result = await this.stripeService.charge({
      stripeCustomerId: customer.stripeCustomerId,
      amountUsdCents: params.amountUsdCents,
      description: params.description,
      idempotencyKey: `inv_${params.invoiceId}_stripe`,
      billingRecordId: params.invoiceId,
    });

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
