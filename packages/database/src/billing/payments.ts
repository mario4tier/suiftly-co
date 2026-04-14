/**
 * Invoice Payment Processing
 *
 * Handles multi-source payment application to invoices:
 * 1. Apply credits first (oldest expiring first)
 * 2. Charge remaining via provider chain (user's priority order)
 *
 * Credits are NOT rolled back if provider charge fails (see BILLING_DESIGN.md).
 */

import { eq, and, or, sql, asc } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../db';
import type { LockedTransaction } from './locking';
import { billingRecords, invoicePayments, customers } from '../schema';
import { applyCreditsToInvoice, issueReconciliationCredit, issueCredit } from './credits';
import { clearGracePeriod } from './grace-period';
import { recalculateDraftInvoice } from './draft-invoice';
import { logInternalError } from './admin-notifications';
import { getStripeService } from '../stripe-mock/index.js';
import type { InvoicePaymentResult, BillingError } from './types';
import type { DBClock } from '@suiftly/shared/db-clock';
import type { IPaymentProvider } from '@suiftly/shared/payment-provider';

/**
 * Retry backoff schedule for failed invoices (seconds between attempts).
 * Covers ~72 hours total — enough for transient outages (Sui down, Stripe down).
 * The reactive path (deposit, add card) bypasses this and retries immediately.
 */
export const RETRY_BACKOFF_SECONDS = [5, 60, 300, 600, 3000, 7200, 21600, 43200, 86400];
export const MAX_RETRY_ATTEMPTS = RETRY_BACKOFF_SECONDS.length;

/**
 * Process payment for an invoice using credits + provider chain
 *
 * Payment order (per PAYMENT_DESIGN.md):
 * 1. Credits (oldest expiring first) - off-chain, not rolled back
 * 2. Provider chain in user's priority order - auto-fallback to next on failure
 *
 * @param tx Transaction handle (must have customer lock)
 * @param billingRecordId Invoice ID to pay
 * @param providers Payment providers in user's priority order
 * @param clock DBClock for timestamps
 * @returns Payment result with success/failure details
 */
