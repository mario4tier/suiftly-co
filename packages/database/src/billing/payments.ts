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
import { billingRecords, invoicePayments, serviceInstances, customers } from '../schema';
import { applyCreditsToInvoice, issueReconciliationCredit, issueCredit } from './credits';
import { clearGracePeriod } from './grace-period';
import { logInternalError } from './admin-notifications';
import { getStripeService } from '../stripe-mock/index.js';
import type { InvoicePaymentResult, BillingError } from './types';
import type { DBClock } from '@suiftly/shared/db-clock';
import type { IPaymentProvider } from '@suiftly/shared/payment-provider';

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
      .set({ status: 'paid', failureReason: null, paymentActionUrl: null })
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
    let pendingStripeInvoiceId: string | undefined;

    for (const provider of providers) {
      if (!await provider.canPay(customerId, creditResult.remainingInvoiceAmountCents)) {
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

      // Persist paymentActionUrl if provider returned a hosted invoice URL (3DS)
      if (chargeResult.hostedInvoiceUrl) {
        await tx
          .update(billingRecords)
          .set({ paymentActionUrl: chargeResult.hostedInvoiceUrl })
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
      .set({ status: 'paid', failureReason: null, paymentActionUrl: null })
      .where(eq(billingRecords.id, billingRecordId));
  }

  return result;
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
    // Periodic: only failed invoices within retry limits OR cleared for retry.
    // When a user adds a new payment method, the webhook clears failureReason
    // (and lastRetryAt) to signal "retry me". If the reactive GM retry fails
    // (timeout/GM down), the periodic job must still pick these up — even if
    // retryCount >= maxRetries. The cleared failureReason is the signal.
    const retryThreshold = new Date(limits.clock.now().getTime() - limits.cooldownHours * 60 * 60 * 1000);
    unpaidInvoices = await tx
      .select()
      .from(billingRecords)
      .where(
        and(
          eq(billingRecords.customerId, customerId),
          eq(billingRecords.status, 'failed'),
          or(
            // Normal periodic retry: within retry limits and cooldown
            and(
              sql`COALESCE(${billingRecords.retryCount}, 0) < ${limits.maxRetries}`,
              sql`(${billingRecords.lastRetryAt} IS NULL OR ${billingRecords.lastRetryAt} < ${retryThreshold})`,
            ),
            // Cleared for retry: failureReason was nulled by new-payment-method webhook.
            // This is inherently single-shot: if the retry fails, failureReason is set
            // back to the error message (line ~261), so the invoice won't match this
            // branch again until the next payment-method-update event clears it.
            sql`${billingRecords.failureReason} IS NULL`,
          ),
        )
      )
      .orderBy(asc(billingRecords.id));
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

      // Clear subPendingInvoiceId on services referencing this invoice
      const pendingServices = await tx
        .select({ instanceId: serviceInstances.instanceId, serviceType: serviceInstances.serviceType })
        .from(serviceInstances)
        .where(
          and(
            eq(serviceInstances.customerId, customerId),
            eq(serviceInstances.subPendingInvoiceId, invoice.id),
          )
        );

      if (pendingServices.length > 0) {
        await tx.update(serviceInstances)
          .set({ subPendingInvoiceId: null, paidOnce: true })
          .where(
            and(
              eq(serviceInstances.customerId, customerId),
              eq(serviceInstances.subPendingInvoiceId, invoice.id),
            )
          );
      }

      await tx.update(customers)
        .set({ paidOnce: true })
        .where(eq(customers.customerId, customerId));

      await clearGracePeriod(tx, customerId);

      // Issue reconciliation credit for partial month (deferred payment).
      // When the original subscription charge was deferred (e.g., no payment method,
      // 3DS pending), handleSubscriptionBillingLocked skipped the credit because
      // paymentResult.fullyPaid was false. Now that the deferred payment succeeded,
      // we issue the credit using the invoice's billingPeriodStart (not today).
      // Only issue when a pending service was matched — avoids minting credits for
      // non-subscription invoices (usage, add-on) that have no linked service.
      if (pendingServices.length > 0) {
        await issueReconciliationCredit(
          tx, customerId, invoice, pendingServices[0].serviceType,
        );
      }

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
