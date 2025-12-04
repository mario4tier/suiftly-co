/**
 * Single-Thread Billing Processor (Phase 1B + Phase 1C)
 *
 * Main billing engine that processes all billing operations sequentially.
 * Called periodically (every 5 minutes) to handle:
 * - Monthly subscription billing (1st of month)
 * - Scheduled tier changes (1st of month) [Phase 1C]
 * - Scheduled cancellations (1st of month) [Phase 1C]
 * - Payment retries for failed invoices
 * - Grace period management (14-day expiration)
 * - Payment reconciliation after deposits
 *
 * See BILLING_DESIGN.md Phase 1B and R13 for detailed requirements.
 *
 * IMPORTANT: All operations use customer-level locking to prevent race conditions.
 */

import { eq, and, sql, inArray } from 'drizzle-orm';
import { billingRecords, customers, serviceInstances } from '../schema';
import type { Database } from '../db';
import { withCustomerLock, type LockedTransaction } from './locking';
import { processInvoicePayment } from './payments';
import {
  startGracePeriod,
  clearGracePeriod,
  getCustomersWithExpiredGracePeriod,
  suspendCustomerForNonPayment,
  resumeCustomerAccount,
} from './grace-period';
import { withIdempotency, generateMonthlyBillingKey } from './idempotency';
import { ensureInvoiceValid } from './validation';
import { ValidationError } from './errors';
import { applyScheduledTierChanges, processScheduledCancellations } from './tier-changes';
import { recalculateDraftInvoice } from './service-billing';
import { updateUsageChargesToDraft, syncUsageToDraft } from './usage-charges';
import type { BillingProcessorConfig, CustomerBillingResult, BillingOperation } from './types';
import type { DBClock } from '@suiftly/shared/db-clock';
import type { ISuiService } from '@suiftly/shared/sui-service';

// How often to sync usage to DRAFT invoices (in milliseconds)
const USAGE_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Process billing for a single customer
 *
 * Handles all billing operations for one customer in a single transaction with proper locking.
 *
 * @param db Database instance
 * @param customerId Customer ID to process
 * @param config Billing processor configuration
 * @param suiService Sui service for escrow operations
 * @returns Result of billing operations
 */
export async function processCustomerBilling(
  db: Database,
  customerId: number,
  config: BillingProcessorConfig,
  suiService: ISuiService
): Promise<CustomerBillingResult> {
  return await withCustomerLock(db, customerId, async (tx) => {
    const result: CustomerBillingResult = {
      customerId,
      success: true,
      operations: [],
      errors: [],
    };

    const now = config.clock.now();
    const today = config.clock.today();

    // Check if it's the 1st of the month (monthly billing day)
    // Use UTC date to avoid timezone issues
    const isFirstOfMonth = today.getUTCDate() === 1;

    if (isFirstOfMonth) {
      // Process monthly billing
      const monthlyResult = await processMonthlyBilling(
        tx,
        customerId,
        config,
        suiService
      );
      result.operations.push(...monthlyResult.operations);
      result.errors.push(...monthlyResult.errors);
    }

    // Retry failed payments
    const retryResult = await retryFailedPayments(
      tx,
      customerId,
      config,
      suiService
    );
    result.operations.push(...retryResult.operations);
    result.errors.push(...retryResult.errors);

    // Check grace period expiration
    const gracePeriodResult = await checkGracePeriodExpiration(
      tx,
      customerId,
      config
    );
    result.operations.push(...gracePeriodResult.operations);
    result.errors.push(...gracePeriodResult.errors);

    // Sync usage to DRAFT invoices hourly (for display)
    // Skip on 1st of month since updateUsageChargesToDraft already runs there
    if (!isFirstOfMonth) {
      const usageSyncResult = await syncUsageToCustomerDraft(
        tx,
        customerId,
        config.clock
      );
      result.operations.push(...usageSyncResult.operations);
      result.errors.push(...usageSyncResult.errors);
    }

    result.success = result.errors.length === 0;

    return result;
  });
}

/**
 * Process monthly billing for a customer
 *
 * Called on the 1st of each month. Transitions DRAFT invoices to PENDING and attempts payment.
 *
 * @param tx Transaction handle (must have customer lock)
 * @param customerId Customer ID
 * @param config Billing processor configuration
 * @param suiService Sui service for escrow operations
 * @returns Billing result
 */