export async function processInvoicePayment(
  tx: LockedTransaction,
  billingRecordId: number,
  providers: IPaymentProvider[],
  clock: DBClock
): Promise<InvoicePaymentResult> {
  // Get invoice details
  const [invoice] = await tx
    .select()
    .from(billingRecords)
    .where(eq(billingRecords.id, billingRecordId))
    .limit(1);

  if (!invoice) {
    return {
      invoiceId: billingRecordId,
      initialAmountCents: 0,
      amountPaidCents: 0,
      fullyPaid: false,
      paymentSources: [],
      error: {
        type: 'validation_error',
        message: 'Invoice not found',
        customerId: 0,
        invoiceId: billingRecordId,
        retryable: false,
      },
    };
  }

  // Guard: voided invoices should never be processed
  if (invoice.status === 'voided') {
    return {
      invoiceId: billingRecordId,
      initialAmountCents: Number(invoice.amountUsdCents),
      amountPaidCents: Number(invoice.amountPaidUsdCents ?? 0),
      fullyPaid: false,
      paymentSources: [],
      error: {
        type: 'validation_error',
        message: 'Invoice has been voided',
        customerId: invoice.customerId,
        invoiceId: billingRecordId,
        retryable: false,
      },
    };
  }

  const customerId = invoice.customerId;
  const totalAmount = Number(invoice.amountUsdCents);
  const alreadyPaid = Number(invoice.amountPaidUsdCents ?? 0);
  const remainingAmount = totalAmount - alreadyPaid;

  const result: InvoicePaymentResult = {
    invoiceId: billingRecordId,
    initialAmountCents: totalAmount,
    amountPaidCents: alreadyPaid,
    fullyPaid: alreadyPaid >= totalAmount,
    paymentSources: [],
  };

  // If already paid (e.g., credits exceeded invoice after recalculation), finalize
  if (result.fullyPaid) {
    // If invoice is already marked paid, this is a redundant call — return early
    // without issuing duplicate overpayment credits.
    if (invoice.status === 'paid') {
      return result;
    }

    // Mark the invoice as paid (can happen when recalculateFailedInvoiceSubscription
    // lowers amountUsdCents below amountPaidUsdCents on a FAILED invoice with
    // partially-applied credits)
    await tx
      .update(billingRecords)
      .set({ status: 'paid', failureReason: null, paymentActionUrl: null, pendingStripeInvoiceId: null })
      .where(eq(billingRecords.id, billingRecordId));

    // Issue a reconciliation credit for any overpayment
    const overpaymentCents = alreadyPaid - totalAmount;
    if (overpaymentCents > 0) {
      await issueCredit(
        tx,
        customerId,
        overpaymentCents,
        'reconciliation',
        `Overpayment refund: invoice ${billingRecordId} reduced to ${totalAmount} cents after tier change (was ${alreadyPaid} cents paid)`,
      );
    }

    return result;
  }

  // Step 1: Apply credits
  const creditResult = await applyCreditsToInvoice(
    tx,
    customerId,
    billingRecordId,
    remainingAmount,
    clock
  );

  // Record credits applied
  for (const credit of creditResult.creditsApplied) {
    result.paymentSources.push({
      type: 'credit',
      amountCents: credit.amountUsedCents,
      referenceId: String(credit.creditId),
    });
  }

  result.amountPaidCents += creditResult.totalAppliedCents;

  // Update invoice with credits applied
  await tx
    .update(billingRecords)
    .set({ amountPaidUsdCents: result.amountPaidCents })
    .where(eq(billingRecords.id, billingRecordId));

  // Step 2: Charge remaining via provider chain
  if (creditResult.remainingInvoiceAmountCents > 0) {
    let charged = false;
    let lastError: BillingError | undefined;
    // Track whether a provider set a paymentActionUrl (3DS hosted page).
    // When present, the invoice should stay pending so the customer can
    // complete verification — not marked failed with retry counter.
    let hasActionUrl = false;
    // Track Stripe invoice ID from a requires_action result so we can void it
    // if a subsequent provider succeeds (prevents double charge on late 3DS).
    // Initialize from the persisted value (survives across separate payment attempts).
    let pendingStripeInvoiceId: string | undefined = invoice.pendingStripeInvoiceId ?? undefined;

    for (const provider of providers) {
      if (!await provider.canPay(customerId, creditResult.remainingInvoiceAmountCents)) {
        // Record why this provider was skipped (e.g., "Insufficient escrow balance")
        // so the final error message is specific, not generic "No payment method available"
        lastError = {
          type: 'payment_failed',
          message: `${provider.type}: insufficient funds`,
          customerId,
          invoiceId: billingRecordId,
          retryable: true,
        };
        continue;
      }

      const chargeResult = await provider.charge({
        customerId,
        amountUsdCents: creditResult.remainingInvoiceAmountCents,
        invoiceId: billingRecordId,
        description: `Invoice ${billingRecordId}`,
        retryCount: Number(invoice.retryCount ?? 0),
      });

      if (chargeResult.success) {
        if (!chargeResult.referenceId) {
          throw new Error(`Provider ${provider.type} returned success without referenceId for invoice ${billingRecordId}`);
        }

        // Create invoice_payments row (processInvoicePayment's responsibility)
        await tx.insert(invoicePayments).values({
          billingRecordId,
          sourceType: provider.type,
          // For escrow: set escrowTransactionId from referenceId
          // For stripe/paypal: set providerReferenceId from referenceId
          ...(provider.type === 'escrow'
            ? { escrowTransactionId: Number(chargeResult.referenceId), creditId: null, providerReferenceId: null }
            : { providerReferenceId: chargeResult.referenceId, creditId: null, escrowTransactionId: null }),
          amountUsdCents: creditResult.remainingInvoiceAmountCents,
        });

        result.paymentSources.push({
          type: provider.type,
          amountCents: creditResult.remainingInvoiceAmountCents,
          referenceId: chargeResult.referenceId,
        });

        result.amountPaidCents += creditResult.remainingInvoiceAmountCents;
        result.fullyPaid = true;
        charged = true;

        // Update billing_records with status + txDigest (escrow-only, NULL for others)
        // Clear paymentActionUrl: if a previous provider (e.g. Stripe) returned a 3DS URL
        // but failed, and this provider succeeded, the stale URL must be cleared to prevent
        // the customer from completing 3DS and being double-charged.
        await tx
          .update(billingRecords)
          .set({
            amountPaidUsdCents: result.amountPaidCents,
            status: 'paid',
            txDigest: chargeResult.txDigest ?? null, // Only escrow sets this
            paymentActionUrl: null,
            pendingStripeInvoiceId: null,
            failureReason: null,
          })
          .where(eq(billingRecords.id, billingRecordId));

        // If Stripe was attempted before this provider and left a pending 3DS invoice,
        // void it to prevent the customer from completing 3DS and being double-charged.
        // Fire-and-forget: the auto-refund in handleInvoicePaid is the safety net.
        if (pendingStripeInvoiceId && provider.type !== 'stripe') {
          try {
            const stripeService = getStripeService();
            await stripeService.voidInvoice(pendingStripeInvoiceId);
          } catch (voidErr) {
            // Non-fatal — the auto-refund in webhook handler is the safety net
            try {
              await logInternalError(tx, {
                severity: 'warning',
                category: 'billing',
                code: 'STRIPE_VOID_FAILED',
                message: `Failed to void Stripe invoice ${pendingStripeInvoiceId} after ${provider.type} paid invoice ${billingRecordId}`,
                details: { error: voidErr instanceof Error ? voidErr.message : String(voidErr), pendingStripeInvoiceId },
                customerId,
                invoiceId: billingRecordId,
              });
            } catch { /* don't let notification failure break payment flow */ }
          }
        }

        break;
      }

      // Persist paymentActionUrl and Stripe invoice ID for 3DS flow
      if (chargeResult.hostedInvoiceUrl) {
        await tx
          .update(billingRecords)
          .set({
            paymentActionUrl: chargeResult.hostedInvoiceUrl,
            pendingStripeInvoiceId: chargeResult.stripeInvoiceId ?? null,
          })
          .where(eq(billingRecords.id, billingRecordId));
        hasActionUrl = true;
        // Track the Stripe invoice ID for potential voiding if a later provider succeeds
        if (chargeResult.stripeInvoiceId) {
          pendingStripeInvoiceId = chargeResult.stripeInvoiceId;
        }
      }

      // Provider failed — record error, try next
      lastError = {
        type: 'payment_failed',
        message: chargeResult.error ?? `${provider.type} charge failed`,
        customerId,
        invoiceId: billingRecordId,
        retryable: chargeResult.retryable,
        errorCode: chargeResult.errorCode,
      };
    }

    if (!charged) {
      result.error = lastError ?? {
        type: 'payment_failed',
        message: 'No payment method available',
        customerId,
        invoiceId: billingRecordId,
        retryable: false,
      };

      if (hasActionUrl) {
        // 3DS challenge pending with a hosted URL the customer can visit.
        // Keep invoice as 'pending' so the customer can complete verification.
        // The invoice.paid webhook will reconcile when the customer completes 3DS.
        result.requiresAction = true;
        //
        // Increment retryCount to ensure a fresh Stripe idempotency key if the
        // customer adds a new card and triggers a reactive retry. Without this,
        // the retry reuses the same key (e.g. `inv_X_stripe_r0`) and Stripe
        // returns the cached requires_action result instead of charging the new card.
        // Safe: the periodic processor only retries 'failed' invoices (not 'pending'),
        // so this doesn't affect periodic retry limits.
        await tx
          .update(billingRecords)
          .set({
            status: 'pending',
            failureReason: 'Customer action required (3D Secure verification)',
            retryCount: sql`COALESCE(${billingRecords.retryCount}, 0) + 1`,
          })
          .where(eq(billingRecords.id, billingRecordId));
      } else {
        // Hard failure — mark as failed and increment retry count
        await tx
          .update(billingRecords)
          .set({
            status: 'failed',
            failureReason: result.error.message,
            retryCount: sql`COALESCE(${billingRecords.retryCount}, 0) + 1`,
            lastRetryAt: clock.now(),
          })
          .where(eq(billingRecords.id, billingRecordId));
      }
    }
  } else {
    // Fully paid with credits alone
    result.fullyPaid = true;
    await tx
      .update(billingRecords)
      .set({ status: 'paid', failureReason: null, paymentActionUrl: null, pendingStripeInvoiceId: null })
      .where(eq(billingRecords.id, billingRecordId));
  }

  return result;
}

