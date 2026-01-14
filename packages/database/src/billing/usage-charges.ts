/**
 * Usage Charges (STATS_DESIGN.md D3)
 *
 * Updates usage-based charges on DRAFT invoices by querying stats_per_hour.
 * Called as part of the monthly billing process on the 1st of each month.
 *
 * Key design: Uses the invoice's billingPeriodStart/billingPeriodEnd as the
 * authoritative billing window. This ensures:
 * - Only charges for the exact month the invoice is for
 * - Idempotent: can be called multiple times safely
 * - Tolerant: works when called on the 1st of the next month
 */

import { eq, sql } from 'drizzle-orm';
import type { Database } from '../db';
import type { LockedTransaction } from './locking';
import { billingRecords, invoiceLineItems, serviceInstances } from '../schema';
import { getBillableRequestCount } from '../stats/queries';
import type { DBClock } from '@suiftly/shared/db-clock';
import {
  SERVICE_TYPE_NUMBER,
  USAGE_PRICING_CENTS_PER_1000,
  INVOICE_LINE_ITEM_TYPE,
  type ServiceType,
} from '@suiftly/shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Result of updating usage charges on a DRAFT invoice
 */
export interface UsageChargeResult {
  success: boolean;
  /** Total usage charges on the invoice in USD cents */
  totalUsageChargesCents: number;
  /** Number of usage line items on the invoice */
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
 * Update usage charges on a DRAFT invoice (idempotent upsert)
 *
 * Queries stats_per_hour for billable requests within the invoice's billing period
 * (billingPeriodStart to billingPeriodEnd), calculates charges per service type,
 * and updates line items on the invoice.
 *
 * Key design principles:
 * - Uses invoice's billingPeriodStart/billingPeriodEnd as the authoritative window
 * - Idempotent: deletes existing usage line items before inserting new ones
 * - Precise: only counts requests with timestamps >= start AND < end
 * - Tolerant: works when called on the 1st of the next month (DRAFT → PENDING)
 *
 * The DRAFT invoice is the single source of truth - it accumulates charges
 * throughout the month and then transitions to PENDING for payment.
 *
 * IMPORTANT: This function performs multiple writes that must be atomic.
 * The caller MUST wrap this in a transaction.
 *
 * @param tx Database or transaction instance (caller should provide transaction context)
 * @param customerId Customer ID
 * @param invoiceId DRAFT invoice ID to update charges on
 * @returns Result with total usage charges and line items count
 */
export async function updateUsageChargesToDraft(
  tx: LockedTransaction,
  customerId: number,
  invoiceId: number
): Promise<UsageChargeResult> {
  // 1. Verify invoice exists and is in DRAFT status
  const [invoice] = await tx
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

  // 2. Get the current usage total (to calculate delta)
  // Usage line items have item_type = 'requests'
  const existingUsageResult = await tx.execute(sql`
    SELECT COALESCE(SUM(amount_usd_cents), 0) as total
    FROM invoice_line_items
    WHERE billing_record_id = ${invoiceId}
      AND item_type = 'requests'
  `);
  const existingUsageTotal = Number(existingUsageResult.rows[0]?.total ?? 0);

  // 3. Delete existing usage line items for idempotency
  // Only delete 'requests' type items, not subscription line items
  await tx.execute(sql`
    DELETE FROM invoice_line_items
    WHERE billing_record_id = ${invoiceId}
      AND item_type = 'requests'
  `);

  // 4. Get all service instances for this customer
  const services = await tx
    .select()
    .from(serviceInstances)
    .where(eq(serviceInstances.customerId, customerId));

  if (services.length === 0) {
    // Update invoice total (subtract old usage, no new usage)
    if (existingUsageTotal > 0) {
      await updateInvoiceTotal(tx, invoiceId, -existingUsageTotal);
    }
    return {
      success: true,
      totalUsageChargesCents: 0,
      lineItemsAdded: 0,
    };
  }

  // 5. Use invoice's billing period as the authoritative time window
  const billingPeriodStart = new Date(invoice.billingPeriodStart);
  const billingPeriodEnd = new Date(invoice.billingPeriodEnd);

  const requestCounts: Record<string, number> = {};
  let totalUsageChargesCents = 0;
  let lineItemsAdded = 0;

  // 6. Process each service
  for (const service of services) {
    const serviceTypeName = service.serviceType as ServiceType;
    const serviceTypeNum = SERVICE_TYPE_NUMBER[serviceTypeName];

    if (!serviceTypeNum) continue;

    // 7. Query stats for billable requests within the billing period
    // WHERE bucket >= billingPeriodStart AND bucket < billingPeriodEnd
    const requestCount = await getBillableRequestCount(
      tx,
      customerId,
      serviceTypeNum,
      billingPeriodStart,
      billingPeriodEnd
    );

    if (requestCount === 0) {
      continue;
    }

    requestCounts[serviceTypeName] = requestCount;

    // 8. Calculate charge (conservative: round down to avoid overcharging)
    const pricePer1000 = USAGE_PRICING_CENTS_PER_1000[serviceTypeName];
    const chargeCents = Math.floor((requestCount * pricePer1000) / 1000);

    if (chargeCents === 0) {
      continue;
    }

    // 9. Add line item with semantic data
    // Unit price: cents per 1000 requests (e.g., 10 = $0.10 per 1000 = $0.0001 per request)
    const unitPriceCents = pricePer1000; // Store as cents per 1000 for precision

    await tx.insert(invoiceLineItems).values({
      billingRecordId: invoiceId,
      itemType: INVOICE_LINE_ITEM_TYPE.REQUESTS,
      serviceType: serviceTypeName,
      quantity: requestCount,
      unitPriceUsdCents: unitPriceCents,
      amountUsdCents: chargeCents,
    });

    totalUsageChargesCents += chargeCents;
    lineItemsAdded++;
  }

  // 10. Update invoice total with usage delta (new usage - old usage)
  const usageDelta = totalUsageChargesCents - existingUsageTotal;
  if (usageDelta !== 0) {
    await updateInvoiceTotal(tx, invoiceId, usageDelta);
  }

  return {
    success: true,
    totalUsageChargesCents,
    lineItemsAdded,
    requestCounts: Object.keys(requestCounts).length > 0 ? requestCounts : undefined,
  };
}

/**
 * Update invoice total by a delta amount
 *
 * This preserves any existing charges (subscription, etc.) while adjusting for usage changes.
 */
async function updateInvoiceTotal(
  tx: LockedTransaction,
  invoiceId: number,
  deltaCents: number
): Promise<void> {
  await tx.execute(sql`
    UPDATE billing_records
    SET amount_usd_cents = amount_usd_cents + ${deltaCents}
    WHERE id = ${invoiceId}
  `);
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

    // Conservative: round down to avoid overcharging
    const pricePer1000 = USAGE_PRICING_CENTS_PER_1000[serviceTypeName];
    const chargeCents = Math.floor((requestCount * pricePer1000) / 1000);

    result.services.push({
      serviceType: service.serviceType,
      requestCount,
      chargeCents,
    });

    result.totalCents += chargeCents;
  }