async function processMonthlyBilling(
  tx: LockedTransaction,
  customerId: number,
  config: BillingProcessorConfig,
  suiService: ISuiService
): Promise<CustomerBillingResult> {
  const result: CustomerBillingResult = {
    customerId,
    success: true,
    operations: [],
    errors: [],
  };

  const today = config.clock.today();
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1; // JavaScript months are 0-indexed

  // Find DRAFT invoices for this customer
  const draftInvoices = await tx.query.billingRecords.findMany({
    where: and(
      eq(billingRecords.customerId, customerId),
      eq(billingRecords.status, 'draft')
    ),
  });

  if (draftInvoices.length === 0) {
    return result; // No draft invoices, nothing to do
  }

  // Check for idempotency (prevent double-billing)
  const idempotencyKey = generateMonthlyBillingKey(customerId, year, month);
  const idempotencyResult = await withIdempotency(
    tx,
    idempotencyKey,
    async () => {
      // Phase 1C: Process scheduled tier changes BEFORE billing
      // This ensures customers are billed at new tier rate
      const tierChangesApplied = await applyScheduledTierChanges(tx, customerId, config.clock);
      if (tierChangesApplied > 0) {
        result.operations.push({
          type: 'reconciliation',
          timestamp: config.clock.now(),
          description: `Applied ${tierChangesApplied} scheduled tier change(s)`,
          success: true,
        });
        // Recalculate DRAFT invoice after tier changes
        await recalculateDraftInvoice(tx, customerId, config.clock);
      }

      // Phase 1C: Process scheduled cancellations BEFORE billing
      // Cancelled services transition to cancellation_pending, removed from DRAFT
      const cancellationsProcessed = await processScheduledCancellations(tx, customerId, config.clock);
      if (cancellationsProcessed > 0) {
        result.operations.push({
          type: 'reconciliation',
          timestamp: config.clock.now(),
          description: `Processed ${cancellationsProcessed} scheduled cancellation(s)`,
          success: true,
        });
        // Recalculate DRAFT invoice after cancellations
        await recalculateDraftInvoice(tx, customerId, config.clock);
      }

      // Phase: ADD USAGE CHARGES (STATS_DESIGN.md D3)
      // Update usage charges on each DRAFT invoice based on stats_per_hour data
      // Uses invoice's billingPeriodStart/billingPeriodEnd as the authoritative window
      for (const invoice of draftInvoices) {
        const usageResult = await updateUsageChargesToDraft(tx, customerId, invoice.id);
        if (usageResult.success && usageResult.lineItemsAdded > 0) {
          result.operations.push({
            type: 'reconciliation',
            timestamp: config.clock.now(),
            description: `Added usage charges: ${usageResult.lineItemsAdded} service(s), $${(usageResult.totalUsageChargesCents / 100).toFixed(2)}`,
            success: true,
          });
        }
      }

      // Transition DRAFT → PENDING and attempt payment
      for (const invoice of draftInvoices) {
        // CRITICAL: Validate invoice before processing
        // Catches bugs like stale DRAFT amounts, duplicate charges, etc.
        try {
          await ensureInvoiceValid(tx, invoice.id);
        } catch (error) {
          // Use instanceof to distinguish error types (type-safe, no magic strings)
          if (error instanceof ValidationError) {
            // Permanent data issue - skip this invoice (safe to cache)
            result.operations.push({
              type: 'monthly_billing',
              timestamp: config.clock.now(),
              invoiceId: invoice.id,
              description: `VALIDATION FAILED: ${error.message}`,
              success: false,
            });
            continue; // Skip this invoice, continue with others
          } else {
            // System error (DB timeout, network, etc.) - throw to prevent caching
            // Entire billing run will be retried in 5 minutes
            throw error;
          }
        }

        // Update status to PENDING
        await tx
          .update(billingRecords)
          .set({ status: 'pending' })
          .where(eq(billingRecords.id, invoice.id));

        // Attempt payment
        const paymentResult = await processInvoicePayment(
          tx,
          invoice.id,
          suiService,
          config.clock
        );

        if (paymentResult.fullyPaid) {
          // Payment successful
          result.operations.push({
            type: 'monthly_billing',
            timestamp: config.clock.now(),
            amountUsdCents: paymentResult.amountPaidCents,
            invoiceId: invoice.id,
            description: `Monthly subscription paid`,
            success: true,
          });

          // Clear grace period if customer was in one
          await clearGracePeriod(tx, customerId);

          // Mark customer as having paid at least once (for grace period eligibility)
          await tx
            .update(customers)
            .set({ paidOnce: true })
            .where(eq(customers.customerId, customerId));

          // Mark all active services as having paid at least once (for tier change/cancellation behavior)
          await tx
            .update(serviceInstances)
            .set({ paidOnce: true })
            .where(eq(serviceInstances.customerId, customerId));
        } else {
          // Payment failed
          result.operations.push({
            type: 'monthly_billing',
            timestamp: config.clock.now(),
            amountUsdCents: Number(invoice.amountUsdCents),
            invoiceId: invoice.id,
            description: `Monthly subscription failed: ${paymentResult.error?.message}`,
            success: false,
          });

          if (paymentResult.error) {
            result.errors.push(paymentResult.error);
          }

          // Start grace period if applicable (only if paid_once = TRUE)
          const graceStarted = await startGracePeriod(tx, customerId, config.clock);

          if (graceStarted) {
            result.operations.push({
              type: 'grace_period_start',
              timestamp: config.clock.now(),
              description: `Grace period started (14 days)`,
              success: true,
            });
          }
        }
      }

      return { processed: true, invoiceCount: draftInvoices.length };
    }
  );

  if (idempotencyResult.cached) {
    result.operations.push({
      type: 'monthly_billing',
      timestamp: config.clock.now(),
      description: `Monthly billing already processed (idempotent)`,
      success: true,
    });
  }

  return result;
}