/**
 * Finalize a successful payment: clear pending state, set paidOnce, clear grace period,
 * issue reconciliation credit, and recalculate DRAFT invoice.
 *
 * Called after any path confirms an invoice is paid:
 * - processInvoicePayment (provider chain succeeded)
 * - Stripe webhook (invoice.paid from 3DS completion)
 * - retryUnpaidInvoices (background retry succeeded)
 *
 * @param tx Transaction handle (must have customer lock)
 * @param customerId Customer ID
 * @param billingRecordId The paid invoice ID
 * @param clock DBClock for DRAFT recalculation timestamps
 */
export async function finalizeSuccessfulPayment(
  tx: LockedTransaction,
  customerId: number,
  billingRecordId: number,
  clock: DBClock,
): Promise<void> {
  // 1. Clear pendingInvoiceId + set paidOnce on customer if this invoice matches
  const [customer] = await tx
    .select({ pendingInvoiceId: customers.pendingInvoiceId })
    .from(customers)
    .where(eq(customers.customerId, customerId))
    .limit(1);

  const hasPendingInvoice = customer?.pendingInvoiceId === billingRecordId;

  if (hasPendingInvoice) {
    await tx.update(customers)
      .set({ pendingInvoiceId: null, paidOnce: true })
      .where(eq(customers.customerId, customerId));
  } else {
    // 2. Set paidOnce on customer (enables grace period on future payment failures)
    await tx.update(customers)
      .set({ paidOnce: true })
      .where(eq(customers.customerId, customerId));
  }

  // 3. Clear grace period (customer may have been suspended due to previous failure)
  await clearGracePeriod(tx, customerId);

  // 4. Issue reconciliation credit for partial month (deferred subscription payment).
  //    Only for invoices linked to a pending customer invoice — avoids minting credits for
  //    non-subscription invoices (usage, add-on) that have no linked pending invoice.
  // TODO: When Stripe 3DS tier upgrades are implemented, add deferred tier upgrade
  // finalization here. Use invoice metadata or a dedicated column to identify the
  // target tier — do NOT parse line item descriptions. See tier-changes.ts TODO.
  if (hasPendingInvoice) {
    const [invoice] = await tx
      .select()
      .from(billingRecords)
      .where(eq(billingRecords.id, billingRecordId))
      .limit(1);

    if (invoice) {
      await issueReconciliationCredit(
        tx, customerId, invoice, 'platform',
      );
    }
  }

  // 5. Recalculate DRAFT invoice to reflect the newly-paid invoice.
  //    Non-fatal: a stale DRAFT will self-correct on the next billing cycle.
  try {
    await recalculateDraftInvoice(tx, customerId, clock);
  } catch (err) {
    console.error(`[finalizeSuccessfulPayment] Failed to recalculate DRAFT for customer ${customerId}:`, err);
    try {
      await logInternalError(tx, {
        severity: 'warning',
        category: 'billing',
        code: 'DRAFT_RECALC_FAILED',
        message: `DRAFT recalculation failed after payment for customer ${customerId}`,
        details: { error: err instanceof Error ? err.message : String(err), billingRecordId },
        customerId,
        invoiceId: billingRecordId,
      });
    } catch { /* don't let notification failure break payment flow */ }
  }
}

