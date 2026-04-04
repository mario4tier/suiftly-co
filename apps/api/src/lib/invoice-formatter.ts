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
import { invoiceLineItems } from '@suiftly/database/schema';
import { eq } from 'drizzle-orm';

// Re-export the type for convenience
export type { InvoiceLineItem } from '@suiftly/shared/types';

// Item types that store unitPriceUsdCents as "cents per 1000 requests"
const USAGE_BASED_ITEM_TYPES = new Set([
  INVOICE_LINE_ITEM_TYPE.REQUESTS,
]);

/**
 * Build line items for a DRAFT invoice
 *
 * Reads ALL line items from the invoice_line_items table, including:
 * - Service subscriptions (synced by recalculateDraftInvoice)
 * - Usage charges (synced by syncUsageToDraft)
 * - Add-ons (synced by recalculateDraftInvoice)
 * - Available credits as negative amounts (synced by recalculateDraftInvoice)
 */
export async function buildDraftLineItems(
  draftInvoiceId: number
): Promise<InvoiceLineItem[]> {

  const cachedLineItems = await db.query.invoiceLineItems.findMany({
    where: eq(invoiceLineItems.billingRecordId, draftInvoiceId),
  });

  return cachedLineItems.map((item) => {
    const amountUsd = Number(item.amountUsdCents) / 100;

    // Unit price conversion depends on item type:
    // - Usage (requests): unitPriceUsdCents is "cents per 1000 requests"
    // - Everything else: unitPriceUsdCents is actual price in cents
    const unitPriceUsd = USAGE_BASED_ITEM_TYPES.has(item.itemType as any)
      ? Number(item.unitPriceUsdCents) / 100 / 1000
      : Number(item.unitPriceUsdCents) / 100;

    return {
      service: item.serviceType as ServiceType | null,
      itemType: item.itemType as InvoiceLineItemType,
      quantity: Number(item.quantity),
      unitPriceUsd,
      amountUsd,
      creditMonth: item.creditMonth || undefined,
    };
  });
}

/**
 * Get tier price in cents
 * TODO: Import from config cache instead of hardcoding
 */