  return result;
}

// ============================================================================
// Month-End Usage Finalization
// ============================================================================

/**
 * Finalize usage charges for billing (DRAFT → PENDING transition)
 *
 * This function is called during monthly billing to add usage charges for the
 * month that the invoice is designated for. Unlike updateUsageChargesToDraft()
 * which uses the invoice's billing period, this function calculates the usage
 * period as the month BEFORE the invoice's billing period.
 *
 * Design rationale:
 * - The invoice's billingPeriodStart/End is for SUBSCRIPTION prepay (next month)
 * - Usage charges are for the month that just ended (month before billing period)
 * - By deriving the usage period from the invoice (not the clock), we ensure
 *   correct billing even if processing is delayed (e.g., January DRAFT processed
 *   in March will still bill January's usage, not February's)
 *
 * Example: Invoice has billingPeriodStart = March 1 (for March subscription).
 * This function:
 * - Derives usagePeriodEnd = March 1 (the invoice's billing period start)
 * - Derives usagePeriodStart = February 1 (month before)
 * - Queries February's usage
 *
 * IMPORTANT: This function performs multiple writes that must be atomic.
 * The caller MUST wrap this in a transaction.
 *
 * @param tx Database or transaction instance (caller should provide transaction context)
 * @param customerId Customer ID
 * @param invoiceId DRAFT invoice ID to add usage charges to
 * @param _clock DBClock (unused, kept for API consistency - usage period derived from invoice)
 * @returns Result with total usage charges and line items count
 */
