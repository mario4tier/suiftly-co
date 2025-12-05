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
import { INVOICE_LINE_ITEM_TYPE } from '@suiftly/shared/constants';
import type { ServiceType, InvoiceLineItemType } from '@suiftly/shared/constants';
import type { InvoiceLineItem } from '@suiftly/shared/types';
import { customerCredits, serviceInstances, invoiceLineItems } from '@suiftly/database/schema';
import { eq, and, sql, gt, isNull } from 'drizzle-orm';
import { dbClock } from '@suiftly/shared/db-clock';

// Re-export the type for convenience
export type { InvoiceLineItem } from '@suiftly/shared/types';

// Item types that store unitPriceUsdCents as "cents per 1000 requests"
const USAGE_BASED_ITEM_TYPES = new Set([
  INVOICE_LINE_ITEM_TYPE.REQUESTS,
]);

/**
 * Build line items for a DRAFT invoice
 *
 * Reads all line items from invoice_line_items table (subscriptions, usage, add-ons)
 * and adds available credits.
 *
 * Line items include:
 * - Service subscriptions (from invoice_line_items, synced by recalculateDraftInvoice)
 * - Usage charges (from invoice_line_items, synced by syncUsageToDraft)
 * - Add-ons (from invoice_line_items, synced by recalculateDraftInvoice)
 * - Available credits (computed from customer_credits table)
 *
 * @param customerId Customer ID
 * @param draftAmountCents DRAFT invoice gross amount (unused, kept for backward compatibility)
 * @param billingPeriodStart Invoice due date (1st of next month) - used to calculate credit month
 * @param draftInvoiceId DRAFT invoice ID to read line items from
 * @returns Array of line items
 */
export async function buildDraftLineItems(
  customerId: number,
  draftAmountCents: number,
  billingPeriodStart?: Date,
  draftInvoiceId?: number
): Promise<InvoiceLineItem[]> {
  const lineItems: InvoiceLineItem[] = [];
  const now = dbClock.now();

  // Read ALL line items from database (subscriptions, usage, add-ons)
  // These are synced by recalculateDraftInvoice (subscriptions/add-ons) and syncUsageToDraft (usage)
  if (draftInvoiceId) {
    const cachedLineItems = await db.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.billingRecordId, draftInvoiceId),
    });

    for (const item of cachedLineItems) {
      const amountUsd = Number(item.amountUsdCents) / 100;

      // Unit price conversion depends on item type:
      // - Usage (requests): unitPriceUsdCents is "cents per 1000 requests" → divide by 100 and 1000
      // - Everything else: unitPriceUsdCents is actual price in cents → divide by 100
      let unitPriceUsd: number;
      if (USAGE_BASED_ITEM_TYPES.has(item.itemType as any)) {
        unitPriceUsd = Number(item.unitPriceUsdCents) / 100 / 1000;
      } else {
        unitPriceUsd = Number(item.unitPriceUsdCents) / 100;
      }

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

  // Get subscribed services (exclude services with pending initial charge or scheduled cancellation)
  // Used only to determine if we should show credits
  const services = await db.query.serviceInstances.findMany({
    where: and(
      eq(serviceInstances.customerId, customerId),
      isNull(serviceInstances.subPendingInvoiceId), // Only include paid services
      isNull(serviceInstances.cancellationScheduledFor)
    ),
  });

  // Get available credits
  // Only show credits if there are active services
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
