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

import { eq, and, sql, lt } from 'drizzle-orm';
import type { Database } from '../db';
import { billingRecords, ledgerEntries } from '../schema';
import { voidInvoice } from './invoices';
import type { DBClock } from '@suiftly/shared/db-clock';

// ============================================================================
// Configuration
// ============================================================================

/**
 * How long to wait before considering a pending immediate invoice as "stuck"
 * Should be longer than the longest expected transaction (on-chain + network latency)
 */
const STUCK_INVOICE_THRESHOLD_MINUTES = 10;

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
    // Find 'immediate' invoices that are 'pending' and older than threshold
    const stuckInvoices = await db
      .select()
      .from(billingRecords)
      .where(and(
        eq(billingRecords.billingType, 'immediate'),
        eq(billingRecords.status, 'pending'),
        lt(billingRecords.createdAt, threshold)
      ));

    for (const invoice of stuckInvoices) {
      try {
        // Check if a ledger entry exists for this invoice (payment was processed)
        const [ledgerEntry] = await db
          .select()
          .from(ledgerEntries)
          .where(eq(ledgerEntries.invoiceId, invoice.id))
          .limit(1);

        if (ledgerEntry) {
          // Payment was processed - mark invoice as paid
          await db
            .update(billingRecords)
            .set({
              status: 'paid',
              amountPaidUsdCents: Number(invoice.amountUsdCents),
              txDigest: ledgerEntry.txDigest,
            })
            .where(eq(billingRecords.id, invoice.id));

          result.invoicesMarkedPaid++;
          console.log(`[RECONCILIATION] Marked invoice ${invoice.id} as paid (found ledger entry)`);
        } else {
          // No payment found - crash occurred before on-chain charge
          // Void the invoice (operation was never completed)
          await db.transaction(async (tx) => {
            await voidInvoice(tx, invoice.id, 'Reconciliation: No payment found after timeout - operation incomplete');
          });

          result.invoicesMarkedVoided++;
          console.log(`[RECONCILIATION] Voided invoice ${invoice.id} (no payment found after ${STUCK_INVOICE_THRESHOLD_MINUTES} minutes)`);
        }

        result.invoicesReconciled++;
      } catch (error) {
        const errorMsg = `Failed to reconcile invoice ${invoice.id}: ${error instanceof Error ? error.message : String(error)}`;
        result.errors.push(errorMsg);
        console.error(`[RECONCILIATION] ${errorMsg}`);
      }
    }

    if (stuckInvoices.length > 0) {
      console.log(`[RECONCILIATION] Processed ${stuckInvoices.length} stuck invoices: ${result.invoicesMarkedPaid} paid, ${result.invoicesMarkedVoided} voided`);
    }
  } catch (error) {
    const errorMsg = `Reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
    result.errors.push(errorMsg);
    console.error(`[RECONCILIATION] ${errorMsg}`);
  }

  return result;
}
