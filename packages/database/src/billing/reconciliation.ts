/**
 * Invoice Reconciliation for Two-Phase Commit
 *
 * Handles stuck 'pending' invoices from the two-phase commit pattern.
 * These are 'immediate' invoices that were created but never completed
 * (either paid or voided) due to a crash or error after invoice creation.
 *
 * Reconciliation logic:
 * 1. Find 'immediate' invoices stuck in 'pending' for > THRESHOLD minutes
 * 2. For each invoice:
 *    - Check if a ledger entry exists (payment was processed)
 *    - If payment exists: mark invoice as 'paid'
 *    - If no payment: mark invoice as 'voided' (crash before charge)
 *
 * This is called during the periodic billing job.
 */

import { eq, and, sql, lt, isNull, isNotNull } from 'drizzle-orm';
import type { Database } from '../db';
import { billingRecords, ledgerEntries, escrowTransactions, invoicePayments } from '../schema';
import { voidInvoice } from './invoices';
import { finalizeSuccessfulPayment } from './payments';
import { withCustomerLock } from './locking';
import { logInternalError } from './admin-notifications';
import { getStripeService } from '../stripe-mock/index.js';
import type { DBClock } from '@suiftly/shared/db-clock';

// ============================================================================
// Configuration
// ============================================================================

/**
 * How long to wait before considering a pending immediate invoice as "stuck"
 * Should be longer than the longest expected transaction (on-chain + network latency)
 */
const STUCK_INVOICE_THRESHOLD_MINUTES = 10;

/**
 * How long to wait before timing out a 3DS-pending invoice.
 * After this period, the Stripe invoice is voided and the billing record
 * is marked as 'failed' so normal retry cycle picks it up with a fresh
 * idempotency key.
 */
const THREEDS_TIMEOUT_HOURS = 48;

// ============================================================================
// Types
// ============================================================================

export interface ReconciliationResult {
  invoicesReconciled: number;
  invoicesMarkedPaid: number;
  invoicesMarkedVoided: number;
  errors: string[];
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Reconcile stuck pending immediate invoices
 *
 * Finds 'immediate' invoices that have been 'pending' for too long and
 * resolves them by checking if payment was actually processed.
 *
 * @param db Database instance
 * @param clock DBClock for time reference
 * @returns Reconciliation result
 */
export async function reconcileStuckInvoices(
  db: Database,
  clock: DBClock
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    invoicesReconciled: 0,
    invoicesMarkedPaid: 0,
    invoicesMarkedVoided: 0,
    errors: [],
  };

  const now = clock.now();
  const threshold = new Date(now.getTime() - STUCK_INVOICE_THRESHOLD_MINUTES * 60 * 1000);

