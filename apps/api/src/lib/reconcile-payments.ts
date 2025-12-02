/**
 * Payment Reconciliation Utility
 *
 * Idempotent function to reconcile pending subscription charges.
 * Called after deposits and on monthly billing cycle.
 *
 * Design:
 * - Idempotent: Safe to call multiple times
 * - Transactional: All changes in one DB transaction
 * - Handles both pending charges and regular monthly billing
 *
 * Use cases:
 * 1. After user deposits funds (retry pending charges)
 * 2. Monthly billing cycle (charge all active subscriptions)
 * 3. Manual reconciliation (admin or retry logic)
 */

import { db } from '@suiftly/database';
import { serviceInstances, customers, billingRecords, invoicePayments, escrowTransactions } from '@suiftly/database/schema';
import { eq, and, desc } from 'drizzle-orm';
import { getSuiService } from '../services/sui/index.js';
import { getTierPriceUsdCents } from './config-cache';
import { issueCredit } from '@suiftly/database/billing';
import { dbClock } from '@suiftly/shared/db-clock';

interface ReconcileResult {
  customerId: number;
  servicesProcessed: number;
  chargesSucceeded: number;
  chargesFailed: number;
  details: {
    instanceId: number;
    success: boolean;
    error?: string;
  }[];
}

/**
 * Reconcile pending subscription charges for a customer
 *
 * @param customerId - Customer ID to reconcile
 * @returns Summary of reconciliation results
 */
export async function reconcilePayments(customerId: number): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    customerId,
    servicesProcessed: 0,
    chargesSucceeded: 0,
    chargesFailed: 0,
    details: [],
  };

  // Find all services with pending subscription charges
  const pendingServices = await db.query.serviceInstances.findMany({
    where: and(
      eq(serviceInstances.customerId, customerId),
      eq(serviceInstances.subscriptionChargePending, true)
    ),
  });

  if (pendingServices.length === 0) {
    console.log(`[RECONCILE] No pending charges for customer ${customerId}`);
    return result;
  }

  console.log(`[RECONCILE] Found ${pendingServices.length} services with pending charges for customer ${customerId}`);

  // Get customer wallet address for charging
  const customer = await db.query.customers.findFirst({
    where: eq(customers.customerId, customerId),
  });

  if (!customer) {
    console.error(`[RECONCILE] Customer ${customerId} not found`);
    return result;
  }

  const suiService = getSuiService();

  // Process each pending service
  for (const service of pendingServices) {
    result.servicesProcessed++;

    try {
      // Get tier price
      const priceUsdCents = getTierPriceUsdCents(service.tier);

      // Attempt to charge subscription fee
      const chargeResult = await suiService.charge({
        userAddress: customer.walletAddress,
        amountUsdCents: priceUsdCents,
        description: `${service.serviceType} ${service.tier} tier subscription`,
        escrowAddress: customer.escrowContractId ?? '', // Use empty string if no escrow (mock mode)
      });

      if (chargeResult.success && chargeResult.digest) {
        // Charge succeeded - clear pending state, set paidOnce, issue credit, update billing record
        const txDigest = Buffer.from(chargeResult.digest.replace(/^0x/, ''), 'hex');

        await db.transaction(async (tx) => {
          // Clear pending flag and set paidOnce
          await tx.update(serviceInstances)
            .set({
              subscriptionChargePending: false,
              paidOnce: true,
            })
            .where(eq(serviceInstances.instanceId, service.instanceId));

          // Set customer paidOnce (enables grace period on future payment failures)
          await tx.update(customers)
            .set({ paidOnce: true })
            .where(eq(customers.customerId, customerId));

          // Find the pending billing record for this subscription
          const [pendingBillingRecord] = await tx
            .select()
            .from(billingRecords)
            .where(and(
              eq(billingRecords.customerId, customerId),
              eq(billingRecords.status, 'pending'),
              eq(billingRecords.amountUsdCents, priceUsdCents)
            ))
            .orderBy(desc(billingRecords.createdAt))
            .limit(1);

          if (pendingBillingRecord) {
            // Record escrow transaction
            const [escrowTx] = await tx
              .insert(escrowTransactions)
              .values({
                customerId,
                txDigest: txDigest,
                txType: 'charge',
                amount: String(priceUsdCents / 100),
                assetType: 'USDC',
                timestamp: dbClock.now(),
              })
              .returning({ id: escrowTransactions.txId });

            // Record invoice payment
            await tx.insert(invoicePayments).values({
              billingRecordId: pendingBillingRecord.id,
              sourceType: 'escrow',
              creditId: null,
              escrowTransactionId: escrowTx.id,
              amountUsdCents: priceUsdCents,
            });

            // Update billing record to paid
            await tx
              .update(billingRecords)
              .set({
                status: 'paid',
                amountPaidUsdCents: priceUsdCents,
                txDigest: txDigest,
              })
              .where(eq(billingRecords.id, pendingBillingRecord.id));

            console.log(`[RECONCILE] Updated billing record ${pendingBillingRecord.id} to paid`);
          }

          // Issue reconciliation credit for partial month
          // Calculate based on current tier price (not original subscription tier)
          const today = dbClock.today();
          const daysInMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate();
          const dayOfMonth = today.getUTCDate();
          const daysUsed = daysInMonth - dayOfMonth + 1;
          const daysNotUsed = daysInMonth - daysUsed;

          const reconciliationCreditCents = Math.floor(
            (priceUsdCents * daysNotUsed) / daysInMonth
          );

          if (reconciliationCreditCents > 0) {
            await issueCredit(
              tx,
              customerId,
              reconciliationCreditCents,
              'reconciliation',
              `Partial month credit for ${service.serviceType} (${daysNotUsed}/${daysInMonth} days unused)`,
              null // Never expires
            );
          }
        });

        result.chargesSucceeded++;
        result.details.push({
          instanceId: service.instanceId,
          success: true,
        });

        console.log(`[RECONCILE] Successfully charged and cleared pending state for service ${service.instanceId}`);
      } else {
        // Charge failed - keep pending state, log error
        result.chargesFailed++;
        result.details.push({
          instanceId: service.instanceId,
          success: false,
          error: chargeResult.error,
        });

        console.log(`[RECONCILE] Charge failed for service ${service.instanceId}: ${chargeResult.error}`);
      }
    } catch (error) {
      // Unexpected error during reconciliation
      result.chargesFailed++;
      result.details.push({
        instanceId: service.instanceId,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      console.error(`[RECONCILE] Error reconciling service ${service.instanceId}:`, error);
    }
  }

  console.log(`[RECONCILE] Reconciliation complete for customer ${customerId}: ${result.chargesSucceeded} succeeded, ${result.chargesFailed} failed`);

  return result;
}