/**
 * Get total amount paid for an invoice from all sources
 *
 * @param tx Transaction handle
 * @param billingRecordId Invoice ID
 * @returns Total amount paid in cents
 */
export async function getInvoicePaidAmount(
  tx: DatabaseOrTransaction,
  billingRecordId: number
): Promise<number> {
  const payments = await tx
    .select({ total: sql<number>`COALESCE(SUM(${invoicePayments.amountUsdCents}), 0)` })
    .from(invoicePayments)
    .where(eq(invoicePayments.billingRecordId, billingRecordId));

  return Number(payments[0]?.total ?? 0);
}

/**
 * Per-invoice detail from retryUnpaidInvoices
 */
export interface RetryInvoiceDetail {
  invoiceId: number;
  amountCents: number;
  paid: boolean;
  error?: BillingError;
  /** retryCount BEFORE this attempt (for exhaustion checks) */
  previousRetryCount: number;
}

/**
 * Optional retry limits for periodic billing (ignored for reactive retries).
 */
export interface RetryLimits {
  /** Only retry invoices with retryCount < maxRetries */
  maxRetries: number;
  /** Only retry invoices where lastRetryAt is older than this many hours */
  cooldownHours: number;
  /** Clock for cooldown calculation */
  clock: DBClock;
}

/**
 * Retry unpaid invoices for a customer.
 *
 * Single implementation used by both:
 * - Periodic billing processor — with limits (maxRetries, cooldown)
 * - Reactive triggers (webhook, deposit) — without limits
 *
 * When limits are provided, only retries 'failed' invoices within the limits.
 * When limits are omitted, retries all 'pending' and 'failed' invoices.
 *
 * Must be called within a customer lock (LockedTransaction).
 */
