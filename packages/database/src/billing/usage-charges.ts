/**
 * Usage Charges (STATS_DESIGN.md D3)
 *
 * Adds usage-based charges to DRAFT invoices by querying stats_per_hour.
 * Called as part of the monthly billing process on the 1st of each month.
 */

import { eq, and, sql } from 'drizzle-orm';
import type { Database, DatabaseOrTransaction } from '../db';
import { billingRecords, invoiceLineItems, serviceInstances } from '../schema';
import { getBillableRequestCount } from '../stats/queries';
import type { DBClock } from '@suiftly/shared/db-clock';
import {
  SERVICE_TYPE_NUMBER,
  SERVICE_NUMBER_TO_TYPE,
  USAGE_PRICING_CENTS_PER_1000,
  type ServiceType,
} from '@suiftly/shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Result of adding usage charges to a DRAFT invoice
 */
export interface UsageChargeResult {
  success: boolean;
  /** Total usage charges added in USD cents */
  totalUsageChargesCents: number;
  /** Number of line items added */
  lineItemsAdded: number;
  /** Request counts per service type */
  requestCounts?: {
    seal?: number;
    grpc?: number;
    graphql?: number;
  };
  /** Error message if failed */
  error?: string;
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Add usage charges to a DRAFT invoice
 *
 * Queries stats_per_hour for billable requests since last_billed_timestamp,
 * calculates charges per service type, and adds line items to the invoice.
 *
 * @param db Database instance
 * @param customerId Customer ID
 * @param invoiceId DRAFT invoice ID to add charges to
 * @param clock DBClock for time reference
 * @returns Result with total charges and line items added
 */
export async function addUsageChargesToDraft(
  db: Database,
  customerId: number,
  invoiceId: string,
  clock: DBClock
): Promise<UsageChargeResult> {
  // 1. Verify invoice exists and is in DRAFT status
  const [invoice] = await db
    .select()
    .from(billingRecords)
    .where(eq(billingRecords.id, invoiceId))
    .limit(1);

  if (!invoice) {
    return {
      success: false,
      totalUsageChargesCents: 0,
      lineItemsAdded: 0,
      error: 'Invoice not found',
    };
  }

  if (invoice.status !== 'draft') {
    return {
      success: false,
      totalUsageChargesCents: 0,
      lineItemsAdded: 0,
      error: `Invoice is not in draft status (current: ${invoice.status})`,
    };
  }

  // 2. Get all service instances for this customer
  const services = await db
    .select()
    .from(serviceInstances)
    .where(eq(serviceInstances.customerId, customerId));

  if (services.length === 0) {
    return {
      success: true,
      totalUsageChargesCents: 0,
      lineItemsAdded: 0,
    };
  }

  // 3. Calculate billing period
  const billingPeriodEnd = clock.now();
  const requestCounts: Record<string, number> = {};
  let totalUsageChargesCents = 0;
  let lineItemsAdded = 0;

  // 4. Process each service
  for (const service of services) {
    const serviceTypeName = service.serviceType as ServiceType;
    const serviceTypeNum = SERVICE_TYPE_NUMBER[serviceTypeName];

    if (!serviceTypeNum) continue;

    // Determine billing start time
    // Use last_billed_timestamp if set, otherwise use billing_period_start
    const billingPeriodStart = service.lastBilledTimestamp
      ? new Date(service.lastBilledTimestamp)
      : new Date(invoice.billingPeriodStart);

    // Skip if no time range to bill
    if (billingPeriodStart >= billingPeriodEnd) {
      continue;
    }

    // 5. Query stats for billable requests
    const requestCount = await getBillableRequestCount(
      db,
      customerId,
      serviceTypeNum,
      billingPeriodStart,
      billingPeriodEnd
    );

    if (requestCount === 0) {
      continue;
    }

    requestCounts[serviceTypeName] = requestCount;

    // 6. Calculate charge
    const pricePer1000 = USAGE_PRICING_CENTS_PER_1000[serviceTypeName];
    const chargeCents = Math.ceil((requestCount * pricePer1000) / 1000);

    if (chargeCents === 0) {
      continue;
    }

    // 7. Add line item
    await db.insert(invoiceLineItems).values({
      billingRecordId: invoiceId,
      description: `Usage: ${serviceTypeName.charAt(0).toUpperCase() + serviceTypeName.slice(1)} - ${requestCount.toLocaleString()} requests`,
      amountUsdCents: chargeCents,
      serviceType: serviceTypeName,
      quantity: requestCount,
    });

    totalUsageChargesCents += chargeCents;
    lineItemsAdded++;

    // 8. Update last_billed_timestamp
    await db.update(serviceInstances)
      .set({ lastBilledTimestamp: billingPeriodEnd })
      .where(eq(serviceInstances.instanceId, service.instanceId));
  }

  // 9. Update invoice total
  if (totalUsageChargesCents > 0) {
    const currentAmount = Number(invoice.amountUsdCents ?? 0);
    await db.update(billingRecords)
      .set({ amountUsdCents: currentAmount + totalUsageChargesCents })
      .where(eq(billingRecords.id, invoiceId));
  }

  return {
    success: true,
    totalUsageChargesCents,
    lineItemsAdded,
    requestCounts: Object.keys(requestCounts).length > 0 ? requestCounts : undefined,
  };
}

/**
 * Get usage charge summary for a customer (preview without creating line items)
 *
 * Useful for showing pending usage charges in the dashboard.
 *
 * @param db Database instance
 * @param customerId Customer ID
 * @param clock DBClock for time reference
 * @returns Preview of usage charges
 */
export async function getUsageChargePreview(
  db: Database,
  customerId: number,
  clock: DBClock
): Promise<{
  totalCents: number;
  services: Array<{
    serviceType: string;
    requestCount: number;
    chargeCents: number;
  }>;
}> {
  const services = await db
    .select()
    .from(serviceInstances)
    .where(eq(serviceInstances.customerId, customerId));

  const result: {
    totalCents: number;
    services: Array<{
      serviceType: string;
      requestCount: number;
      chargeCents: number;
    }>;
  } = {
    totalCents: 0,
    services: [],
  };

  const now = clock.now();

  for (const service of services) {
    const serviceTypeName = service.serviceType as ServiceType;
    const serviceTypeNum = SERVICE_TYPE_NUMBER[serviceTypeName];
    if (!serviceTypeNum) continue;

    const startTime = service.lastBilledTimestamp
      ? new Date(service.lastBilledTimestamp)
      : new Date(service.enabledAt ?? now);

    const requestCount = await getBillableRequestCount(
      db,
      customerId,
      serviceTypeNum,
      startTime,
      now
    );

    if (requestCount === 0) continue;

    const pricePer1000 = USAGE_PRICING_CENTS_PER_1000[serviceTypeName];
    const chargeCents = Math.ceil((requestCount * pricePer1000) / 1000);

    result.services.push({
      serviceType: service.serviceType,
      requestCount,
      chargeCents,
    });

    result.totalCents += chargeCents;
  }

  return result;
}
