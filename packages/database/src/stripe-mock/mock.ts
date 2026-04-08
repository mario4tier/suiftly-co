/**
 * Mock Stripe Service Implementation
 *
 * Simulates Stripe API behavior using in-memory state.
 * Matches the IStripeService interface exactly so it can be swapped with real implementation.
 *
 * Follows the same pattern as MockSuiService.
 *
 * Configurable via stripeMockConfig:
 * - Artificial delays for UI testing
 * - Deterministic failure injection
 * - 3DS requires_action simulation
 */

import type {
  IStripeService,
  StripeChargeParams,
  StripeChargeResult,
  StripePaymentMethod,
  StripeRefundParams,
  StripeRefundResult,
} from '@suiftly/shared/stripe-service';
import { stripeMockConfig } from './mock-config.js';
import { randomBytes } from 'crypto';

/** In-memory Stripe customer state */
interface MockStripeCustomer {
  stripeCustomerId: string;
  customerId: number;
  walletAddress: string;
  email?: string;
  paymentMethods: MockStripePaymentMethodState[];
  defaultPaymentMethodId?: string;
}

interface MockStripePaymentMethodState {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

/** In-memory payment intent */
interface MockPaymentIntent {
  id: string;
  stripeCustomerId: string;
  amountUsdCents: number;
  status: 'succeeded' | 'requires_action' | 'failed';
  createdAt: Date;
}

/** Recorded refund for test verification */
interface MockRefund {
  refundId: string;
  stripeInvoiceId: string;
  amountUsdCents: number;
  reason?: string;
  createdAt: Date;
}

export class MockStripeService implements IStripeService {
  private customers = new Map<string, MockStripeCustomer>();
  private paymentIntents = new Map<string, MockPaymentIntent>();
  private idempotencyCache = new Map<string, StripeChargeResult>();
  private setupIntents = new Map<string, { stripeCustomerId: string; paymentMethodId: string }>();
  private refunds: MockRefund[] = [];
  private nextCustomerIndex = 1;
  private nextPaymentIntentIndex = 1;
  private nextSetupIntentIndex = 1;
  private nextPaymentMethodIndex = 1;
  private nextRefundIndex = 1;

  async createCustomer(params: {
    customerId: number;
    walletAddress: string;
    email?: string;
  }): Promise<{ stripeCustomerId: string }> {
    await stripeMockConfig.applyDelay('createCustomer');

    // Check if customer already exists by customerId
    for (const customer of this.customers.values()) {
      if (customer.customerId === params.customerId) {
        return { stripeCustomerId: customer.stripeCustomerId };
      }
    }

    const stripeCustomerId = `cus_mock_${this.nextCustomerIndex++}_${randomBytes(4).toString('hex')}`;

    this.customers.set(stripeCustomerId, {
      stripeCustomerId,
      customerId: params.customerId,
      walletAddress: params.walletAddress,
      email: params.email,
      paymentMethods: [],
    });

    return { stripeCustomerId };
  }

  async createSetupIntent(stripeCustomerId: string): Promise<{
    clientSecret: string;
    setupIntentId: string;
  }> {
    await stripeMockConfig.applyDelay('createSetupIntent');

    const customer = this.customers.get(stripeCustomerId);
    if (!customer) {
      throw new Error(`Stripe customer ${stripeCustomerId} not found`);
    }

    const setupIntentId = `seti_mock_${this.nextSetupIntentIndex++}_${randomBytes(4).toString('hex')}`;
    const clientSecret = `${setupIntentId}_secret_${randomBytes(8).toString('hex')}`;

    // In mock mode, automatically "complete" the setup by adding a default test card
    const paymentMethodId = `pm_mock_${this.nextPaymentMethodIndex++}_${randomBytes(4).toString('hex')}`;
    const method: MockStripePaymentMethodState = {
      id: paymentMethodId,
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2027,
    };

    customer.paymentMethods.push(method);
    customer.defaultPaymentMethodId = paymentMethodId;

    // Track setupIntent → customer/paymentMethod mapping for test endpoint
    this.setupIntents.set(setupIntentId, { stripeCustomerId, paymentMethodId });

    return { clientSecret, setupIntentId };
  }