  try {
    // Find 'immediate' invoices that are 'pending' and older than threshold.
    // Exclude invoices with a paymentActionUrl — these are waiting for the
    // customer to complete 3DS verification on a Stripe-hosted page and should
    // not be voided. The invoice.paid webhook will reconcile them.
    const stuckInvoices = await db
      .select()
      .from(billingRecords)
      .where(and(
        eq(billingRecords.billingType, 'immediate'),
        eq(billingRecords.status, 'pending'),
        lt(billingRecords.createdAt, threshold),
        isNull(billingRecords.paymentActionUrl),
      ));

    for (const invoice of stuckInvoices) {
      try {
        // Acquire customer lock to prevent races with concurrent webhook handlers
        await withCustomerLock(db, invoice.customerId, async (tx) => {
          // Re-check invoice status after acquiring lock (may have been resolved by webhook)
          const [freshInvoice] = await tx
            .select()
            .from(billingRecords)
            .where(eq(billingRecords.id, invoice.id))
            .limit(1);

          if (!freshInvoice || freshInvoice.status !== 'pending') {
            return; // Already resolved
          }

          // Check if a ledger entry exists for this invoice (payment was processed)
          const [ledgerEntry] = await tx
            .select()
            .from(ledgerEntries)
            .where(eq(ledgerEntries.invoiceId, invoice.id))
            .limit(1);

          if (ledgerEntry) {
            // Payment was processed - mark invoice as paid
            const invoiceAmountCents = Number(invoice.amountUsdCents);

            await tx
              .update(billingRecords)
              .set({
                status: 'paid',
                amountPaidUsdCents: invoiceAmountCents,
                txDigest: ledgerEntry.txDigest,
              })
              .where(eq(billingRecords.id, invoice.id));

            // Create invoice_payments row for audit trail.
            // Without this, "paid" invoices have zero payment history, causing
            // getInvoicePaidAmount to return 0 and blocking refund/excess-credit logic.
            if (ledgerEntry.txDigest) {
              // Find the escrow_transactions row matching this on-chain tx digest
              const [escrowTx] = await tx
                .select({ txId: escrowTransactions.txId })
                .from(escrowTransactions)
                .where(eq(escrowTransactions.txDigest, ledgerEntry.txDigest))
                .limit(1);

              if (escrowTx) {
                await tx.insert(invoicePayments).values({
                  billingRecordId: invoice.id,
                  sourceType: 'escrow',
                  escrowTransactionId: escrowTx.txId,
                  creditId: null,
                  providerReferenceId: null,
                  amountUsdCents: invoiceAmountCents,
                });
              }
            }

            // Finalize: clear pendingInvoiceId, set paidOnce, clear grace
            // period, issue reconciliation credit, recalculate DRAFT.
            await finalizeSuccessfulPayment(tx, invoice.customerId, invoice.id, clock);

            result.invoicesMarkedPaid++;
            console.log(`[RECONCILIATION] Marked invoice ${invoice.id} as paid (found ledger entry)`);
          } else {
            // No payment found - crash occurred before on-chain charge
            // Void the invoice (operation was never completed)
            await voidInvoice(tx, invoice.id, 'Reconciliation: No payment found after timeout - operation incomplete');

            result.invoicesMarkedVoided++;
            console.log(`[RECONCILIATION] Voided invoice ${invoice.id} (no payment found after ${STUCK_INVOICE_THRESHOLD_MINUTES} minutes)`);
          }

          result.invoicesReconciled++;
        });
      } catch (error) {
        const errorMsg = `Failed to reconcile invoice ${invoice.id}: ${error instanceof Error ? error.message : String(error)}`;
        result.errors.push(errorMsg);
        console.error(`[RECONCILIATION] ${errorMsg}`);
      }
    }

    if (stuckInvoices.length > 0) {
      console.log(`[RECONCILIATION] Processed ${stuckInvoices.length} stuck invoices: ${result.invoicesMarkedPaid} paid, ${result.invoicesMarkedVoided} voided`);
    }

    // Handle 3DS invoices that exceeded the timeout.
    // These are pending invoices with a paymentActionUrl (Stripe-hosted 3DS page)
    // that the customer never completed. After timeout, void the Stripe invoice
    // and mark as failed so normal retry cycle picks it up.
    const threeDSThreshold = new Date(now.getTime() - THREEDS_TIMEOUT_HOURS * 60 * 60 * 1000);

    const stale3DSInvoices = await db
      .select()
      .from(billingRecords)
      .where(and(
        eq(billingRecords.status, 'pending'),
        isNotNull(billingRecords.paymentActionUrl),
        lt(billingRecords.createdAt, threeDSThreshold),
      ));

    for (const invoice of stale3DSInvoices) {
      try {
        await withCustomerLock(db, invoice.customerId, async (tx) => {
          // Re-check after acquiring lock
          const [freshInvoice] = await tx
            .select()
            .from(billingRecords)
            .where(eq(billingRecords.id, invoice.id))
            .limit(1);

          if (!freshInvoice || freshInvoice.status !== 'pending' || !freshInvoice.paymentActionUrl) {
            return; // Already resolved
          }

          // Void the Stripe invoice to prevent late 3DS completion.
          const stripeInvoiceId = freshInvoice.pendingStripeInvoiceId ?? null;
          if (stripeInvoiceId) {
            try {
              const stripeService = getStripeService();
              await stripeService.voidInvoice(stripeInvoiceId);
            } catch (voidErr) {
              // Non-fatal — auto-refund in webhook handler is the safety net.
              console.error(`[RECONCILIATION] Failed to void Stripe invoice for 3DS timeout on invoice ${invoice.id}:`, voidErr);
              try {
                await logInternalError(tx, {
                  severity: 'warning',
                  category: 'billing',
                  code: 'THREEDS_VOID_FAILED',
                  message: `Failed to void Stripe invoice for 3DS timeout on billing record ${invoice.id} — stale 3DS link remains live`,
                  details: {
                    stripeInvoiceId,
                    paymentActionUrl: freshInvoice.paymentActionUrl,
                    error: voidErr instanceof Error ? voidErr.message : String(voidErr),
                  },
                  customerId: invoice.customerId,
                  invoiceId: invoice.id,
                });
              } catch { /* don't let notification failure break reconciliation */ }
            }
          }

          // Mark as failed and clear all 3DS metadata
          await tx.update(billingRecords).set({
            status: 'failed',
            paymentActionUrl: null,
            pendingStripeInvoiceId: null,
            failureReason: `3DS verification timed out after ${THREEDS_TIMEOUT_HOURS} hours`,
          }).where(eq(billingRecords.id, invoice.id));

          await logInternalError(tx, {
            severity: 'warning',
            category: 'billing',
            code: 'THREEDS_TIMEOUT',
            message: `3DS invoice ${invoice.id} timed out after ${THREEDS_TIMEOUT_HOURS}h — marked as failed for retry`,
            details: { customerId: invoice.customerId, paymentActionUrl: invoice.paymentActionUrl },
            customerId: invoice.customerId,
            invoiceId: invoice.id,
          });

          result.invoicesReconciled++;
          console.log(`[RECONCILIATION] 3DS timeout: invoice ${invoice.id} marked as failed after ${THREEDS_TIMEOUT_HOURS}h`);
        });
      } catch (error) {
        const errorMsg = `Failed to reconcile 3DS invoice ${invoice.id}: ${error instanceof Error ? error.message : String(error)}`;
        result.errors.push(errorMsg);
        console.error(`[RECONCILIATION] ${errorMsg}`);
      }
    }

    if (stale3DSInvoices.length > 0) {
      console.log(`[RECONCILIATION] Processed ${stale3DSInvoices.length} stale 3DS invoices`);
    }
  } catch (error) {
    const errorMsg = `Reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
    result.errors.push(errorMsg);
    console.error(`[RECONCILIATION] ${errorMsg}`);
  }

  return result;
}
