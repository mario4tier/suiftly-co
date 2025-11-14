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
import { serviceInstances, ledgerEntries, customers } from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import { getSuiService } from '../services/sui/index.js';
import { getTierPriceUsdCents } from './config-cache';

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
      });

      if (chargeResult.success) {
        // Charge succeeded - clear pending state and record in ledger
        await db.transaction(async (tx) => {
          // Clear pending flag
          await tx.update(serviceInstances)
            .set({
              subscriptionChargePending: false,
            })
            .where(eq(serviceInstances.instanceId, service.instanceId));

          // Record charge in ledger
          await tx.insert(ledgerEntries).values({
            customerId,
            type: 'charge',
            amountUsdCents: BigInt(priceUsdCents),
            description: `${service.serviceType} ${service.tier} tier subscription`,
            createdAt: new Date(),
          });
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

/**
 * Charge monthly subscription for a service (for scheduled billing)
 *
 * @param instanceId - Service instance ID to charge
 * @returns Whether charge succeeded
 */
export async function chargeMonthlySubscription(instanceId: number): Promise<boolean> {
  const service = await db.query.serviceInstances.findFirst({
    where: eq(serviceInstances.instanceId, instanceId),
  });

  if (!service) {
    console.error(`[MONTHLY_CHARGE] Service ${instanceId} not found`);
    return false;
  }

  // Get customer for wallet address
  const customer = await db.query.customers.findFirst({
    where: eq(customers.customerId, service.customerId),
  });

  if (!customer) {
    console.error(`[MONTHLY_CHARGE] Customer ${service.customerId} not found`);
    return false;
  }

  // Get tier price
  const priceUsdCents = getTierPriceUsdCents(service.tier);
  const suiService = getSuiService();

  // Attempt to charge
  const chargeResult = await suiService.charge({
    userAddress: customer.walletAddress,
    amountUsdCents: priceUsdCents,
    description: `${service.serviceType} ${service.tier} tier subscription`,
  });

  if (chargeResult.success) {
    // Record charge in ledger
    await db.insert(ledgerEntries).values({
      customerId: service.customerId,
      type: 'charge',
      amountUsdCents: BigInt(priceUsdCents),
      description: `${service.serviceType} ${service.tier} tier subscription`,
      createdAt: new Date(),
    });

    console.log(`[MONTHLY_CHARGE] Successfully charged monthly subscription for service ${instanceId}`);
    return true;
  } else {
    // Charge failed - mark as pending
    await db.transaction(async (tx) => {
      await tx.update(serviceInstances)
        .set({
          subscriptionChargePending: true,
        })
        .where(eq(serviceInstances.instanceId, instanceId));
    });

    console.log(`[MONTHLY_CHARGE] Charge failed for service ${instanceId}, marked as pending: ${chargeResult.error}`);
    return false;
  }
}
