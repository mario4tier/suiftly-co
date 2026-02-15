/**
 * Payment Provider Resolution
 *
 * Reads customer_payment_methods table to build the provider chain
 * in the customer's preferred priority order.
 *
 * IMPORTANT: Call getCustomerProviders() within the customer lock transaction
 * to prevent race conditions with concurrent reordering.
 */

import { eq, and, asc } from 'drizzle-orm';
import type { IPaymentProvider, PaymentProviderType } from '@suiftly/shared/payment-provider';
import type { ISuiService } from '@suiftly/shared/sui-service';
import type { IStripeService } from '@suiftly/shared/stripe-service';
import type { DatabaseOrTransaction } from '../../db';
import type { DBClock } from '@suiftly/shared/db-clock';
import { customerPaymentMethods } from '../../schema';
import { EscrowPaymentProvider } from './escrow-provider';
import { StripePaymentProvider } from './stripe-provider';
import { PayPalPaymentProvider } from './paypal-provider';

/** Services needed to construct payment providers */
export interface PaymentServices {
  suiService: ISuiService;
  stripeService: IStripeService;
}

/**
 * Get a customer's payment providers in their preferred order.
 *
 * Reads customer_payment_methods table ordered by priority,
 * instantiates the corresponding provider for each active method.
 */
export async function getCustomerProviders(
  customerId: number,
  services: PaymentServices,
  db: DatabaseOrTransaction,
  clock: DBClock,
): Promise<IPaymentProvider[]> {
  const methods = await db
    .select()
    .from(customerPaymentMethods)
    .where(
      and(
        eq(customerPaymentMethods.customerId, customerId),
        eq(customerPaymentMethods.status, 'active'),
      ),
    )
    .orderBy(asc(customerPaymentMethods.priority));

  return methods.map(m =>
    createProvider(m.providerType as PaymentProviderType, services, db, clock),
  );
}

function createProvider(
  type: PaymentProviderType,
  services: PaymentServices,
  db: DatabaseOrTransaction,
  clock: DBClock,
): IPaymentProvider {
  switch (type) {
    case 'escrow':
      return new EscrowPaymentProvider(services.suiService, db, clock);
    case 'stripe':
      return new StripePaymentProvider(services.stripeService, db);
    case 'paypal':
      return new PayPalPaymentProvider();
  }
}

// Re-export providers and types
export { EscrowPaymentProvider } from './escrow-provider';
export { StripePaymentProvider } from './stripe-provider';
export { PayPalPaymentProvider } from './paypal-provider';
export type { PaymentProviderType, IPaymentProvider } from '@suiftly/shared/payment-provider';
