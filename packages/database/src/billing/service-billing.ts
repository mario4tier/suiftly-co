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

import { eq, and } from 'drizzle-orm';
import type { Database, DatabaseOrTransaction } from '../db';
import { serviceInstances, customers } from '../schema';
import { withCustomerLock, type LockedTransaction } from './locking';
import { getOrCreateDraftInvoice, createAndChargeImmediately, updateDraftInvoiceAmount } from './invoices';
import { processInvoicePayment } from './payments';
import { issueCredit } from './credits';
import { validateInvoiceBeforeCharging } from './validation';
import { logValidationIssues } from './admin-notifications';
import type { DBClock } from '@suiftly/shared/db-clock';
import type { ISuiService } from '@suiftly/shared/sui-service';
import { getTierPriceUsdCents, ADDON_PRICES_USD_CENTS } from '@suiftly/shared/pricing';

/**
 * Result of service subscription billing
 */
export interface SubscriptionBillingResult {
  invoiceId: string;
  amountUsdCents: number;
  paymentSuccessful: boolean;
  subscriptionChargePending: boolean;
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
 * @param suiService Sui service for payment
 * @param clock DBClock for timestamps
 * @returns Subscription billing result
 */
export async function handleSubscriptionBilling(
  db: Database,
  customerId: number,
  serviceType: string,
  tier: string,
  monthlyPriceUsdCents: number,
  suiService: ISuiService,
  clock: DBClock
): Promise<SubscriptionBillingResult> {
  return await withCustomerLock(db, customerId, async (tx) => {
    return await handleSubscriptionBillingLocked(
      tx,
      customerId,
      serviceType,
      tier,
      monthlyPriceUsdCents,
      suiService,
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
 * @param suiService Sui service for payment
 * @param clock DBClock for timestamps
 * @returns Subscription billing result
 */
export async function handleSubscriptionBillingLocked(
  tx: LockedTransaction,
  customerId: number,
  serviceType: string,
  tier: string,
  monthlyPriceUsdCents: number,
  suiService: ISuiService,
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
      },
      clock
    );

    // Attempt payment
    const paymentResult = await processInvoicePayment(
      tx,
      invoiceId,
      suiService,
      clock
    );

    // If payment succeeded, mark both service and customer as having paid at least once
    // and issue reconciliation credit (all in same transaction)
    if (paymentResult.fullyPaid) {
      // Service-level paidOnce: Unlocks key operations (generate/import) and changes tier change behavior
      await tx
        .update(serviceInstances)
        .set({ paidOnce: true })
        .where(
          and(
            eq(serviceInstances.customerId, customerId),
            eq(serviceInstances.serviceType, serviceType as any)
          )
        );

      // Customer-level paidOnce: Enables grace period eligibility on future payment failures
      await tx
        .update(customers)
        .set({ paidOnce: true })
        .where(eq(customers.customerId, customerId));

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

    // Get or create DRAFT for next billing cycle
    // This shows the customer what they'll be charged on the 1st of next month
    const draftId = await getOrCreateDraftInvoice(tx, customerId, clock);

    // Update DRAFT to include this subscription
    await recalculateDraftInvoice(tx, customerId, clock);

  return {
    invoiceId,
    amountUsdCents: monthlyPriceUsdCents,
    paymentSuccessful: paymentResult.fullyPaid,
    subscriptionChargePending: !paymentResult.fullyPaid,
    error: paymentResult.error?.message,
  };
}

/**
 * Recalculate DRAFT invoice total based on enabled services
 *
 * **IDEMPOTENT** - Safe to call anytime service configuration changes.
 * This is the single function to update/create the DRAFT invoice for a customer.
 *
 * Design principle: "Something changed that might affect billing" → call this function.
 *
 * What it does:
 * 1. Gets existing DRAFT or creates new one (idempotent)
 * 2. Calculates total from enabled services + add-ons
 * 3. Updates DRAFT amount
 * 4. Validates DRAFT (catches bugs like stale amounts, duplicates)
 * 5. Logs validation errors to admin_notifications
 *
 * Call from:
 * - Service subscribe/unsubscribe
 * - Tier change
 * - Add-on purchase/removal
 * - Service enable/disable toggle
 * - Periodically if needed (defensive refresh)
 *
 * @param tx Transaction handle (must have customer lock)
 * @param customerId Customer ID
 * @param clock DBClock for timestamps
 * @throws Error if DRAFT validation fails (critical billing error)
 */
export async function recalculateDraftInvoice(
  tx: LockedTransaction,
  customerId: number,
  clock: DBClock
): Promise<void> {
  // Get DRAFT invoice (create if doesn't exist)
  const draftId = await getOrCreateDraftInvoice(tx, customerId, clock);

  // Get all subscribed services
  // NOTE: Service existence = subscription. is_user_enabled is just on/off toggle.
  // Customers are billed for subscribed services regardless of toggle state.
  const services = await tx
    .select()
    .from(serviceInstances)
    .where(eq(serviceInstances.customerId, customerId));

  // Calculate total from tier prices + add-ons
  let totalUsdCents = 0;

  for (const service of services) {
    // Get tier price from centralized config
    const tierPriceCents = getTierPriceUsdCents(service.tier);
    totalUsdCents += tierPriceCents;

    // Add-on charges (Seal keys, packages, API keys)
    if (service.serviceType === 'seal' && service.config) {
      const config = service.config as any;

      // Extra Seal keys
      const purchasedKeys = config.purchasedSealKeys || 0;
      if (purchasedKeys > 0) {
        totalUsdCents += purchasedKeys * ADDON_PRICES_USD_CENTS.sealKey;
      }

      // Extra packages
      const purchasedPackages = config.purchasedPackages || 0;
      if (purchasedPackages > 0) {
        totalUsdCents += purchasedPackages * ADDON_PRICES_USD_CENTS.package;
      }

      // Extra API keys
      const purchasedApiKeys = config.purchasedApiKeys || 0;
      if (purchasedApiKeys > 0) {
        totalUsdCents += purchasedApiKeys * ADDON_PRICES_USD_CENTS.apiKey;
      }
    }
  }

  // Update DRAFT invoice amount
  await updateDraftInvoiceAmount(tx, draftId, totalUsdCents);

  // CRITICAL: Validate DRAFT after update to catch calculation bugs
  const validation = await validateInvoiceBeforeCharging(tx, draftId);

  if (!validation.valid || validation.warnings.length > 0) {
    // Log validation issues to admin_notifications table
    await logValidationIssues(tx, draftId, [...validation.criticalErrors, ...validation.warnings], customerId);

    // Throw on critical errors
    if (!validation.valid) {
      throw new Error(`DRAFT invoice validation failed: ${validation.criticalErrors.map(e => e.code).join(', ')}`);
    }
  }
}

/**
 * Get number of days in a month (UTC-based)
 *
 * Per TIME_DESIGN.md: All date calculations use UTC to avoid timezone bugs.
 *
 * @param year Full year (e.g., 2025)
 * @param month Month (1-12, NOT 0-indexed)
 * @returns Number of days
 */
function getDaysInMonth(year: number, month: number): number {
  // Create UTC date for 0th day of next month = last day of current month
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Calculate pro-rated charge for tier upgrade
 *
 * Per BILLING_DESIGN.md R4:
 * charge = (new_tier − old_tier) × (days_remaining / days_in_month)
 * If days_remaining ≤ 2: charge = $0 (grace period)
 *
 * @param oldTierPriceCents Old tier monthly price
 * @param newTierPriceCents New tier monthly price
 * @param clock DBClock for current date
 * @returns Pro-rated charge in cents
 */
export function calculateProRatedUpgradeCharge(
  oldTierPriceCents: number,
  newTierPriceCents: number,
  clock: DBClock
): number {
  const today = clock.today();
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1; // 1-indexed
  const daysInMonth = getDaysInMonth(year, month);
  const dayOfMonth = today.getUTCDate();

  // Days remaining = from today to end of month (inclusive)
  const daysRemaining = daysInMonth - dayOfMonth + 1;

  // Grace period: if ≤ 2 days remaining, no charge
  if (daysRemaining <= 2) {
    return 0;
  }

  // Pro-rated charge
  const priceDifference = newTierPriceCents - oldTierPriceCents;
  const proRatedCharge = Math.floor((priceDifference * daysRemaining) / daysInMonth);

  return Math.max(0, proRatedCharge);
}
