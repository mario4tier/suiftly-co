/**
 * Invoice Line Item Formatting
 *
 * Shared logic for building invoice line items.
 * Used for INVOICES only (not deposits/withdrawals in billing history).
 *
 * Contexts:
 * - DRAFT invoices → "Next Scheduled Payment" section
 * - Historical invoices → Expandable invoice details in "Billing History"
 *
 * Note: Billing history also contains non-invoice transactions (deposits, withdrawals)
 * which use simple description + amount format, not line items.
 */

import { db } from '@suiftly/database';
import { getTierPriceUsdCents } from '@suiftly/shared/pricing';
import { INVOICE_LINE_ITEM_TYPE, TIER_TO_SUBSCRIPTION_ITEM } from '@suiftly/shared/constants';
import type { ServiceType, ServiceTier, InvoiceLineItemType } from '@suiftly/shared/constants';
import type { InvoiceLineItem } from '@suiftly/shared/types';
import { customerCredits, serviceInstances, invoiceLineItems } from '@suiftly/database/schema';
import { eq, and, sql, gt, isNull } from 'drizzle-orm';
import { dbClock } from '@suiftly/shared/db-clock';

// Re-export the type for convenience
export type { InvoiceLineItem } from '@suiftly/shared/types';

/**
 * Build line items for a DRAFT invoice
 *
 * Reads cached line items from invoice_line_items table (synced periodically)
 * and adds subscription charges based on current service configuration.
 *
 * Line items include:
 * - Service subscriptions (computed from service tier)
 * - Usage charges (read from cached invoice_line_items)
 * - Add-ons (future: "Seal - 2 extra keys")
 * - Available credits (will be applied when DRAFT → PENDING)
 *
 * IMPORTANT: Excludes services with subscriptionChargePending=true because:
 * - Initial charge hasn't been paid yet
 * - Service hasn't been activated/provisioned
 * - Proration credit calculation would be unclear
 * - It's confusing to show next month's charges when current month isn't settled
 *
 * @param customerId Customer ID
 * @param draftAmountCents DRAFT invoice gross amount
 * @param billingPeriodStart Invoice due date (1st of next month) - used to calculate credit month
 * @param draftInvoiceId DRAFT invoice ID to read cached line items from
 * @returns Array of line items
 */
export async function buildDraftLineItems(
  customerId: number,
  draftAmountCents: number,
  billingPeriodStart?: Date,
  draftInvoiceId?: string
): Promise<InvoiceLineItem[]> {
  const lineItems: InvoiceLineItem[] = [];
  const now = dbClock.now();

  // Get subscribed services (exclude services with pending initial charge or scheduled cancellation)
  const services = await db.query.serviceInstances.findMany({
    where: and(
      eq(serviceInstances.customerId, customerId),
      eq(serviceInstances.subscriptionChargePending, false),
      isNull(serviceInstances.cancellationScheduledFor)
    ),
  });

  // Add subscription line item for each service
  for (const service of services) {
    // Use scheduled tier if present (for scheduled downgrades), otherwise current tier
    // This ensures DRAFT invoice line items reflect what will ACTUALLY be charged
    const effectiveTier = (service.scheduledTier || service.tier) as ServiceTier;
    const tierPriceCents = getTierPriceUsdCents(effectiveTier);
    const tierPriceUsd = tierPriceCents / 100;

    lineItems.push({
      service: service.serviceType as ServiceType,
      itemType: TIER_TO_SUBSCRIPTION_ITEM[effectiveTier],
      quantity: 1,
      unitPriceUsd: tierPriceUsd,
      amountUsd: tierPriceUsd,
    });

    // Future: Add-ons would be additional line items here
    // e.g., extra_api_keys, extra_seal_keys, etc.
  }

  // Read usage charges from cached invoice_line_items table
  // These are synced periodically by syncUsageToDraft()
  if (draftInvoiceId) {
    const cachedLineItems = await db.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.billingRecordId, draftInvoiceId),
    });

    for (const item of cachedLineItems) {
      // Convert stored cents to USD for frontend
      // unitPriceUsdCents is stored as cents per 1000 requests
      const unitPriceUsd = Number(item.unitPriceUsdCents) / 100 / 1000;
      const amountUsd = Number(item.amountUsdCents) / 100;

      lineItems.push({
        service: item.serviceType as ServiceType | null,
        itemType: item.itemType as InvoiceLineItemType,
        quantity: Number(item.quantity),
        unitPriceUsd,
        amountUsd,
        creditMonth: item.creditMonth || undefined,
      });
    }
  }

  // Get available credits
  // Only show credits if there are active services in the DRAFT
  // (If all services have pending subscription charges, don't show credits)
  if (services.length > 0) {
    const credits = await db
      .select({ total: sql<number>`COALESCE(SUM(${customerCredits.remainingAmountUsdCents}), 0)` })
      .from(customerCredits)
      .where(
        and(
          eq(customerCredits.customerId, customerId),
          gt(customerCredits.remainingAmountUsdCents, 0),
          sql`(${customerCredits.expiresAt} IS NULL OR ${customerCredits.expiresAt} > ${now})`
        )
      );

    const creditsCents = Number(credits[0]?.total ?? 0);

    if (creditsCents > 0) {
      // For multiple services, use null for service (rare case)
      const creditService = services.length === 1
        ? services[0].serviceType as ServiceType
        : null;

      // Credit is for the month BEFORE the DRAFT invoice due date
      // Example: December 1st DRAFT invoice → credit is for November partial month
      let creditMonthDate: Date;
      if (billingPeriodStart) {
        // Use invoice due date minus 1 month
        creditMonthDate = new Date(billingPeriodStart);
        creditMonthDate.setUTCMonth(creditMonthDate.getUTCMonth() - 1);
      } else {
        // Fallback to current month if billing period not provided
        creditMonthDate = now;
      }

      const creditMonthName = creditMonthDate.toLocaleDateString('en-US', {
        month: 'long',
        timeZone: 'UTC'
      });

      const creditAmountUsd = creditsCents / 100;

      lineItems.push({
        service: creditService,
        itemType: INVOICE_LINE_ITEM_TYPE.CREDIT,
        quantity: 1,
        unitPriceUsd: creditAmountUsd,
        amountUsd: -creditAmountUsd, // Negative for credits
        creditMonth: creditMonthName,
      });
    }
  }

  return lineItems;
}

/**
 * Get tier price in cents
 * TODO: Import from config cache instead of hardcoding
 */