/**
 * Retry failed payments
 *
 * Attempts to re-process failed invoices that haven't exceeded retry limit.
 *
 * @param tx Transaction handle (must have customer lock)
 * @param customerId Customer ID
 * @param config Billing processor configuration
 * @param suiService Sui service for escrow operations
 * @returns Billing result
 */
async function retryFailedPayments(
  tx: LockedTransaction,
  customerId: number,
  config: BillingProcessorConfig,
  suiService: ISuiService
): Promise<CustomerBillingResult> {
  const result: CustomerBillingResult = {
    customerId,
    success: true,
    operations: [],
    errors: [],
  };

  const now = config.clock.now();
  const retryThreshold = new Date(now.getTime() - config.retryIntervalHours * 60 * 60 * 1000);

  // Find failed invoices eligible for retry
  const failedInvoices = await tx
    .select()
    .from(billingRecords)
    .where(
      and(
        eq(billingRecords.customerId, customerId),
        eq(billingRecords.status, 'failed'),
        sql`COALESCE(${billingRecords.retryCount}, 0) < ${config.maxRetryAttempts}`,
        sql`(${billingRecords.lastRetryAt} IS NULL OR ${billingRecords.lastRetryAt} < ${retryThreshold})`
      )
    );

  for (const invoice of failedInvoices) {
    // Reset status to pending for retry
    await tx
      .update(billingRecords)
      .set({ status: 'pending' })
      .where(eq(billingRecords.id, invoice.id));

    // Attempt payment
    const paymentResult = await processInvoicePayment(
      tx,
      invoice.id,
      suiService,
      config.clock
    );

    if (paymentResult.fullyPaid) {
      result.operations.push({
        type: 'payment_retry',
        timestamp: now,
        amountUsdCents: paymentResult.amountPaidCents,
        invoiceId: invoice.id,
        description: `Payment retry successful`,
        success: true,
      });

      // Clear grace period if applicable
      await clearGracePeriod(tx, customerId);

      // Mark customer as having paid (for grace period eligibility)
      await tx
        .update(customers)
        .set({ paidOnce: true })
        .where(eq(customers.customerId, customerId));

      // Mark all active services as having paid at least once (for tier change/cancellation behavior)
      await tx
        .update(serviceInstances)
        .set({ paidOnce: true })
        .where(eq(serviceInstances.customerId, customerId));
    } else {
      result.operations.push({
        type: 'payment_retry',
        timestamp: now,
        amountUsdCents: Number(invoice.amountUsdCents),
        invoiceId: invoice.id,
        description: `Payment retry failed: ${paymentResult.error?.message}`,
        success: false,
      });

      if (paymentResult.error) {
        result.errors.push(paymentResult.error);
      }
    }
  }

  return result;
}

/**
 * Check and process grace period expiration
 *
 * Suspends customers whose grace period has expired.
 *
 * @param tx Transaction handle (must have customer lock)
 * @param customerId Customer ID
 * @param config Billing processor configuration
 * @returns Billing result
 */
async function checkGracePeriodExpiration(
  tx: LockedTransaction,
  customerId: number,
  config: BillingProcessorConfig
): Promise<CustomerBillingResult> {
  const result: CustomerBillingResult = {
    customerId,
    success: true,
    operations: [],
    errors: [],
  };

  // Get customers with expired grace periods
  const expiredCustomers = await getCustomersWithExpiredGracePeriod(
    tx,
    config.clock,
    config.gracePeriodDays
  );

  if (expiredCustomers.includes(customerId)) {
    // Suspend customer
    const serviceCount = await suspendCustomerForNonPayment(tx, customerId);

    result.operations.push({
      type: 'grace_period_end',
      timestamp: config.clock.now(),
      description: `Grace period expired - account suspended (${serviceCount} services disabled)`,
      success: true,
    });
  }

  return result;
}

