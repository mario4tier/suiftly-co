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
import { eq, and, sql, gt, isNull } from 'drizzle-orm';
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
 * IMPORTANT: Excludes services with subscriptionChargePending=true because:
 * - Initial charge hasn't been paid yet
 * - Service hasn't been activated/provisioned
 * - Proration credit calculation would be unclear
 * - It's confusing to show next month's charges when current month isn't settled
 *
 * @param customerId Customer ID
 * @param draftAmountCents DRAFT invoice gross amount
 * @param billingPeriodStart Invoice due date (1st of next month) - used to calculate credit month
 * @returns Array of line items
 */
export async function buildDraftLineItems(
  customerId: number,
  draftAmountCents: number,
  billingPeriodStart?: Date
): Promise<InvoiceLineItem[]> {
  const lineItems: InvoiceLineItem[] = [];

  // Get subscribed services (exclude services with pending initial charge or scheduled cancellation)
  const services = await db.query.serviceInstances.findMany({
    where: and(
      eq(serviceInstances.customerId, customerId),
      eq(serviceInstances.subscriptionChargePending, false),
      isNull(serviceInstances.cancellationScheduledFor)
    ),
  });

  // Add line item for each service
  for (const service of services) {
    // Use scheduled tier if present (for scheduled downgrades), otherwise current tier
    // This ensures DRAFT invoice line items reflect what will ACTUALLY be charged
    const effectiveTier = service.scheduledTier || service.tier;
    const tierPrice = getTierPriceUsdCents(effectiveTier);
    const serviceName = service.serviceType.charAt(0).toUpperCase() + service.serviceType.slice(1);
    const tierName = effectiveTier.charAt(0).toUpperCase() + effectiveTier.slice(1);

    lineItems.push({
      description: `${serviceName} ${tierName} tier`,
      amountUsd: tierPrice / 100,
      type: 'subscription',
    });

    // Future: Add-ons would be additional line items here
    // e.g., "Seal - 2 extra keys @ $5/mo"
  }

  // Get available credits
  // Only show credits if there are active services in the DRAFT
  // (If all services have pending subscription charges, don't show credits)
  if (services.length > 0) {
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
      // Credit description includes service name, tier, and month for clarity
      // Use CURRENT tier (not scheduled), since credit was generated from what user paid for
      const serviceName = services.length === 1
        ? services[0].serviceType.charAt(0).toUpperCase() + services[0].serviceType.slice(1)
        : 'Service'; // Fallback if multiple services (rare for partial month credit)
      const tierName = services.length === 1
        ? services[0].tier.charAt(0).toUpperCase() + services[0].tier.slice(1)
        : ''; // Omit tier if multiple services

      // Credit is for the month BEFORE the DRAFT invoice due date
      // Example: December 1st DRAFT invoice → credit is for November partial month
      let creditMonth: Date;
      if (billingPeriodStart) {
        // Use invoice due date minus 1 month
        creditMonth = new Date(billingPeriodStart);
        creditMonth.setUTCMonth(creditMonth.getUTCMonth() - 1);
      } else {
        // Fallback to current month if billing period not provided
        creditMonth = now;
      }

      const monthName = creditMonth.toLocaleDateString('en-US', {
        month: 'long',
        timeZone: 'UTC'
      });

      // Format: "Seal Starter partial month credit (November)"
      const tierPart = tierName ? ` ${tierName}` : '';
      lineItems.push({
        description: `${serviceName}${tierPart} partial month credit (${monthName})`,
        amountUsd: -(creditsCents / 100),
        type: 'credit',
      });
    }
  }

  return lineItems;
}

/**
 * Get tier price in cents
 * TODO: Import from config cache instead of hardcoding
 */
