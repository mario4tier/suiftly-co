/**
 * Payment Gate Helpers
 *
 * Shared logic for retrying pending invoice payments when enabling
 * services or creating seal keys. Extracted from services.ts and seal.ts
 * to prevent divergence.
 */

import { TRPCError } from '@trpc/server';
import { serviceInstances, customers } from '@suiftly/database/schema';
import { eq } from 'drizzle-orm';
import { getSuiService } from '@suiftly/database/sui-mock';
import { getStripeService } from '@suiftly/database/stripe-mock';
import { getCustomerProviders, processInvoicePayment } from '@suiftly/database/billing';
import type { LockedTransaction } from '@suiftly/database/billing';
import { dbClock } from '@suiftly/shared/db-clock';

/**
 * Retry a pending invoice payment via the provider chain.
 *
 * On success: clears subPendingInvoiceId, sets paidOnce on both service and customer.
 * On failure: throws TRPCError with PRECONDITION_FAILED.
 *
 * Call this within a withCustomerLockForAPI callback.
 */
export async function retryPendingInvoice(
  tx: LockedTransaction,
  customerId: number,
  service: { instanceId: number; subPendingInvoiceId: number },
): Promise<void> {
  const paymentServices = { suiService: getSuiService(), stripeService: getStripeService() };
  const providers = await getCustomerProviders(customerId, paymentServices, tx, dbClock);

  if (providers.length === 0) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'No payment method configured. Add a payment method via Billing page.',
    });
  }

  const result = await processInvoicePayment(tx, service.subPendingInvoiceId, providers, dbClock);

  if (!result.fullyPaid) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Payment failed. Check your payment methods via Billing page.',
    });
  }

  // Payment succeeded — clear the pending invoice gate and mark paidOnce.
  // paidOnce is critical: it controls whether tier changes are scheduled (true)
  // or applied immediately (false). See tier-changes.ts.
  await tx.update(serviceInstances)
    .set({ subPendingInvoiceId: null, paidOnce: true })
    .where(eq(serviceInstances.instanceId, service.instanceId));

  await tx.update(customers)
    .set({ paidOnce: true })
    .where(eq(customers.customerId, customerId));
}
