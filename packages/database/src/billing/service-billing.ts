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

import { eq, and, sql, inArray } from 'drizzle-orm';
import type { Database, DatabaseOrTransaction } from '../db';
import { serviceInstances, customers, billingRecords, invoiceLineItems } from '../schema';
import { withCustomerLock, type LockedTransaction } from './locking';
import { getOrCreateDraftInvoice, createAndChargeImmediately, updateDraftInvoiceAmount } from './invoices';
import { processInvoicePayment } from './payments';
import { issueCredit } from './credits';
import { validateInvoiceBeforeCharging } from './validation';
import { logValidationIssues } from './admin-notifications';
import type { DBClock } from '@suiftly/shared/db-clock';
import type { PaymentServices } from './providers';
import { getCustomerProviders } from './providers';
import { getTierPriceUsdCents, ADDON_PRICES_USD_CENTS } from '@suiftly/shared/pricing';
import {
  TIER_TO_SUBSCRIPTION_ITEM,
  INVOICE_LINE_ITEM_TYPE,
  type ServiceTier,
  type ServiceType,
  type InvoiceLineItemType,
} from '@suiftly/shared/constants';

/**
 * Result of service subscription billing
 */
export interface SubscriptionBillingResult {
  invoiceId: number;
  amountUsdCents: number;
  paymentSuccessful: boolean;
  /** Invoice ID if payment is still pending, null if paid */
  subPendingInvoiceId: number | null;
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
            eq(serviceInstances.serviceType, serviceType)
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
    subPendingInvoiceId: paymentResult.fullyPaid ? null : invoiceId,
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

  // Get current invoice amount to check if it changes
  const [currentInvoice] = await tx
    .select({ amountUsdCents: billingRecords.amountUsdCents })
    .from(billingRecords)
    .where(eq(billingRecords.id, draftId))
    .limit(1);
  const oldAmount = currentInvoice?.amountUsdCents ?? 0;

  // Subscription line item types to manage (not usage, not credits)
  const subscriptionTypes: InvoiceLineItemType[] = [
    INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_STARTER,
    INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_PRO,
    INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_ENTERPRISE,
    INVOICE_LINE_ITEM_TYPE.EXTRA_API_KEYS,
    INVOICE_LINE_ITEM_TYPE.EXTRA_SEAL_KEYS,
    INVOICE_LINE_ITEM_TYPE.EXTRA_PACKAGES,
  ];

  // Delete existing subscription/add-on line items (idempotent update)
  // Usage line items (itemType='requests') are managed by syncUsageToDraft
  await tx.delete(invoiceLineItems)
    .where(
      and(
        eq(invoiceLineItems.billingRecordId, draftId),
        inArray(invoiceLineItems.itemType, subscriptionTypes)
      )
    );

  // Get all subscribed services
  // NOTE: Service existence = subscription. is_user_enabled is just on/off toggle.
  // Customers are billed for subscribed services regardless of toggle state.
  const services = await tx
    .select()
    .from(serviceInstances)
    .where(eq(serviceInstances.customerId, customerId));

  // Insert subscription line items for each service
  for (const service of services) {
    // Skip services with scheduled cancellation - they won't be billed next month
    if (service.cancellationScheduledFor) {
      continue;
    }

    const serviceType = service.serviceType as ServiceType;
    // Use scheduled tier if present (for scheduled downgrades), otherwise current tier
    const effectiveTier = (service.scheduledTier || service.tier) as ServiceTier;
    const tierPriceCents = getTierPriceUsdCents(effectiveTier);
    const subscriptionItemType = TIER_TO_SUBSCRIPTION_ITEM[effectiveTier];

    // Insert subscription line item
    await tx.insert(invoiceLineItems).values({
      billingRecordId: draftId,
      itemType: subscriptionItemType,
      serviceType: serviceType,
      quantity: 1,
      unitPriceUsdCents: tierPriceCents,
      amountUsdCents: tierPriceCents,
    });

    // Add-on charges (Seal keys, packages, API keys)
    if (service.serviceType === 'seal' && service.config && typeof service.config === 'object') {
      const config = service.config as Record<string, unknown>;

      // Extra Seal keys
      const purchasedKeys = Number(config.purchasedSealKeys) || 0;
      if (purchasedKeys > 0) {
        await tx.insert(invoiceLineItems).values({
          billingRecordId: draftId,
          itemType: INVOICE_LINE_ITEM_TYPE.EXTRA_SEAL_KEYS,
          serviceType: serviceType,
          quantity: purchasedKeys,
          unitPriceUsdCents: ADDON_PRICES_USD_CENTS.sealKey,
          amountUsdCents: purchasedKeys * ADDON_PRICES_USD_CENTS.sealKey,
        });
      }

      // Extra packages
      const purchasedPackages = Number(config.purchasedPackages) || 0;
      if (purchasedPackages > 0) {
        await tx.insert(invoiceLineItems).values({
          billingRecordId: draftId,
          itemType: INVOICE_LINE_ITEM_TYPE.EXTRA_PACKAGES,
          serviceType: serviceType,
          quantity: purchasedPackages,
          unitPriceUsdCents: ADDON_PRICES_USD_CENTS.package,
          amountUsdCents: purchasedPackages * ADDON_PRICES_USD_CENTS.package,
        });
      }

      // Extra API keys
      const purchasedApiKeys = Number(config.purchasedApiKeys) || 0;
      if (purchasedApiKeys > 0) {
        await tx.insert(invoiceLineItems).values({
          billingRecordId: draftId,
          itemType: INVOICE_LINE_ITEM_TYPE.EXTRA_API_KEYS,
          serviceType: serviceType,
          quantity: purchasedApiKeys,
          unitPriceUsdCents: ADDON_PRICES_USD_CENTS.apiKey,
          amountUsdCents: purchasedApiKeys * ADDON_PRICES_USD_CENTS.apiKey,
        });
      }
    }
  }

  // Calculate total from ALL line items in the database
  // This is the source of truth: Total == Sum(Line Items)
  const totalResult = await tx.execute(sql`
    SELECT COALESCE(SUM(amount_usd_cents), 0) as total
    FROM invoice_line_items
    WHERE billing_record_id = ${draftId}
  `);
  const finalTotalCents = Number(totalResult.rows[0]?.total ?? 0);

  // Only update amount if it changed
  if (finalTotalCents !== oldAmount) {
    await updateDraftInvoiceAmount(tx, draftId, finalTotalCents);
  }

  // Always update lastUpdatedAt to indicate we checked (even if no changes)
  const now = clock.now();
  await tx.execute(sql`
    UPDATE billing_records
    SET last_updated_at = ${now}
    WHERE id = ${draftId}
  `);

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