export async function finalizeUsageChargesForBilling(
  tx: LockedTransaction,
  customerId: number,
  invoiceId: number,
  _clock: DBClock
): Promise<UsageChargeResult> {
  // 1. Verify invoice exists and is in DRAFT status
  const [invoice] = await tx
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

  // 2. Get the current usage total (to calculate delta)
  const existingUsageResult = await tx.execute(sql`
    SELECT COALESCE(SUM(amount_usd_cents), 0) as total
    FROM invoice_line_items
    WHERE billing_record_id = ${invoiceId}
      AND item_type = 'requests'
  `);
  const existingUsageTotal = Number(existingUsageResult.rows[0]?.total ?? 0);

  // 3. Delete existing usage line items for idempotency
  await tx.execute(sql`
    DELETE FROM invoice_line_items
    WHERE billing_record_id = ${invoiceId}
      AND item_type = 'requests'
  `);

  // 4. Get all service instances for this customer
  const services = await tx
    .select()
    .from(serviceInstances)
    .where(eq(serviceInstances.customerId, customerId));

  if (services.length === 0) {
    // Update invoice total (subtract old usage, no new usage)
    if (existingUsageTotal > 0) {
      await updateInvoiceTotal(tx, invoiceId, -existingUsageTotal);
    }
    return {
      success: true,
      totalUsageChargesCents: 0,
      lineItemsAdded: 0,
    };
  }

  // 5. Derive the USAGE PERIOD from the invoice's billing period
  //
  // The invoice's billingPeriodStart is for subscription prepay (next month).
  // Usage charges are for the month BEFORE that period.
  //
  // Example: Invoice billingPeriodStart = March 1
  //   - usagePeriodEnd = March 1 (exclusive)
  //   - usagePeriodStart = February 1
  //
  // This ensures correct billing even if processing is delayed:
  //   - January invoice (billingPeriodStart = Feb 1) processed in March
  //     will bill January usage, not February usage
  //
  // Note: JavaScript Date.UTC() handles month underflow correctly:
  // - Date.UTC(2025, -1, 1) = December 1, 2024 (auto year rollback)
  // - This is documented JS behavior: out-of-range values are normalized
  const invoiceBillingStart = new Date(invoice.billingPeriodStart);

  // Usage period ends at the invoice's billing period start (exclusive boundary)
  const usagePeriodEnd = new Date(Date.UTC(
    invoiceBillingStart.getUTCFullYear(),
    invoiceBillingStart.getUTCMonth(),
    1, 0, 0, 0, 0
  ));

  // Usage period starts at the first day of the previous month
  const usagePeriodStart = new Date(Date.UTC(
    invoiceBillingStart.getUTCFullYear(),
    invoiceBillingStart.getUTCMonth() - 1,
    1, 0, 0, 0, 0
  ));

  const requestCounts: Record<string, number> = {};
  let totalUsageChargesCents = 0;
  let lineItemsAdded = 0;

  // 6. Process each service
  for (const service of services) {
    const serviceTypeName = service.serviceType as ServiceType;
    const serviceTypeNum = SERVICE_TYPE_NUMBER[serviceTypeName];

    if (!serviceTypeNum) continue;

    // 7. Query stats for billable requests within the PREVIOUS month
    const requestCount = await getBillableRequestCount(
      tx,
      customerId,
      serviceTypeNum,
      usagePeriodStart,
      usagePeriodEnd
    );

    if (requestCount === 0) {
      continue;
    }

    requestCounts[serviceTypeName] = requestCount;

    // 8. Calculate charge (conservative: round down to avoid overcharging)
    const pricePer1000 = USAGE_PRICING_CENTS_PER_1000[serviceTypeName];
    const chargeCents = Math.floor((requestCount * pricePer1000) / 1000);

    if (chargeCents === 0) {
      continue;
    }

    // 9. Add line item with semantic data
    const unitPriceCents = pricePer1000;

    await tx.insert(invoiceLineItems).values({
      billingRecordId: invoiceId,
      itemType: INVOICE_LINE_ITEM_TYPE.REQUESTS,
      serviceType: serviceTypeName,
      quantity: requestCount,
      unitPriceUsdCents: unitPriceCents,
      amountUsdCents: chargeCents,
    });

    totalUsageChargesCents += chargeCents;
    lineItemsAdded++;
  }

  // 10. Update invoice total with usage delta (new usage - old usage)
  const usageDelta = totalUsageChargesCents - existingUsageTotal;
  if (usageDelta !== 0) {
    await updateInvoiceTotal(tx, invoiceId, usageDelta);
  }

  return {
    success: true,
    totalUsageChargesCents,
    lineItemsAdded,
    requestCounts: Object.keys(requestCounts).length > 0 ? requestCounts : undefined,
  };
}

// ============================================================================
// Periodic Usage Sync
// ============================================================================

/**
 * Result of syncing usage to DRAFT invoice
 */
