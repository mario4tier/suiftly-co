/**
 * DRAFT Invoice Management
 *
 * Recalculates the customer's DRAFT invoice (next billing cycle preview)
 * based on current service subscriptions and add-ons.
 *
 * Isolated in its own module to allow import from both:
 * - service-billing.ts (subscription flow)
 * - payments.ts (post-payment finalization)
 * without creating circular dependencies.
 */

import { eq, and, sql, inArray } from 'drizzle-orm';
import { serviceInstances, billingRecords, invoiceLineItems } from '../schema';
import type { LockedTransaction } from './locking';
import { getOrCreateDraftInvoice, updateDraftInvoiceAmount } from './invoices';
import { validateInvoiceBeforeCharging } from './validation';
import { logValidationIssues } from './admin-notifications';
import type { DBClock } from '@suiftly/shared/db-clock';
import { getTierPriceUsdCents, ADDON_PRICES_USD_CENTS } from '@suiftly/shared/pricing';
import {
  TIER_TO_SUBSCRIPTION_ITEM,
  INVOICE_LINE_ITEM_TYPE,
  type ServiceTier,
  type ServiceType,
  type InvoiceLineItemType,
} from '@suiftly/shared/constants';

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
    // Skip services that are being cancelled:
    // - cancellationScheduledFor set: scheduled but not yet processed (during the month)
    // - state = 'cancellation_pending': already processed by processScheduledCancellations
    //   on the 1st (which clears cancellationScheduledFor but sets state)
    if (service.cancellationScheduledFor || service.state === 'cancellation_pending') {
      continue;
    }

    const serviceType = service.serviceType as ServiceType;
    // Use scheduled tier if present (for scheduled downgrades), otherwise current tier
    const effectiveTier = (service.scheduledTier || service.tier) as ServiceTier;
    const tierPriceCents = getTierPriceUsdCents(effectiveTier, serviceType);
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
export function getDaysInMonth(year: number, month: number): number {
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
