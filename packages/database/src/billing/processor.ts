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

import { eq, and, sql, inArray, desc, gt } from 'drizzle-orm';
import { billingRecords, customers, serviceInstances, invoicePayments, customerCredits } from '../schema';
import type { Database } from '../db';
import { withCustomerLock, type LockedTransaction } from './locking';
import { processInvoicePayment } from './payments';
import { getAvailableCredits } from './credits';
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
import { logInternalError, logInternalErrorOnce } from './admin-notifications';
import { applyScheduledTierChanges, processScheduledCancellations } from './tier-changes';
import { recalculateDraftInvoice } from './service-billing';
import { finalizeUsageChargesForBilling, syncUsageToDraft } from './usage-charges';
import type { BillingProcessorConfig, CustomerBillingResult, BillingOperation } from './types';
import type { DBClock } from '@suiftly/shared/db-clock';
import type { PaymentServices } from './providers';
import { getCustomerProviders } from './providers';
import { getTierPriceUsdCents } from '@suiftly/shared/pricing';
import type { ServiceTier } from '@suiftly/shared/constants';

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
 * @param services Sui service for escrow operations
 * @returns Result of billing operations
 */
export async function processCustomerBilling(
  db: Database,
  customerId: number,
  config: BillingProcessorConfig,
  services: PaymentServices
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
        services
      );
      result.operations.push(...monthlyResult.operations);
      result.errors.push(...monthlyResult.errors);
    }

    // Retry failed payments
    const retryResult = await retryFailedPayments(
      tx,
      customerId,
      config,
      services
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
 * @param services Sui service for escrow operations
 * @returns Billing result
 */
async function processMonthlyBilling(
  tx: LockedTransaction,
  customerId: number,
  config: BillingProcessorConfig,
  services: PaymentServices
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
      // Finalize usage charges for the PREVIOUS month (the month that just ended)
      // This is different from preview - we bill for completed usage, not future
      for (const invoice of draftInvoices) {
        const usageResult = await finalizeUsageChargesForBilling(tx, customerId, invoice.id, config.clock);
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

        // Build provider chain and attempt payment
        const providers = await getCustomerProviders(customerId, services, tx, config.clock);
        const paymentResult = await processInvoicePayment(
          tx,
          invoice.id,
          providers,
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

      // Process excess credit refunds when tier downgrade was applied
      if (tierChangesApplied > 0) {
        const refundResult = await processExcessCreditRefunds(
          tx,
          customerId,
          config,
          services
        );
        result.operations.push(...refundResult.operations);
        result.errors.push(...refundResult.errors);
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
 * Process excess credit refunds after tier downgrade
 *
 * When a customer downgrades (e.g., Enterprise $185 → Starter $9), the reconciliation
 * credit from the original tier can vastly exceed future charges. This function refunds
 * the excess back to the original Stripe payment.
 *
 * Key constraints:
 * - Only reconciliation credits are considered (not promo/goodwill/outage)
 * - Refund amount is capped at the original Stripe charge amount
 * - Refund is matched to the specific Stripe charge for traceability
 * - Leaves 1 month of subscription cost as credit buffer
 *
 * Conditions (all must be true):
 * - Customer has remaining reconciliation credits > current monthly subscription cost
 * - Original payment was via Stripe (has invoice_payments with sourceType='stripe')
 *
 * Retry safety: Stripe idempotency key (keyed on invoice+amount) prevents double-refund
 * if this function runs again after a partial failure. The DB transaction ensures credit
 * deduction and billing record creation are atomic with the refund.
 *
 * @param tx Transaction handle (must have customer lock)
 * @param customerId Customer ID
 * @param config Billing processor configuration
 * @param services Payment services
 * @returns Billing result with refund operations
 */
async function processExcessCreditRefunds(
  tx: LockedTransaction,
  customerId: number,
  config: BillingProcessorConfig,
  services: PaymentServices
): Promise<CustomerBillingResult> {
  const result: CustomerBillingResult = {
    customerId,
    success: true,
    operations: [],
    errors: [],
  };

  const now = config.clock.now();

  // Get remaining RECONCILIATION credits only (not promo/goodwill/outage).
  // This must match the credit type we deduct from below.
  const reconciliationCredits = await tx
    .select()
    .from(customerCredits)
    .where(
      and(
        eq(customerCredits.customerId, customerId),
        gt(customerCredits.remainingAmountUsdCents, 0),
        sql`(${customerCredits.expiresAt} IS NULL OR ${customerCredits.expiresAt} > ${now})`,
        eq(customerCredits.reason, 'reconciliation')
      )
    )
    .orderBy(sql`${customerCredits.expiresAt} NULLS LAST`);

  const availableReconciliationCredits = reconciliationCredits.reduce(
    (sum, c) => sum + Number(c.remainingAmountUsdCents), 0
  );

  if (availableReconciliationCredits <= 0) {
    return result;
  }

  // Get current monthly subscription cost
  const activeServices = await tx
    .select()
    .from(serviceInstances)
    .where(eq(serviceInstances.customerId, customerId));

  let monthlyCostCents = 0;
  for (const svc of activeServices) {
    if (!svc.cancellationScheduledFor) {
      monthlyCostCents += getTierPriceUsdCents(svc.tier as ServiceTier);
    }
  }

  // Only refund if reconciliation credits exceed monthly cost (leave 1 month buffer)
  if (availableReconciliationCredits <= monthlyCostCents) {
    return result;
  }

  // Find the most recent Stripe payment for this customer (the charge to refund against)
  const [stripePayment] = await tx
    .select()
    .from(invoicePayments)
    .innerJoin(billingRecords, eq(invoicePayments.billingRecordId, billingRecords.id))
    .where(
      and(
        eq(billingRecords.customerId, customerId),
        eq(invoicePayments.sourceType, 'stripe'),
      )
    )
    .orderBy(desc(invoicePayments.createdAt))
    .limit(1);

  if (!stripePayment) {
    return result; // No Stripe payment found — nothing to refund to
  }

  const stripeInvoiceId = stripePayment.invoice_payments.providerReferenceId;
  if (!stripeInvoiceId) {
    return result;
  }

  // Cap refund at the original Stripe charge amount — Stripe rejects refunds
  // exceeding the original charge. This also prevents refunding promo credits
  // that weren't paid via Stripe.
  const originalChargeAmountCents = Number(stripePayment.invoice_payments.amountUsdCents);
  const originalBillingRecordId = stripePayment.invoice_payments.billingRecordId;
  const excessCreditCents = availableReconciliationCredits - monthlyCostCents;
  const refundAmountCents = Math.min(excessCreditCents, originalChargeAmountCents);

  if (refundAmountCents <= 0) {
    return result;
  }

  // Issue refund via Stripe
  const stripeService = services.stripeService;
  const refundResult = await stripeService.refund({
    stripeInvoiceId,
    amountUsdCents: refundAmountCents,
    reason: `Excess credit refund after tier downgrade (original invoice #${originalBillingRecordId})`,
  });

  if (!refundResult.success) {
    result.errors.push({
      type: 'payment_failed',
      message: refundResult.error ?? 'Stripe refund failed',
      customerId,
      retryable: false, // Not retried — tier change trigger won't fire again; admin handles via STRIPE_REFUND_FAILED notification
    });

    // Notify admin — refund won't be retried next cycle (tier change already applied),
    // so the customer loses excess credit permanently without human intervention.
    await logInternalErrorOnce(tx, {
      severity: 'error',
      category: 'billing',
      code: 'STRIPE_REFUND_FAILED',
      message: `Stripe refund of $${(refundAmountCents / 100).toFixed(2)} failed for customer ${customerId}`,
      details: {
        refundAmountCents,
        stripeInvoiceId,
        originalBillingRecordId,
        error: refundResult.error,
      },
      customerId,
      invoiceId: originalBillingRecordId,
    });

    return result;
  }

  // Deduct refunded amount from reconciliation credits (oldest expiring first)
  let remaining = refundAmountCents;
  for (const credit of reconciliationCredits) {
    if (remaining <= 0) break;
    const deduction = Math.min(remaining, Number(credit.remainingAmountUsdCents));
    await tx
      .update(customerCredits)
      .set({ remainingAmountUsdCents: Number(credit.remainingAmountUsdCents) - deduction })
      .where(eq(customerCredits.creditId, credit.creditId));
    remaining -= deduction;
  }

  // Create a billing record documenting the refund, with traceability to original charge.
  // failureReason field is repurposed to store the refund→charge association for audit trail.
  const [refundRecord] = await tx
    .insert(billingRecords)
    .values({
      customerId,
      billingPeriodStart: now,
      billingPeriodEnd: now,
      amountUsdCents: refundAmountCents,
      amountPaidUsdCents: refundAmountCents,
      type: 'credit',
      status: 'paid',
      billingType: 'immediate',
      failureReason: `refund_of:${originalBillingRecordId}`,
    })
    .returning({ id: billingRecords.id });

  // Create invoice_payments row linking the refund to the original Stripe invoice.
  // providerReferenceId stores the Stripe refund ID (re_xxx) for Stripe-side correlation.
  await tx.insert(invoicePayments).values({
    billingRecordId: refundRecord.id,
    sourceType: 'stripe',
    providerReferenceId: refundResult.refundId ?? stripeInvoiceId,
    creditId: null,
    escrowTransactionId: null,
    amountUsdCents: refundAmountCents,
  });

  result.operations.push({
    type: 'reconciliation',
    timestamp: now,
    amountUsdCents: refundAmountCents,
    invoiceId: refundRecord.id,
    description: `Refunded $${(refundAmountCents / 100).toFixed(2)} excess credit to Stripe (against invoice #${originalBillingRecordId})`,
    success: true,
  });

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
 * @param services Sui service for escrow operations
 * @returns Billing result
 */
async function retryFailedPayments(
  tx: LockedTransaction,
  customerId: number,
  config: BillingProcessorConfig,
  services: PaymentServices
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

    // Build provider chain and attempt payment
    const providers = await getCustomerProviders(customerId, services, tx, config.clock);
    const paymentResult = await processInvoicePayment(
      tx,
      invoice.id,
      providers,
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

      // Notify admin when retries are exhausted (at most once per invoice).
      // retryCount was incremented by processInvoicePayment on failure.
      // Wrapped in try-catch: notification failure must not abort the billing run
      // (payment status is already updated, and subsequent operations like grace
      // period checks still need to run).
      const currentRetryCount = Number(invoice.retryCount ?? 0) + 1; // +1 for the attempt that just failed
      if (currentRetryCount >= config.maxRetryAttempts) {
        try {
          await logInternalErrorOnce(tx, {
            severity: 'error',
            category: 'billing',
            code: 'PAYMENT_RETRIES_EXHAUSTED',
            message: `All ${config.maxRetryAttempts} payment retries exhausted for invoice ${invoice.id}`,
            details: {
              lastError: paymentResult.error?.message,
              errorCode: paymentResult.error?.errorCode,
              amountUsdCents: Number(invoice.amountUsdCents),
              retryCount: currentRetryCount,
            },
            customerId,
            invoiceId: invoice.id,
          });
        } catch (notifErr) {
          console.error(`[Billing] Failed to create retry-exhausted notification for invoice ${invoice.id}:`, notifErr);
        }
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
 * @param services Sui service for escrow operations
 * @returns Array of billing results (one per customer)
 */
export async function processBilling(
  db: Database,
  config: BillingProcessorConfig,
  services: PaymentServices
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
        services
      );
      results.push(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const stack = error instanceof Error ? error.stack : undefined;

      // Log error but continue processing other customers
      results.push({
        customerId: customer.customerId,
        success: false,
        operations: [],
        errors: [
          {
            type: 'database_error',
            message,
            customerId: customer.customerId,
            retryable: true,
          },
        ],
      });

      // Notify admin with stack trace for debugging.
      // Uses logInternalError (not Once) since there's no specific invoiceId,
      // but billing runs every 5 minutes so repeated errors for the same customer
      // will create multiple notifications. This is acceptable — persistent errors
      // SHOULD be noisy.
      try {
        await logInternalError(db, {
          severity: 'error',
          category: 'billing',
          code: 'BILLING_PROCESSOR_EXCEPTION',
          message: `Billing processor crashed for customer ${customer.customerId}: ${message}`,
          details: { stack },
          customerId: customer.customerId,
        });
      } catch {
        // Don't let notification failure prevent processing other customers
        console.error(`[Billing] Failed to create admin notification for customer ${customer.customerId}`);
      }
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
