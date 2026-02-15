/**
 * Stripe Service Interface Types
 *
 * These types define the contract for Stripe payment operations.
 * Follows the same pattern as ISuiService for consistency.
 *
 * Both mock and real implementations conform to these interfaces.
 */

/**
 * Stripe Service Interface
 *
 * Contract for Stripe payment operations.
 * Both mock and real implementations must conform to this interface.
 */
export interface IStripeService {
  /**
   * Create a Stripe Customer (called when user adds card as payment method).
   */
  createCustomer(params: {
    customerId: number;
    walletAddress: string;
    email?: string;
  }): Promise<{ stripeCustomerId: string }>;

  /**
   * Create a SetupIntent for saving a card.
   * The SetupIntent collects 3DS consent for future off_session charges.
   * Returns client_secret for frontend confirmation.
   */
  createSetupIntent(stripeCustomerId: string): Promise<{
    clientSecret: string;
    setupIntentId: string;
  }>;

  /**
   * Charge a saved payment method (off_session, merchant-initiated).
   * May return requires_action if 3DS exemption is denied.
   */
  charge(params: StripeChargeParams): Promise<StripeChargeResult>;

  /**
   * Get saved payment methods for a customer.
   */
  getPaymentMethods(stripeCustomerId: string): Promise<StripePaymentMethod[]>;

  /**
   * Delete a saved payment method.
   */
  deletePaymentMethod(paymentMethodId: string): Promise<void>;

  /** Is this the mock implementation? */
  isMock(): boolean;
}

export interface StripeChargeParams {
  stripeCustomerId: string;
  amountUsdCents: number;
  description: string;
  idempotencyKey: string;
}

export interface StripeChargeResult {
  success: boolean;
  paymentIntentId?: string;
  error?: string;
  /** True if 3DS needed — card authentication required */
  requiresAction?: boolean;
  /** For frontend 3DS completion (if requiresAction) */
  clientSecret?: string;
  retryable: boolean;
}

export interface StripePaymentMethod {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}
