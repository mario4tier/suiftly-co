/**
 * PayPal Payment Provider (Stub)
 *
 * Placeholder for future PayPal integration.
 * All operations return false/null — PayPal is not yet supported.
 */

import type { IPaymentProvider, ProviderChargeParams, ProviderChargeResult, ProviderInfo } from '@suiftly/shared/payment-provider';

export class PayPalPaymentProvider implements IPaymentProvider {
  readonly type = 'paypal' as const;

  async canPay(_customerId: number, _amountUsdCents: number): Promise<boolean> {
    return false;
  }

  async isConfigured(_customerId: number): Promise<boolean> {
    return false;
  }

  async charge(_params: ProviderChargeParams): Promise<ProviderChargeResult> {
    return {
      success: false,
      error: 'PayPal is not yet supported',
      retryable: false,
    };
  }

  async getInfo(): Promise<ProviderInfo | null> {
    return null;
  }
}