export async function retryUnpaidInvoices(
  tx: LockedTransaction,
  customerId: number,
  providers: IPaymentProvider[],
  clock: DBClock,
  limits?: RetryLimits,
): Promise<{ paidCount: number; failedCount: number; details: RetryInvoiceDetail[] }> {
  let unpaidInvoices;

  if (limits) {
    // Periodic: retry only 'failed' invoices with escalating backoff.
    //
    // 'pending' invoices are NOT retried periodically — they represent
    // "waiting for customer action" (deposit funds, add card). The reactive
    // path (deposit endpoint, add-payment-method webhook) handles those
    // with immediate retry (no limits). This prevents burning retry attempts
    // against an empty escrow account.
    //
    // Backoff schedule: 5s, 1m, 5m, 10m, 50m, 2h, 6h, 12h, 24h (then stop).
    // Covers ~72 hours — enough for transient outages (Sui down, Stripe down).
    const now = limits.clock.now();
    const candidates = await tx
      .select()
      .from(billingRecords)
      .where(
        and(
          eq(billingRecords.customerId, customerId),
          eq(billingRecords.status, 'failed'),
        )
      )
      .orderBy(asc(billingRecords.id));

    unpaidInvoices = candidates.filter(inv => {
      // Cleared for retry (new payment method added)
      if (!inv.failureReason) return true;

      const retryCount = inv.retryCount ?? 0;
      if (retryCount >= RETRY_BACKOFF_SECONDS.length) return false;

      const cooldownMs = RETRY_BACKOFF_SECONDS[retryCount] * 1000;
      if (inv.lastRetryAt && (now.getTime() - inv.lastRetryAt.getTime()) < cooldownMs) {
        return false;
      }

      return true;
    });
  } else {
    // Reactive: all unpaid invoices
    unpaidInvoices = await tx
      .select()
      .from(billingRecords)
      .where(
        and(
          eq(billingRecords.customerId, customerId),
          or(
            eq(billingRecords.status, 'pending'),
            eq(billingRecords.status, 'failed'),
          ),
        )
      )
      .orderBy(asc(billingRecords.id));
  }

  let paidCount = 0;
  let failedCount = 0;
  const details: RetryInvoiceDetail[] = [];

  for (const invoice of unpaidInvoices) {
    const previousRetryCount = Number(invoice.retryCount ?? 0);

    // Reset failed invoices to pending before retrying
    if (invoice.status === 'failed') {
      await tx.update(billingRecords)
        .set({ status: 'pending' })
        .where(eq(billingRecords.id, invoice.id));
    }

    const result = await processInvoicePayment(tx, invoice.id, providers, clock);

    if (result.fullyPaid) {
      paidCount++;

      await finalizeSuccessfulPayment(tx, customerId, invoice.id, clock);

      details.push({
        invoiceId: invoice.id,
        amountCents: result.amountPaidCents,
        paid: true,
        previousRetryCount,
      });
    } else {
      failedCount++;
      details.push({
        invoiceId: invoice.id,
        amountCents: Number(invoice.amountUsdCents),
        paid: false,
        error: result.error,
        previousRetryCount,
      });
    }
  }

  return { paidCount, failedCount, details };
}