export interface UsageSyncResult {
  success: boolean;
  /** Total usage charges on the invoice in USD cents */
  totalUsageChargesCents: number;
  /** Number of usage line items on the invoice */
  lineItemsCount: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Sync usage charges to DRAFT invoice (for display purposes)
 *
 * This function is called periodically (hourly) to keep the DRAFT invoice
 * updated with current usage. Unlike updateUsageChargesToDraft() which is
 * for final billing, this function:
 * - Always creates line items even for 0 requests (for pricing transparency)
 * - Updates lastUpdatedAt timestamp
 * - Uses the invoice's billing period for consistency
 *
 * IMPORTANT: This function performs multiple writes that must be atomic.
 * The caller MUST wrap this in a transaction.
 *
 * @param tx Database or locked transaction instance
 * @param customerId Customer ID
 * @param invoiceId DRAFT invoice ID to sync usage to
 * @param clock DBClock for current time
 * @returns Result with total usage charges
 */
export async function syncUsageToDraft(
  tx: LockedTransaction,
  customerId: number,
  invoiceId: number,
  clock: DBClock
): Promise<UsageSyncResult> {
  // 1. Verify invoice exists and is in DRAFT status
  const [invoice] = await tx
    .select()
    .from(billingRecords)
    .where(eq(billingRecords.id, invoiceId))
    .limit(1);

  if (!invoice) {
    return {
      success: false,
      totalUsageChargesCents: 0,
      lineItemsCount: 0,
      error: 'Invoice not found',
    };
  }

  if (invoice.status !== 'draft') {
    return {
      success: false,
      totalUsageChargesCents: 0,
      lineItemsCount: 0,
      error: `Invoice is not in draft status (current: ${invoice.status})`,
    };
  }

  // 2. Get the current usage total (to calculate delta)
  // Usage line items have item_type = 'requests'
  const existingUsageResult = await tx.execute(sql`
    SELECT COALESCE(SUM(amount_usd_cents), 0) as total
    FROM invoice_line_items
    WHERE billing_record_id = ${invoiceId}
      AND item_type = 'requests'
  `);
  const existingUsageTotal = Number(existingUsageResult.rows[0]?.total ?? 0);

  // 3. Delete existing usage line items for idempotency
  // Only delete 'requests' type items, not subscription line items
  await tx.execute(sql`
    DELETE FROM invoice_line_items
    WHERE billing_record_id = ${invoiceId}
      AND item_type = 'requests'
  `);

  // 4. Get all subscribed services for this customer
  // Skip services with pending subscription charge (not yet paid initial charge)
  const services = await tx
    .select()
    .from(serviceInstances)
    .where(eq(serviceInstances.customerId, customerId));

  const activeServices = services.filter(s => s.subPendingInvoiceId === null);

  // 5. For DRAFT invoices, show CURRENT month's usage (not next month's billing period)
  // The DRAFT billing period is for next month's subscription charges,
  // but usage charges reflect what the customer accrued THIS month
  const today = clock.today();
  const currentMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const now = clock.now();

  let totalUsageChargesCents = 0;
  let lineItemsCount = 0;

  // 6. Process each active service - always create line item for transparency
  for (const service of activeServices) {
    const serviceTypeName = service.serviceType as ServiceType;
    const serviceTypeNum = SERVICE_TYPE_NUMBER[serviceTypeName];

    if (!serviceTypeNum) continue;

    // Query stats for billable requests from start of month to now
    // Note: We count ALL logs in the billing period, regardless of enabledAt.
    // If HAProxy logged requests, they were served and should be billed.
    const requestCount = await getBillableRequestCount(
      tx,
      customerId,
      serviceTypeNum,
      currentMonthStart,
      now
    );

    // 8. Calculate charge (conservative: round down)
    const pricePer1000 = USAGE_PRICING_CENTS_PER_1000[serviceTypeName];
    const chargeCents = Math.floor((requestCount * pricePer1000) / 1000);

    // 9. Always add line item for transparency (even if 0 requests)
    // Unit price: cents per 1000 requests (stored for precision)
    const unitPriceCents = pricePer1000;

    await tx.insert(invoiceLineItems).values({
      billingRecordId: invoiceId,
      itemType: INVOICE_LINE_ITEM_TYPE.REQUESTS,
      serviceType: serviceTypeName,
      quantity: requestCount,
      unitPriceUsdCents: unitPriceCents,
      amountUsdCents: chargeCents,
    });

    totalUsageChargesCents += chargeCents;
    lineItemsCount++;
  }

  // 10. Update invoice total if there was a change
  const usageDelta = totalUsageChargesCents - existingUsageTotal;
  if (usageDelta !== 0) {
    await tx.execute(sql`
      UPDATE billing_records
      SET amount_usd_cents = amount_usd_cents + ${usageDelta}
      WHERE id = ${invoiceId}
    `);
  }

  // 11. Always update lastUpdatedAt to indicate we checked (even if no changes)
  await tx.execute(sql`
    UPDATE billing_records
    SET last_updated_at = ${now}
    WHERE id = ${invoiceId}
  `);

  return {
    success: true,
    totalUsageChargesCents,
    lineItemsCount,
  };
}