/**
 * Sync usage to customer's DRAFT invoice (for display)
 *
 * Called hourly to keep DRAFT invoices updated with current usage.
 * Skips if less than an hour has passed since last update (unless force=true).
 *
 * @param tx Transaction handle (must have customer lock)
 * @param customerId Customer ID
 * @param clock DBClock for time reference
 * @param force If true, bypasses debouncing and always syncs
 * @returns Billing result
 */
async function syncUsageToCustomerDraft(
  tx: LockedTransaction,
  customerId: number,
  clock: DBClock,
  force: boolean = false
): Promise<CustomerBillingResult> {
  const result: CustomerBillingResult = {
    customerId,
    success: true,
    operations: [],
    errors: [],
  };

  const now = clock.now();

  // Find DRAFT invoice for this customer
  const draftInvoice = await tx.query.billingRecords.findFirst({
    where: and(
      eq(billingRecords.customerId, customerId),
      eq(billingRecords.status, 'draft')
    ),
  });

  if (!draftInvoice) {
    return result; // No draft invoice, nothing to sync
  }

  // Check if enough time has passed since last update (unless force=true)
  if (!force) {
    const lastUpdated = draftInvoice.lastUpdatedAt;
    if (lastUpdated) {
      const timeSinceUpdate = now.getTime() - new Date(lastUpdated).getTime();
      if (timeSinceUpdate < USAGE_SYNC_INTERVAL_MS) {
        return result; // Updated recently, skip
      }
    }
  }

  // Sync usage
  const syncResult = await syncUsageToDraft(tx, customerId, draftInvoice.id, clock);

  if (syncResult.success) {
    result.operations.push({
      type: 'reconciliation',
      timestamp: now,
      description: `Usage sync: ${syncResult.lineItemsCount} service(s), $${(syncResult.totalUsageChargesCents / 100).toFixed(2)}`,
      success: true,
    });
  } else {
    result.operations.push({
      type: 'reconciliation',
      timestamp: now,
      description: `Usage sync failed: ${syncResult.error}`,
      success: false,
    });
    result.errors.push({
      type: 'database_error',
      message: syncResult.error || 'Unknown error',
      customerId,
      retryable: true,
    });
  }

  return result;
}

/**
 * Process billing for all customers
 *
 * Main entry point called periodically (every 5 minutes).
 * Processes each customer independently with proper locking.
 *
 * @param db Database instance
 * @param config Billing processor configuration
 * @param suiService Sui service for escrow operations
 * @returns Array of billing results (one per customer)
 */
export async function processBilling(
  db: Database,
  config: BillingProcessorConfig,
  suiService: ISuiService
): Promise<CustomerBillingResult[]> {
  // Get all active customers (we process all customers, even suspended ones, to handle payments)
  const allCustomers = await db
    .select({ customerId: customers.customerId })
    .from(customers);

  const results: CustomerBillingResult[] = [];

  // Process each customer sequentially (Phase 1B - single thread)
  for (const customer of allCustomers) {
    try {
      const result = await processCustomerBilling(
        db,
        customer.customerId,
        config,
        suiService
      );
      results.push(result);
    } catch (error) {
      // Log error but continue processing other customers
      results.push({
        customerId: customer.customerId,
        success: false,
        operations: [],
        errors: [
          {
            type: 'database_error',
            message: error instanceof Error ? error.message : 'Unknown error',
            customerId: customer.customerId,
            retryable: true,
          },
        ],
      });
    }
  }

  return results;
}

/**
 * Force sync usage to customer's DRAFT invoice (on-demand)
 *
 * This is the exported wrapper for syncUsageToCustomerDraft with force=true.
 * Used by test/dev endpoints to immediately sync usage after injecting data.
 *
 * Follows the same production code path but bypasses the hourly debounce.
 *
 * @param db Database instance
 * @param customerId Customer ID
 * @param clock DBClock for time reference
 * @returns Billing result
 */
export async function forceSyncUsageToDraft(
  db: Database,
  customerId: number,
  clock: DBClock
): Promise<CustomerBillingResult> {
  return await withCustomerLock(db, customerId, async (tx) => {
    return await syncUsageToCustomerDraft(tx, customerId, clock, true);
  });
}
