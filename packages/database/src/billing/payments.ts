/**
 * Invoice Payment Processing
 *
 * Handles multi-source payment application to invoices:
 * 1. Apply credits first (oldest expiring first)
 * 2. Charge remaining from escrow (on-chain)
 *
 * Credits are NOT rolled back if escrow charge fails (see BILLING_DESIGN.md).
 */

import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { billingRecords, invoicePayments, escrowTransactions, customers } from '../schema';
import { applyCreditsToInvoice } from './credits';
import type { InvoicePaymentResult, BillingError } from './types';
import type { DBClock } from '@suiftly/shared/db-clock';
import type { ISuiService } from '@suiftly/shared/sui-service';

/**
 * Process payment for an invoice using credits + escrow
 *
 * Payment order (per BILLING_DESIGN.md):
 * 1. Credits (oldest expiring first) - off-chain, not rolled back
 * 2. Escrow (on-chain charge) - only for remaining amount
 *
 * @param tx Transaction handle (must have customer lock)
 * @param billingRecordId Invoice ID to pay
 * @param suiService Sui service for escrow charging
 * @param clock DBClock for timestamps
 * @returns Payment result with success/failure details
 */
export async function processInvoicePayment(
  tx: NodePgDatabase<any>,
  billingRecordId: string,
  suiService: ISuiService,
  clock: DBClock
): Promise<InvoicePaymentResult> {
  // Get invoice details
  const invoice = await tx.query.billingRecords.findFirst({
    where: eq(billingRecords.id, billingRecordId),
  });

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

  // Step 2: Charge escrow for remaining amount
  if (creditResult.remainingInvoiceAmountCents > 0) {
    // Get customer wallet address
    const customer = await tx.query.customers.findFirst({
      where: eq(customers.customerId, customerId),
    });

    if (!customer) {
      result.error = {
        type: 'database_error',
        message: 'Customer not found',
        customerId,
        invoiceId: billingRecordId,
        retryable: false,
      };
      return result;
    }

    // Validate escrow account exists
    if (!customer.escrowContractId) {
      result.error = {
        type: 'payment_failed',
        message: 'No escrow account configured',
        customerId,
        invoiceId: billingRecordId,
        retryable: false,
      };
      return result;
    }

    // Charge escrow
    const chargeResult = await suiService.charge({
      userAddress: customer.walletAddress,
      amountUsdCents: creditResult.remainingInvoiceAmountCents,
      description: `Invoice ${invoice.invoiceNumber ?? billingRecordId}`,
      escrowAddress: customer.escrowContractId,
    });

    if (chargeResult.success && chargeResult.digest) {
      // Record escrow transaction
      const txDigest = Buffer.from(chargeResult.digest.replace(/^0x/, ''), 'hex');

      const [escrowTx] = await tx
        .insert(escrowTransactions)
        .values({
          customerId,
          txDigest: txDigest, // Buffer is passed directly
          txType: 'charge',
          // IMPORTANT: escrow_transactions.amount is DECIMAL (dollars), not cents
          // This matches blockchain format. All other billing tables use cents.
          amount: String(creditResult.remainingInvoiceAmountCents / 100),
          assetType: 'USDC',
          timestamp: clock.now(),
        })
        .returning({ id: escrowTransactions.txId });

      // Record invoice payment
      await tx.insert(invoicePayments).values({
        billingRecordId,
        sourceType: 'escrow',
        creditId: null,
        escrowTransactionId: escrowTx.id, // bigint, not UUID
        amountUsdCents: creditResult.remainingInvoiceAmountCents,
      });

      result.paymentSources.push({
        type: 'escrow',
        amountCents: creditResult.remainingInvoiceAmountCents,
        referenceId: String(escrowTx.id),
      });

      result.amountPaidCents += creditResult.remainingInvoiceAmountCents;
      result.fullyPaid = true;

      // Update invoice as paid
      await tx
        .update(billingRecords)
        .set({
          amountPaidUsdCents: result.amountPaidCents,
          status: 'paid',
          txDigest: txDigest, // Buffer is passed directly
        })
        .where(eq(billingRecords.id, billingRecordId));
    } else {
      // Escrow charge failed - credits stay applied, invoice remains pending
      result.error = {
        type: 'payment_failed',
        message: chargeResult.error ?? 'Escrow charge failed',
        customerId,
        invoiceId: billingRecordId,
        retryable: true,
      };

      // Update invoice status to failed with error details
      await tx
        .update(billingRecords)
        .set({
          status: 'failed',
          failureReason: chargeResult.error,
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
  tx: NodePgDatabase<any>,
  billingRecordId: string
): Promise<number> {
  const payments = await tx
    .select({ total: sql<number>`COALESCE(SUM(${invoicePayments.amountUsdCents}), 0)` })
    .from(invoicePayments)
    .where(eq(invoicePayments.billingRecordId, billingRecordId));

  return Number(payments[0]?.total ?? 0);
}
