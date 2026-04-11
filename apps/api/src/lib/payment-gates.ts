/**
 * Payment Gate Helpers
 *
 * Shared logic for retrying pending invoice payments when enabling
 * services or creating seal keys. Extracted from services.ts and seal.ts
 * to prevent divergence.
 */

import { TRPCError } from '@trpc/server';
import { billingRecords, customers } from '@suiftly/database/schema';
import { eq } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '@suiftly/database';

import { getSuiService } from '@suiftly/database/sui-mock';
import { getStripeService } from '@suiftly/database/stripe-mock';
import { getCustomerProviders, processInvoicePayment, finalizeSuccessfulPayment } from '@suiftly/database/billing';
import type { LockedTransaction } from '@suiftly/database/billing';
import { dbClock } from '@suiftly/shared/db-clock';

/**
 * Retry a pending invoice payment via credits + provider chain.
 *
 * On success: clears pendingInvoiceId on customer, sets paidOnce.
 * On failure: throws TRPCError with PRECONDITION_FAILED.
 *
 * Call this within a withCustomerLockForAPI callback.
 */
export async function retryPendingInvoice(
  tx: LockedTransaction,
  customerId: number,
  pendingInvoiceId: number,
): Promise<void> {
  const paymentServices = { suiService: getSuiService(), stripeService: getStripeService() };
  const providers = await getCustomerProviders(customerId, paymentServices, tx, dbClock);

  const result = await processInvoicePayment(tx, pendingInvoiceId, providers, dbClock);

  if (!result.fullyPaid) {
    let paymentActionUrl: string | undefined;
    const [record] = await tx
      .select({ paymentActionUrl: billingRecords.paymentActionUrl })
      .from(billingRecords)
      .where(eq(billingRecords.id, pendingInvoiceId))
      .limit(1);
    paymentActionUrl = record?.paymentActionUrl ?? undefined;

    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: paymentActionUrl
        ? 'Payment requires authentication. Complete 3D Secure verification to continue.'
        : providers.length === 0
          ? 'Insufficient credits and no payment method configured. Add funds or a payment method via Billing page.'
          : 'Payment failed. Check your payment methods via Billing page.',
      cause: {
        errorCode: result.error?.errorCode,
        paymentActionUrl,
      },
    });
  }

  await finalizeSuccessfulPayment(tx, customerId, pendingInvoiceId, dbClock);
}

/**
 * Assert that the customer has an active platform subscription.
 * No-op if platform subscription is not required (feature flag off).
 *
 * @param requireEnabled If true, also requires platform state to be ENABLED
 *   (use for service enable; subscribe only needs paid subscription)
 */
export async function assertPlatformSubscription(
  tx: LockedTransaction,
  customerId: number,
  opts: { requireEnabled?: boolean } = {},
): Promise<void> {
  // Platform subscription is always required — check customers table
  const [customer] = await tx
    .select({
      platformTier: customers.platformTier,
      pendingInvoiceId: customers.pendingInvoiceId,
      status: customers.status,
    })
    .from(customers)
    .where(eq(customers.customerId, customerId))
    .limit(1);

  if (!customer || customer.platformTier === null || customer.pendingInvoiceId !== null) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Platform subscription required. Subscribe to a platform plan first.',
    });
  }

  if (opts.requireEnabled && customer.status !== 'active') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Active platform subscription required to enable services',
    });
  }
}

/**
 * Get the customer's effective tier from their platform subscription.
 * Returns 'starter' if no platform tier is set.
 */
export async function getCustomerPlatformTier(
  dbInstance: DatabaseOrTransaction,
  customerId: number
): Promise<'starter' | 'pro'> {
  const result = await dbInstance
    .select({ platformTier: customers.platformTier })
    .from(customers)
    .where(eq(customers.customerId, customerId))
    .limit(1);
  return (result[0]?.platformTier as 'starter' | 'pro') ?? 'starter';
}
