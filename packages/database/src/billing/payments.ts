/**
 * Invoice Payment Processing
 *
 * Handles multi-source payment application to invoices:
 * 1. Apply credits first (oldest expiring first)
 * 2. Charge remaining via provider chain (user's priority order)
 *
 * Credits are NOT rolled back if provider charge fails (see BILLING_DESIGN.md).
 */

import { eq, sql } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../db';
import type { LockedTransaction } from './locking';
import { billingRecords, invoicePayments } from '../schema';
import { applyCreditsToInvoice } from './credits';
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

  // If already paid, nothing to do
  if (result.fullyPaid) {
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

    for (const provider of providers) {
      if (!await provider.canPay(customerId, creditResult.remainingInvoiceAmountCents)) {
        continue;
      }

      const chargeResult = await provider.charge({
        customerId,
        amountUsdCents: creditResult.remainingInvoiceAmountCents,
        invoiceId: billingRecordId,
        description: `Invoice ${billingRecordId}`,
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
          })
          .where(eq(billingRecords.id, billingRecordId));

        break;
      }

      // Persist paymentActionUrl if provider returned a hosted invoice URL (3DS)
      if (chargeResult.hostedInvoiceUrl) {
        await tx
          .update(billingRecords)
          .set({ paymentActionUrl: chargeResult.hostedInvoiceUrl })
          .where(eq(billingRecords.id, billingRecordId));
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

      // Update invoice status to failed
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
  } else {
    // Fully paid with credits alone
    result.fullyPaid = true;
    await tx
      .update(billingRecords)
      .set({ status: 'paid' })
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
