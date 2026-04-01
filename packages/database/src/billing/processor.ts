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

import { eq, and, sql, inArray, desc, gt, lte } from 'drizzle-orm';
import { billingRecords, customers, serviceInstances, invoicePayments, customerCredits } from '../schema';
import type { Database } from '../db';
import { withCustomerLock, type LockedTransaction } from './locking';
import { processInvoicePayment, finalizeSuccessfulPayment, retryUnpaidInvoices } from './payments';
import { getAvailableCredits, issueCredit } from './credits';
import {
  startGracePeriod,
  getCustomersWithExpiredGracePeriod,
  suspendCustomerForNonPayment,
  resumeCustomerAccount,
} from './grace-period';
import { withIdempotency, generateMonthlyBillingKey } from './idempotency';
import { ensureInvoiceValid } from './validation';
import { ValidationError } from './errors';
import { voidInvoice, createInvoice, deleteUnpaidInvoice } from './invoices';
import { logInternalError, logInternalErrorOnce } from './admin-notifications';
import { applyScheduledTierChanges, processScheduledCancellations } from './tier-changes';
import { recalculateDraftInvoice } from './draft-invoice';
import { finalizeUsageChargesForBilling, syncUsageToDraft } from './usage-charges';
import type { BillingProcessorConfig, CustomerBillingResult, BillingOperation } from './types';
import type { DBClock } from '@suiftly/shared/db-clock';
import type { PaymentServices } from './providers';
import { getCustomerProviders } from './providers';
import { getTierPriceUsdCents } from '@suiftly/shared/pricing';
import type { ServiceTier, ServiceType } from '@suiftly/shared/constants';

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
    } else {
      // Catch-up: check for DRAFTs whose billing period has started (missed billing day).
      // This handles the case where the processor was down on the 1st.
      // processMonthlyBilling has idempotency protection, so if billing already ran
      // for this month, the catch-up is a no-op.
      const staleDraft = await tx.query.billingRecords.findFirst({
        where: and(
          eq(billingRecords.customerId, customerId),
          eq(billingRecords.status, 'draft'),
          lte(billingRecords.billingPeriodStart, now),
        ),
      });
      if (staleDraft) {
        const monthlyResult = await processMonthlyBilling(tx, customerId, config, services);
        result.operations.push(...monthlyResult.operations);
        result.errors.push(...monthlyResult.errors);

        // If the stale DRAFT was for a month BEFORE the current month, we need
        // to also create a DRAFT for the current month. Without this, the current
        // month is permanently skipped: recalculateDraftInvoice (called inside
        // processMonthlyBilling) creates a DRAFT for "next month from today",
        // which is the month AFTER current — leaving a billing gap.
        //
        // Example: processor down on Jan 1, catches up Feb 5.
        //   - January DRAFT processed ✓
        //   - recalculateDraftInvoice creates March DRAFT (next month from Feb 5)
        //   - February has no DRAFT — permanently unbilled!
        //
        // The fix: explicitly create a February DRAFT. The next billing run
        // (5 min later) finds it stale and processes it via this same catch-up path.
        const stalePeriodStart = new Date(staleDraft.billingPeriodStart);
        const currentMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));

        if (stalePeriodStart < currentMonthStart) {
          // Check if a DRAFT already exists for the current month
          const currentMonthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
          const existingCurrentDraft = await tx.query.billingRecords.findFirst({
            where: and(
              eq(billingRecords.customerId, customerId),
              eq(billingRecords.status, 'draft'),
              sql`${billingRecords.billingPeriodStart} >= ${currentMonthStart}
                AND ${billingRecords.billingPeriodStart} <= ${currentMonthEnd}`,
            ),
          });

          if (!existingCurrentDraft) {
            // Delete premature future-month DRAFTs created by recalculateDraftInvoice
            // during the stale DRAFT processing. The system expects at most one DRAFT
            // per customer; having two causes MULTIPLE_DRAFT_INVOICES validation failures.
            // These will be recreated correctly after the current month is processed.
            const futureDrafts = await tx.query.billingRecords.findMany({
              where: and(
                eq(billingRecords.customerId, customerId),
                eq(billingRecords.status, 'draft'),
                sql`${billingRecords.billingPeriodStart} > ${currentMonthEnd}`,
              ),
            });
            for (const draft of futureDrafts) {
              await deleteUnpaidInvoice(tx, draft.id);
            }

            const currentMonthLastDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
            await createInvoice(tx, {
              customerId,
              amountUsdCents: 0, // recalculateDraftInvoice in processMonthlyBilling will populate
              type: 'charge',
              status: 'draft',
              description: 'Monthly subscription charges',
              billingPeriodStart: currentMonthStart,
              billingPeriodEnd: currentMonthLastDay,
              dueDate: currentMonthStart,
            }, config.clock);
          }
        }
      }
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

  // Find DRAFT invoices for this customer whose billing period has started.
  // The date filter prevents premature billing of future-month DRAFTs that can
  // exist when catch-up creates the current month's DRAFT while
  // recalculateDraftInvoice already created next month's DRAFT.
  const draftInvoices = await tx.query.billingRecords.findMany({
    where: and(
      eq(billingRecords.customerId, customerId),
      eq(billingRecords.status, 'draft'),
      lte(billingRecords.billingPeriodStart, config.clock.now()),
    ),
  });

  if (draftInvoices.length === 0) {
    return result; // No draft invoices, nothing to do
  }

  // Derive idempotency key from the DRAFT's billing period, NOT from today's date.
  // This is critical for catch-up billing: if a stale January DRAFT is processed
  // on February 1st, the key must be monthly-X-2025-01 (January's key), not
  // monthly-X-2025-02 (which would consume February's slot and skip February billing).
  const billingPeriodStart = new Date(draftInvoices[0].billingPeriodStart);
  const year = billingPeriodStart.getUTCFullYear();
  const month = billingPeriodStart.getUTCMonth() + 1; // JavaScript months are 0-indexed

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

      // Ensure all DRAFTs have up-to-date line items and amounts.
      // This is critical for catch-up DRAFTs which are created bare ($0, no line items)
      // by the catch-up code in processCustomerBilling. Without this, the amount check
      // below sees $0 and voids the DRAFT — skipping the entire billing month.
      // Safe: recalculateDraftInvoice is idempotent, so this is a no-op for DRAFTs
      // that were already populated by tier changes or cancellations above.
      await recalculateDraftInvoice(tx, customerId, config.clock);

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

        // Re-read amount after tier changes and cancellations recalculated the DRAFT.
        // Skip $0 invoices — transitioning and "paying" a $0 invoice incorrectly
        // sets paidOnce=true via finalizeSuccessfulPayment.
        const [freshInvoice] = await tx
          .select({ amountUsdCents: billingRecords.amountUsdCents })
          .from(billingRecords)
          .where(eq(billingRecords.id, invoice.id))
          .limit(1);
        const currentAmount = Number(freshInvoice?.amountUsdCents ?? 0);
        if (currentAmount <= 0) {
          // Void the $0 DRAFT — nothing to charge
          await voidInvoice(tx, invoice.id, 'No charges for this billing period');
          continue;
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

          // Shared finalization: set customer paidOnce, clear grace period,
          // recalculate DRAFT for upcoming month, and issue reconciliation credit
          // if any service's subPendingInvoiceId matches this invoice.
          //
          // NOTE: We do NOT blanket-set paidOnce/subPendingInvoiceId on all services.
          // A monthly billing invoice is a separate charge from initial subscription
          // invoices. Clearing subPendingInvoiceId here would break reconciliation
          // credits: when the initial invoice is later retried and paid,
          // finalizeSuccessfulPayment wouldn't find the pending service and would
          // skip the credit. Each service's gate clears only when its own initial
          // invoice (subPendingInvoiceId) is actually paid.
          await finalizeSuccessfulPayment(tx, customerId, invoice.id, config.clock);
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

            await logInternalError(tx, {
              severity: 'warning',
              category: 'billing',
              code: 'GRACE_PERIOD_STARTED',
              message: `Customer ${customerId} entered 14-day grace period after payment failure`,
              details: { invoiceId: invoice.id, amount: Number(invoice.amountUsdCents) },
              customerId,
              invoiceId: invoice.id,
            });
          }
        }
      }

      // Ensure a DRAFT exists for the next billing cycle.
      // The success path creates one via finalizeSuccessfulPayment, but the failure
      // path does not. Without this, a failed month means no DRAFT exists, and the
      // next 1st of month skips billing entirely (processMonthlyBilling line 164).
      // Safe: recalculateDraftInvoice is idempotent — if a DRAFT already exists
      // (success path already created one), it just recalculates it.
      try {
        await recalculateDraftInvoice(tx, customerId, config.clock);
      } catch (err) {
        console.error(`[processMonthlyBilling] Failed to create next DRAFT for customer ${customerId}:`, err);
      }

      // Process excess credit refunds. Idempotent — safe to call every billing cycle.
      const refundResult = await processExcessCreditRefunds(
        tx,
        customerId,
        config,
        services
      );
      result.operations.push(...refundResult.operations);
      result.errors.push(...refundResult.errors);

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
 * Process excess credit refunds when reconciliation credits exceed future obligations
 *
 * When a customer downgrades or cancels, the reconciliation credit from the original
 * tier can vastly exceed future charges. This function refunds the excess back to the
 * original Stripe payment. Idempotent — safe to call every billing cycle.
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
    // Skip cancelled services: cancellationScheduledFor is set during the month,
    // then cleared by processScheduledCancellations on the 1st (which sets state='cancellation_pending')
    if (!svc.cancellationScheduledFor && svc.state !== 'cancellation_pending') {
      monthlyCostCents += getTierPriceUsdCents(svc.tier as ServiceTier, svc.serviceType as ServiceType);
    }
  }

  // Account for outstanding unpaid invoices — don't refund credits needed to pay them
  const [unpaidTotal] = await tx
    .select({ total: sql<number>`COALESCE(SUM(amount_usd_cents - COALESCE(amount_paid_usd_cents, 0)), 0)` })
    .from(billingRecords)
    .where(
      and(
        eq(billingRecords.customerId, customerId),
        inArray(billingRecords.status, ['pending', 'failed']),
      )
    );
  const unpaidAmountCents = Number(unpaidTotal?.total ?? 0);
  const reserveAmountCents = monthlyCostCents + unpaidAmountCents;

  // Only refund if reconciliation credits exceed reserve (monthly cost + unpaid invoices)
  if (availableReconciliationCredits <= reserveAmountCents) {
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
  const excessCreditCents = availableReconciliationCredits - reserveAmountCents;
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
      retryable: false, // Not retried within this billing run; will auto-retry next cycle (credits remain until refund succeeds)
    });

    // Notify admin — will auto-retry next billing cycle but flag for visibility.
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
 * Thin wrapper around retryUnpaidInvoices with periodic retry limits.
 * Converts detailed results to BillingOperations and notifies admin
 * when retries are exhausted.
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
  const providers = await getCustomerProviders(customerId, services, tx, config.clock);

  // Skip retries when customer has no payment methods AND no credits.
  // Without this guard, each periodic cycle would increment retryCount until
  // maxRetryAttempts is exhausted, stranding the invoice and spamming alerts.
  // But if credits exist, proceed — processInvoicePayment applies credits first.
  if (providers.length === 0) {
    const availableCredits = await getAvailableCredits(tx, customerId, config.clock);
    if (availableCredits <= 0) {
      // Check if there are actually failed invoices being skipped.
      // If so, emit an operation and a one-time notification so ops can see
      // non-paying accounts with outstanding debt (instead of silent skipping).
      const failedInvoices = await tx
        .select({
          count: sql<number>`COUNT(*)`,
          totalCents: sql<number>`COALESCE(SUM(amount_usd_cents - COALESCE(amount_paid_usd_cents, 0)), 0)`,
          firstId: sql<number>`MIN(id)`,
        })
        .from(billingRecords)
        .where(
          and(
            eq(billingRecords.customerId, customerId),
            eq(billingRecords.status, 'failed'),
          )
        );
      const failedCount = Number(failedInvoices[0]?.count ?? 0);
      const failedTotalCents = Number(failedInvoices[0]?.totalCents ?? 0);
      const firstFailedInvoiceId = Number(failedInvoices[0]?.firstId ?? 0);

      if (failedCount > 0) {
        result.operations.push({
          type: 'payment_retry',
          timestamp: now,
          amountUsdCents: failedTotalCents,
          description: `Skipped retry: ${failedCount} failed invoice(s) ($${(failedTotalCents / 100).toFixed(2)}) — no payment methods and no credits`,
          success: false,
        });

        try {
          await logInternalErrorOnce(tx, {
            severity: 'warning',
            category: 'billing',
            code: 'NO_PAYMENT_METHODS_FOR_RETRY',
            message: `Customer ${customerId} has ${failedCount} failed invoice(s) totalling $${(failedTotalCents / 100).toFixed(2)} but no payment methods or credits`,
            details: { failedCount, failedTotalCents },
            customerId,
            invoiceId: firstFailedInvoiceId,
          });
        } catch { /* don't let notification failure block billing */ }
      }

      return result;
    }
  }

  const retryResult = await retryUnpaidInvoices(tx, customerId, providers, config.clock, {
    maxRetries: config.maxRetryAttempts,
    cooldownHours: config.retryIntervalHours,
    clock: config.clock,
  });

  for (const detail of retryResult.details) {
    if (detail.paid) {
      result.operations.push({
        type: 'payment_retry',
        timestamp: now,
        amountUsdCents: detail.amountCents,
        invoiceId: detail.invoiceId,
        description: `Payment retry successful`,
        success: true,
      });
    } else {
      result.operations.push({
        type: 'payment_retry',
        timestamp: now,
        amountUsdCents: detail.amountCents,
        invoiceId: detail.invoiceId,
        description: `Payment retry failed: ${detail.error?.message}`,
        success: false,
      });

      if (detail.error) {
        result.errors.push(detail.error);
      }

      // Notify admin when retries are exhausted (at most once per invoice).
      // retryCount was incremented by processInvoicePayment on failure.
      const currentRetryCount = detail.previousRetryCount + 1;
      if (currentRetryCount >= config.maxRetryAttempts) {
        try {
          await logInternalErrorOnce(tx, {
            severity: 'error',
            category: 'billing',
            code: 'PAYMENT_RETRIES_EXHAUSTED',
            message: `All ${config.maxRetryAttempts} payment retries exhausted for invoice ${detail.invoiceId}`,
            details: {
              lastError: detail.error?.message,
              errorCode: detail.error?.errorCode,
              amountUsdCents: detail.amountCents,
              retryCount: currentRetryCount,
            },
            customerId,
            invoiceId: detail.invoiceId,
          });
        } catch (notifErr) {
          console.error(`[Billing] Failed to create retry-exhausted notification for invoice ${detail.invoiceId}:`, notifErr);
        }

        // Restore credits consumed by this abandoned invoice.
        // Credits were applied by applyCreditsToInvoice but the invoice was never
        // paid. Without restoration, the customer loses real credit balance.
        //
        // IMPORTANT: We must also reverse the invoice's credit payment records
        // and reset amountPaidUsdCents. Otherwise, if a reactive retry later runs
        // (e.g., customer adds a payment method), the invoice still shows the old
        // credits as "applied" (amountPaidUsdCents > 0), so remainingAmount is too
        // low. Combined with the restored credit being available again, the customer
        // gets double-credited — the old applied amount reduces the invoice AND the
        // restored credit applies fresh.
        try {
          const creditPayments = await tx
            .select({ total: sql<number>`COALESCE(SUM(amount_usd_cents), 0)` })
            .from(invoicePayments)
            .where(
              and(
                eq(invoicePayments.billingRecordId, detail.invoiceId),
                eq(invoicePayments.sourceType, 'credit'),
              )
            );
          const creditAmount = Number(creditPayments[0]?.total ?? 0);
          if (creditAmount > 0) {
            // ORDER MATTERS: Issue compensating credit FIRST, before modifying
            // the invoice. If issueCredit fails and the catch swallows the error,
            // we haven't touched the invoice — no partial state. If we deleted
            // invoice_payments first and issueCredit then failed, the customer
            // would permanently lose their credits.
            //
            // 1. Issue compensating credit so customer's balance is restored
            await issueCredit(
              tx, customerId, creditAmount, 'reconciliation',
              `Credit restoration: retries exhausted for invoice ${detail.invoiceId}`,
            );

            // 2. Delete credit invoice_payments rows so they don't count on retry
            await tx.delete(invoicePayments)
              .where(
                and(
                  eq(invoicePayments.billingRecordId, detail.invoiceId),
                  eq(invoicePayments.sourceType, 'credit'),
                )
              );

            // 3. Reset amountPaidUsdCents by subtracting the reversed credits
            const [invoiceRow] = await tx
              .select({ amountPaidUsdCents: billingRecords.amountPaidUsdCents })
              .from(billingRecords)
              .where(eq(billingRecords.id, detail.invoiceId))
              .limit(1);
            const currentPaid = Number(invoiceRow?.amountPaidUsdCents ?? 0);
            const adjustedPaid = Math.max(0, currentPaid - creditAmount);

            await tx
              .update(billingRecords)
              .set({ amountPaidUsdCents: adjustedPaid })
              .where(eq(billingRecords.id, detail.invoiceId));
          }
        } catch (creditErr) {
          console.error(`[Billing] Failed to restore credits for exhausted invoice ${detail.invoiceId}:`, creditErr);
        }
      }
    }
  }

  // Recalculate DRAFT invoice after retries to reflect newly-paid invoices.
  // Non-fatal: stale DRAFT will self-correct on next billing cycle.
  if (retryResult.paidCount > 0) {
    try {
      await recalculateDraftInvoice(tx, customerId, config.clock);
    } catch (err) {
      console.error(`[Billing] Failed to recalculate DRAFT after payment retry for customer ${customerId}:`, err);
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

    await logInternalError(tx, {
      severity: 'error',
      category: 'billing',
      code: 'CUSTOMER_SUSPENDED',
      message: `Customer ${customerId} suspended for non-payment — ${serviceCount} services disabled`,
      details: { serviceCount },
      customerId,
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
