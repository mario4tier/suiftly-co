/**
 * Payment Gate Helpers
 *
 * Shared logic for retrying pending invoice payments when enabling
 * services or creating seal keys. Extracted from services.ts and seal.ts
 * to prevent divergence.
 */

import { TRPCError } from '@trpc/server';
import { billingRecords, serviceInstances } from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import { SERVICE_TYPE, SERVICE_STATE } from '@suiftly/shared/constants';
import { requiresPlatformSub } from './config-cache';
import { getSuiService } from '@suiftly/database/sui-mock';
import { getStripeService } from '@suiftly/database/stripe-mock';
import { getCustomerProviders, processInvoicePayment, finalizeSuccessfulPayment } from '@suiftly/database/billing';
import type { LockedTransaction } from '@suiftly/database/billing';
import { dbClock } from '@suiftly/shared/db-clock';

/**
 * Retry a pending invoice payment via credits + provider chain.
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

  // Always attempt payment — credits are applied first inside processInvoicePayment.
  // A customer with sufficient credits but no payment method can still pay.
  const result = await processInvoicePayment(tx, service.subPendingInvoiceId, providers, dbClock);

  if (!result.fullyPaid) {
    // Fetch paymentActionUrl if it was set (3DS requires_action)
    let paymentActionUrl: string | undefined;
    const [record] = await tx
      .select({ paymentActionUrl: billingRecords.paymentActionUrl })
      .from(billingRecords)
      .where(eq(billingRecords.id, service.subPendingInvoiceId))
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

  // Payment succeeded — clear pending state, set paidOnce, clear grace period,
  // issue reconciliation credit, and recalculate DRAFT via shared finalization.
  await finalizeSuccessfulPayment(tx, customerId, service.subPendingInvoiceId, dbClock);
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
  if (!requiresPlatformSub()) return;

  const platformSvc = await tx.query.serviceInstances.findFirst({
    where: and(
      eq(serviceInstances.customerId, customerId),
      eq(serviceInstances.serviceType, SERVICE_TYPE.PLATFORM)
    ),
  });

  if (!platformSvc || platformSvc.subPendingInvoiceId !== null) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Platform subscription required. Subscribe to a platform plan first.',
    });
  }

  if (opts.requireEnabled && platformSvc.state !== SERVICE_STATE.ENABLED) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Active platform subscription required to enable services',
    });
  }
}