  async charge(params: StripeChargeParams): Promise<StripeChargeResult> {
    await stripeMockConfig.applyDelay('charge');

    // Check idempotency
    const cached = this.idempotencyCache.get(params.idempotencyKey);
    if (cached) {
      return cached;
    }

    // Check forced failure
    const failureMessage = stripeMockConfig.shouldFail('charge');
    if (failureMessage) {
      const result: StripeChargeResult = {
        success: false,
        error: failureMessage,
        errorCode: stripeMockConfig.getFailureErrorCode(),
        retryable: stripeMockConfig.isFailureRetryable(),
      };
      this.idempotencyCache.set(params.idempotencyKey, result);
      return result;
    }

    // Check 3DS simulation
    if (stripeMockConfig.shouldRequireAction()) {
      const paymentIntentId = `pi_mock_${this.nextPaymentIntentIndex++}`;
      const clientSecret = `${paymentIntentId}_secret_${randomBytes(8).toString('hex')}`;
      const stripeInvoiceId = `in_mock_${this.nextPaymentIntentIndex}`;

      this.paymentIntents.set(paymentIntentId, {
        id: paymentIntentId,
        stripeCustomerId: params.stripeCustomerId,
        amountUsdCents: params.amountUsdCents,
        status: 'requires_action',
        createdAt: new Date(),
      });

      const result: StripeChargeResult = {
        success: false,
        paymentIntentId,
        stripeInvoiceId,
        error: 'Card requires authentication',
        errorCode: 'requires_action',
        requiresAction: true,
        clientSecret,
        hostedInvoiceUrl: `https://invoice.stripe.com/i/mock/${stripeInvoiceId}`,
        retryable: false,
      };
      this.idempotencyCache.set(params.idempotencyKey, result);
      return result;
    }

    // Validate customer and payment method exist in local state.
    // Note: the mock may run in a separate process (e.g. Global Manager) that did not
    // create this customer. In that case, treat the customer as valid with a card on file
    // (mirrors real Stripe test mode: any valid customer ID + default payment method succeeds).
    const customer = this.customers.get(params.stripeCustomerId);
    if (customer && customer.paymentMethods.length === 0) {
      const result: StripeChargeResult = {
        success: false,
        error: 'No payment method on file',
        retryable: false,
      };
      this.idempotencyCache.set(params.idempotencyKey, result);
      return result;
    }

    // Success
    const paymentIntentId = `pi_mock_${this.nextPaymentIntentIndex++}`;
    const stripeInvoiceId = `in_mock_${this.nextPaymentIntentIndex}`;

    this.paymentIntents.set(paymentIntentId, {
      id: paymentIntentId,
      stripeCustomerId: params.stripeCustomerId,
      amountUsdCents: params.amountUsdCents,
      status: 'succeeded',
      createdAt: new Date(),
    });

    const result: StripeChargeResult = {
      success: true,
      paymentIntentId,
      stripeInvoiceId,
      retryable: false,
    };
    this.idempotencyCache.set(params.idempotencyKey, result);
    return result;
  }

  async getPaymentMethods(stripeCustomerId: string): Promise<StripePaymentMethod[]> {
    const customer = this.customers.get(stripeCustomerId);
    if (!customer) {
      // Cross-process scenario: customer was created by another process (e.g. API server).
      // The mock here (e.g. in GM) has no local state for this customer, but the customer
      // DOES exist (stripeCustomerId is in the DB). Return a placeholder so isConfigured()
      // sees methods.length > 0 and includes Stripe in the provider chain. The actual
      // charge() will also succeed via the same cross-process logic. The DB
      // (customer_payment_methods) is the authoritative source for UI display.
      return [{ id: 'pm_mock_cross_process', brand: 'visa', last4: '0000', expMonth: 12, expYear: 2099, isDefault: true }];
    }

    return customer.paymentMethods.map(pm => ({
      id: pm.id,
      brand: pm.brand,
      last4: pm.last4,
      expMonth: pm.expMonth,
      expYear: pm.expYear,
      isDefault: pm.id === customer.defaultPaymentMethodId,
    }));
  }

  async deletePaymentMethod(paymentMethodId: string): Promise<void> {
    for (const customer of this.customers.values()) {
      const index = customer.paymentMethods.findIndex(pm => pm.id === paymentMethodId);
      if (index !== -1) {
        customer.paymentMethods.splice(index, 1);
        if (customer.defaultPaymentMethodId === paymentMethodId) {
          customer.defaultPaymentMethodId = customer.paymentMethods[0]?.id;
        }
        return;
      }
    }
  }

  async setDefaultPaymentMethod(stripeCustomerId: string, paymentMethodId: string): Promise<void> {
    const customer = this.customers.get(stripeCustomerId);
    if (customer) {
      customer.defaultPaymentMethodId = paymentMethodId;
    }
  }

  async voidInvoice(stripeInvoiceId: string): Promise<{ success: boolean; error?: string }> {
    // In mock mode, just acknowledge the void (no real Stripe invoice to cancel)
    console.log(`[MockStripe] voidInvoice: ${stripeInvoiceId}`);
    return { success: true };
  }

  async refund(params: StripeRefundParams): Promise<StripeRefundResult> {
    const refundId = `re_mock_${this.nextRefundIndex++}`;

    this.refunds.push({
      refundId,
      stripeInvoiceId: params.stripeInvoiceId,
      amountUsdCents: params.amountUsdCents,
      reason: params.reason,
      createdAt: new Date(),
    });

    return { success: true, refundId };
  }

  /** Get recorded refunds (for test verification) */
  getRefunds(): MockRefund[] {
    return [...this.refunds];
  }

  /** Get setupIntent info for test endpoint (maps setupIntentId → customer/paymentMethod) */
  getSetupIntentInfo(setupIntentId: string): { stripeCustomerId: string; paymentMethodId: string } | undefined {
    return this.setupIntents.get(setupIntentId);
  }

  isMock(): boolean {
    return true;
  }

  /** Reset all state (for tests) */
  reset(): void {
    this.customers.clear();
    this.paymentIntents.clear();
    this.idempotencyCache.clear();
    this.setupIntents.clear();
    this.refunds = [];
    this.nextCustomerIndex = 1;
    this.nextPaymentIntentIndex = 1;
    this.nextSetupIntentIndex = 1;
    this.nextPaymentMethodIndex = 1;
    this.nextRefundIndex = 1;
  }
}

// Singleton instance
export const mockStripeService = new MockStripeService();
