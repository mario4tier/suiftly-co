/**
 * Payment Provider Interface
 *
 * Abstraction over payment methods (Crypto, Stripe, PayPal).
 * Credits are NOT a provider — they are always applied first
 * in processInvoicePayment() before providers are tried.
 *
 * All providers are equal. Priority is determined by user preference,
 * not by provider type.
 */

export type PaymentProviderType = 'escrow' | 'stripe' | 'paypal';

export interface IPaymentProvider {
  /** Provider identifier */
  readonly type: PaymentProviderType;

  /**
   * Is this provider configured AND able to charge?
   * - Crypto: has escrowContractId AND balance >= amount
   * - Stripe: has stripeCustomerId AND has saved payment method
   * - PayPal: has linked PayPal account
   */
  canPay(customerId: number, amountUsdCents: number): Promise<boolean>;

  /**
   * Is the payment method set up? (not necessarily funded)
   * - Crypto: has escrowContractId
   * - Stripe: has stripeCustomerId with saved card
   * - PayPal: has linked account
   */
  isConfigured(customerId: number): Promise<boolean>;

  /**
   * Execute a charge.
   *
   * The provider is responsible for:
   * 1. Creating provider-specific records (e.g., escrow_transactions)
   * 2. Returning a referenceId for the invoice_payments record
   *
   * The CALLER (processInvoicePayment) is responsible for:
   * 1. Creating the invoice_payments row using the returned referenceId
   * 2. Updating the billing_records status
   */
  charge(params: ProviderChargeParams): Promise<ProviderChargeResult>;

  /**
   * Display info for the billing UI.
   *
   * NOTE: For escrow, this should be computed live (balance changes
   * with every deposit/withdrawal/charge). For Stripe/PayPal, cached
   * data from customer_payment_methods.providerConfig is fine.
   */
  getInfo(customerId: number): Promise<ProviderInfo | null>;
}

export interface ProviderChargeParams {
  customerId: number;
  amountUsdCents: number;
  invoiceId: number;
  description: string;
}

export interface ProviderChargeResult {
  success: boolean;
  /** Reference ID for invoice_payments (escrow tx ID, Stripe payment intent ID, PayPal order ID) */
  referenceId?: string;
  /**
   * Provider-specific transaction digest (escrow only).
   * Used to set billing_records.txDigest for on-chain traceability.
   * NULL for Stripe/PayPal — billing_records.txDigest stays NULL for those.
   */
  txDigest?: Buffer;
  error?: string;
  /** Provider-specific error code for targeted UI guidance */
  errorCode?: 'insufficient_escrow' | 'card_declined' | 'requires_action' | 'account_not_configured';
  /**
   * Stripe-hosted invoice URL for 3DS completion (Stripe only).
   * Set when charge returns requires_action — the user must visit this URL
   * to complete authentication. Stored on billing_records.paymentActionUrl.
   */
  hostedInvoiceUrl?: string;
  retryable: boolean;
}

export interface ProviderInfo {
  type: PaymentProviderType;
  /** e.g. "Visa ending in 4242", "Escrow: $12.50 USDC", "PayPal: user@email.com" */
  displayLabel: string;
  details: Record<string, unknown>;
}
