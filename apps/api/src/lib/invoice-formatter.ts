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
import { customerCredits, serviceInstances } from '@suiftly/database/schema';
import { eq, and, sql, gt } from 'drizzle-orm';
import { dbClock } from '@suiftly/shared/db-clock';

/**
 * Line item for invoice display
 */
export interface InvoiceLineItem {
  description: string;
  amountUsd: number;
  type: 'subscription' | 'addon' | 'usage' | 'credit' | 'tax';
}

/**
 * Build line items for a DRAFT invoice
 *
 * Calculates what will be charged on the 1st of next month, including:
 * - Service subscriptions (by name: "Seal Pro tier")
 * - Add-ons (future: "Seal - 2 extra keys")
 * - Available credits (will be applied when DRAFT → PENDING)
 *
 * @param customerId Customer ID
 * @param draftAmountCents DRAFT invoice gross amount
 * @returns Array of line items
 */
export async function buildDraftLineItems(
  customerId: number,
  draftAmountCents: number
): Promise<InvoiceLineItem[]> {
  const lineItems: InvoiceLineItem[] = [];

  // Get subscribed services
  const services = await db.query.serviceInstances.findMany({
    where: eq(serviceInstances.customerId, customerId),
  });

  // Add line item for each service
  for (const service of services) {
    const tierPrice = getTierPriceUsdCents(service.tier);
    const serviceName = service.serviceType.charAt(0).toUpperCase() + service.serviceType.slice(1);
    const tierName = service.tier.charAt(0).toUpperCase() + service.tier.slice(1);

    lineItems.push({
      description: `${serviceName} ${tierName} tier`,
      amountUsd: tierPrice / 100,
      type: 'subscription',
    });

    // Future: Add-ons would be additional line items here
    // e.g., "Seal - 2 extra keys @ $5/mo"
  }

  // Get available credits
  const now = dbClock.now();
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
    // Credit description includes service name for clarity
    // When multiple services exist, will show "Seal partial month credit", "gRPC partial month credit", etc.
    const serviceName = services.length === 1
      ? services[0].serviceType.charAt(0).toUpperCase() + services[0].serviceType.slice(1)
      : 'Service'; // Fallback if multiple services (rare for partial month credit)

    lineItems.push({
      description: `${serviceName} partial month credit`,
      amountUsd: -(creditsCents / 100),
      type: 'credit',
    });
  }

  return lineItems;
}

/**
 * Get tier price in cents
 * TODO: Import from config cache instead of hardcoding
 */
