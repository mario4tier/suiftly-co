/**
 * Service Billing Integration (Phase 2)
 *
 * Connects service lifecycle events with billing engine:
 * - Subscribe → Create DRAFT invoice + attempt first payment
 * - Tier change → Pro-rated charge or reconciliation credit
 * - Add-ons → Prepay + reconcile model
 * - Service config changes → Update DRAFT invoice
 *
 * See BILLING_DESIGN.md for detailed requirements.
 */

import { eq } from 'drizzle-orm';
import type { Database } from '../db';
import { customers } from '../schema';
import { withCustomerLock, type LockedTransaction } from './locking';
import { createAndChargeImmediately } from './invoices';
import { processInvoicePayment } from './payments';
import { issueCredit } from './credits';
import { clearGracePeriod } from './grace-period';
import { recalculateDraftInvoice, getDaysInMonth } from './draft-invoice';
import type { DBClock } from '@suiftly/shared/db-clock';
import type { PaymentServices } from './providers';
import { getCustomerProviders } from './providers';
import {
  TIER_TO_SUBSCRIPTION_ITEM,
  type ServiceTier,
  type ServiceType,
} from '@suiftly/shared/constants';

/**
 * Result of service subscription billing
 */
export interface SubscriptionBillingResult {
  invoiceId: number;
  amountUsdCents: number;
  paymentSuccessful: boolean;
  /** Invoice ID if payment is still pending, null if paid */
  pendingInvoiceId: number | null;
  error?: string;
}

/**
 * Handle billing for new service subscription (PUBLIC ENTRY POINT)
 *
 * Creates DRAFT invoice if it doesn't exist, adds subscription to it,
 * and attempts immediate payment for the first month.
 *
 * Per BILLING_DESIGN.md:
 * - First month: Charge full rate immediately
 * - Next 1st of month: Credit for partial month + charge full month
 *
 * @param db Database instance
 * @param customerId Customer ID
 * @param serviceType Service type
 * @param tier Service tier
 * @param monthlyPriceUsdCents Monthly subscription price in cents
 * @param services Payment services (Sui, Stripe, etc.)
 * @param clock DBClock for timestamps
 * @returns Subscription billing result
 */
export async function handleSubscriptionBilling(
  db: Database,
  customerId: number,
  serviceType: ServiceType,
  tier: string,
  monthlyPriceUsdCents: number,
  services: PaymentServices,
  clock: DBClock
): Promise<SubscriptionBillingResult> {
  return await withCustomerLock(db, customerId, async (tx) => {
    return await handleSubscriptionBillingLocked(
      tx,
      customerId,
      serviceType,
      tier,
      monthlyPriceUsdCents,
      services,
      clock
    );
  });
}

/**
 * Handle billing for new service subscription (INTERNAL - REQUIRES LOCK)
 *
 * Use this when you already hold the customer lock via withCustomerLock().
 * For standalone calls, use handleSubscriptionBilling() instead.
 *
 * @param tx Locked transaction handle
 * @param customerId Customer ID
 * @param serviceType Service type
 * @param tier Service tier
 * @param monthlyPriceUsdCents Monthly subscription price in cents
 * @param services Payment services (Sui, Stripe, etc.)
 * @param clock DBClock for timestamps
 * @returns Subscription billing result
 */
export async function handleSubscriptionBillingLocked(
  tx: LockedTransaction,
  customerId: number,
  serviceType: ServiceType,
  tier: string,
  monthlyPriceUsdCents: number,
  services: PaymentServices,
  clock: DBClock
): Promise<SubscriptionBillingResult> {
    // Create immediate invoice for first month (full rate)
    const invoiceId = await createAndChargeImmediately(
      tx,
      {
        customerId,
        amountUsdCents: monthlyPriceUsdCents,
        type: 'charge',
        status: 'pending',
        description: `${serviceType} ${tier} tier - first month`,
        billingPeriodStart: clock.now(),
        billingPeriodEnd: clock.addDays(30),
        dueDate: clock.now(),
        lineItem: {
          itemType: TIER_TO_SUBSCRIPTION_ITEM[tier as ServiceTier],
          serviceType,
          quantity: 1,
          unitPriceUsdCents: monthlyPriceUsdCents,
          amountUsdCents: monthlyPriceUsdCents,
        },
      },
      clock
    );

    // Build provider chain and attempt payment
    const providers = await getCustomerProviders(customerId, services, tx, clock);
    const paymentResult = await processInvoicePayment(
      tx,
      invoiceId,
      providers,
      clock
    );

    // If payment succeeded, mark customer as having paid at least once
    // and issue reconciliation credit (all in same transaction)
    if (paymentResult.fullyPaid) {
      // Customer-level paidOnce: Enables grace period eligibility on future payment failures
      // and unlocks key operations (generate/import) and changes tier change behavior
      await tx
        .update(customers)
        .set({ paidOnce: true })
        .where(eq(customers.customerId, customerId));

      // Clear any active grace period from a previous service's failed payment.
      // Without this, subscribing to a new service (with successful payment) would
      // leave a stale grace period active until the old invoice is retried.
      await clearGracePeriod(tx, customerId);

      // Calculate reconciliation credit for partial month (applied on next 1st)
      // Per BILLING_DESIGN.md: credit = amount_paid × (days_not_used / days_in_month)
      // Where: days_used = from purchase date to end of month, inclusive
      // IMPORTANT: Only issue credit when payment succeeds - if user changes tier
      // before paying, they shouldn't get credit based on the original tier price
      const today = clock.today();
      const daysInMonth = getDaysInMonth(today.getUTCFullYear(), today.getUTCMonth() + 1);
      const dayOfMonth = today.getUTCDate();

      // Days used = from today (inclusive) to end of month
      const daysUsed = daysInMonth - dayOfMonth + 1; // +1 because today is included
      const daysNotUsed = daysInMonth - daysUsed;

      const reconciliationCreditCents = Math.floor(
        (monthlyPriceUsdCents * daysNotUsed) / daysInMonth
      );

      // Issue reconciliation credit (never expires)
      if (reconciliationCreditCents > 0) {
        await issueCredit(
          tx,
          customerId,
          reconciliationCreditCents,
          'reconciliation',
          `Partial month credit for ${serviceType} (${daysNotUsed}/${daysInMonth} days unused)`,
          null // Never expires
        );
      }
    }

    // Update DRAFT to include this subscription
    await recalculateDraftInvoice(tx, customerId, clock);

  return {
    invoiceId,
    amountUsdCents: monthlyPriceUsdCents,
    paymentSuccessful: paymentResult.fullyPaid,
    pendingInvoiceId: paymentResult.fullyPaid ? null : invoiceId,
    error: paymentResult.error?.message,
  };
}

// Re-export from draft-invoice.ts for backwards compatibility
export { recalculateDraftInvoice, calculateProRatedUpgradeCharge } from './draft-invoice';
