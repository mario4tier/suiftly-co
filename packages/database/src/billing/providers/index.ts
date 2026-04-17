/**
 * Payment Provider Resolution
 *
 * Reads customer_payment_methods table to build the provider chain
 * in the customer's preferred priority order.
 *
 * IMPORTANT: Call getCustomerProviders() within the customer lock transaction
 * to prevent race conditions with concurrent reordering.
 */

import { eq, and, asc, ne } from 'drizzle-orm';
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
 * Get a customer's payment providers.
 *
 * Escrow is always tried first and is NOT driven by `customer_payment_methods`
 * — it is implicit to being a Suiftly customer. The provider's `canPay()`
 * checks the on-chain balance, so it's naturally skipped when there are no
 * funds. The registry only stores user-added, per-card payment methods
 * (Stripe / PayPal): those rows hold real state (provider_ref, cached card
 * details) that can't be derived elsewhere.
 *
 * This removes the "stuck in Subscription payment pending" failure mode that
 * happened whenever a charge ran before the escrow registry row had been
 * inserted (previously the registration was a separate UI click / hook).
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
        // Skip escrow rows — escrow is implicit (see above).
        ne(customerPaymentMethods.providerType, 'escrow'),
      ),
    )
    .orderBy(asc(customerPaymentMethods.priority));

  const escrowProvider = createProvider('escrow', services, db, clock);
  const registryProviders = methods.map(m =>
    createProvider(m.providerType as PaymentProviderType, services, db, clock),
  );

  return [escrowProvider, ...registryProviders];
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
