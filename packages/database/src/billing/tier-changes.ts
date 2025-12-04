/**
 * Tier Change and Cancellation Implementation (Phase 1C)
 *
 * Handles tier upgrades, downgrades, and subscription cancellation.
 * See BILLING_DESIGN.md R13 for detailed requirements.
 *
 * Key Design Principles:
 * - All timestamps from DBClock for deterministic testing
 * - Customer-level locking for concurrency safety
 * - Idempotent operations where possible
 */

import { eq, and, lte, gt, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '../db';
import { serviceInstances, serviceCancellationHistory, billingRecords } from '../schema';
import { withCustomerLock, type LockedTransaction } from './locking';
import {
  createAndChargeImmediately,
  getOrCreateDraftInvoice,
  updateDraftInvoiceAmount,
  createPendingInvoiceCommitted,
  voidInvoice,
} from './invoices';
import { processInvoicePayment } from './payments';
import { recalculateDraftInvoice, calculateProRatedUpgradeCharge } from './service-billing';
import { getTierPriceUsdCents, TIER_PRICES_USD_CENTS } from '@suiftly/shared/pricing';
import { INVOICE_LINE_ITEM_TYPE } from '@suiftly/shared/constants';
import type { DBClock } from '@suiftly/shared/db-clock';
import type { ISuiService } from '@suiftly/shared/sui-service';
import type { ServiceType, ServiceTier, ServiceState } from '../schema/enums';

// ============================================================================
// Types
// ============================================================================

export interface TierUpgradeResult {
  success: boolean;
  newTier: ServiceTier;
  chargeAmountUsdCents: number;
  invoiceId?: string;
  error?: string;
}

export interface TierDowngradeResult {
  success: boolean;
  scheduledTier: ServiceTier;
  effectiveDate: Date;
  error?: string;
}

export interface CancellationResult {
  success: boolean;
  effectiveDate: Date;
  error?: string;
}

export interface UndoCancellationResult {
  success: boolean;
  error?: string;
}

export interface CanProvisionResult {
  allowed: boolean;
  reason?: 'cancellation_pending' | 'cooldown_period' | 'already_subscribed';
  availableAt?: Date;
  message?: string;
}

export interface CanPerformKeyOperationResult {
  allowed: boolean;
  reason?: 'no_payment_yet' | 'service_not_found' | 'service_not_active';
  message?: string;
}

export interface TierChangeOptions {
  currentTier: ServiceTier;
  paidOnce: boolean; // If false, tier changes are immediate without charge
  availableTiers: Array<{
    tier: ServiceTier;
    priceUsdCents: number;
    upgradeChargeCents?: number;
    effectiveDate?: Date;
    isCurrentTier: boolean;
    isUpgrade: boolean;
    isDowngrade: boolean;
    isScheduled: boolean; // True if this tier is the currently scheduled change
  }>;
  // Scheduled tier change info (downgrade only - upgrades are immediate)
  scheduledTier?: ServiceTier;
  scheduledTierEffectiveDate?: Date;
  // Cancellation info
  cancellationScheduled: boolean;
  cancellationEffectiveDate?: Date;
}

// ============================================================================
// Tier Upgrade (Immediate Effect)
// ============================================================================

/**
 * Handle tier upgrade with immediate effect (INTERNAL - REQUIRES LOCK)
 *
 * Call via withCustomerLockForAPI in API routes.
 *
 * Per BILLING_DESIGN.md R13.1:
 * - Immediate activation upon successful payment
 * - Pro-rated charge for remaining days
 * - Grace period (≤2 days remaining = $0 charge)
 * - Upgrade only activates if payment succeeds
 *
 * @param tx Locked transaction (from withCustomerLock)
 * @param customerId Customer ID
 * @param serviceType Service type to upgrade
 * @param newTier New tier (must be higher than current)
 * @param suiService Sui service for payment
 * @param clock DBClock for timestamps
 * @returns Upgrade result
 */
export async function handleTierUpgradeLocked(
  tx: LockedTransaction,
  customerId: number,
  serviceType: ServiceType,
  newTier: ServiceTier,
  suiService: ISuiService,
  clock: DBClock
): Promise<TierUpgradeResult> {
  // 1. Get current service
  const [service] = await tx
    .select()
    .from(serviceInstances)
    .where(and(
      eq(serviceInstances.customerId, customerId),
      eq(serviceInstances.serviceType, serviceType)
    ))
    .limit(1);

  if (!service) {
    return {
      success: false,
      newTier,
      chargeAmountUsdCents: 0,
      error: 'Service not found',
    };
  }

  // 1.5. Block tier changes if cancellation is scheduled
  // User must explicitly undo cancellation first to avoid confusing state transitions
  if (service.cancellationScheduledFor) {
    return {
      success: false,
      newTier,
      chargeAmountUsdCents: 0,
      error: 'Cannot change tier while cancellation is scheduled. Please undo the cancellation first.',
    };
  }

  // 2. Validate upgrade (new tier must be higher priced)
  const currentTierPrice = getTierPriceUsdCents(service.tier);
  const newTierPrice = getTierPriceUsdCents(newTier);

  if (newTierPrice <= currentTierPrice) {
    return {
      success: false,
      newTier,
      chargeAmountUsdCents: 0,
      error: 'New tier must have higher price than current tier. Use downgrade for lower tiers.',
    };
  }

  // 2.5. If user has never paid, allow immediate tier change without charge
  // This handles the case where user subscribed but hasn't completed payment yet
  if (!service.paidOnce) {
    await tx
      .update(serviceInstances)
      .set({
        tier: newTier,
        // Clear any scheduled changes
        scheduledTier: null,
        scheduledTierEffectiveDate: null,
        cancellationScheduledFor: null,
      })
      .where(eq(serviceInstances.instanceId, service.instanceId));

    // Update pending billing record to reflect the new tier price
    // This ensures reconcilePayments charges the correct amount
    await tx
      .update(billingRecords)
      .set({
        amountUsdCents: newTierPrice,
      })
      .where(
        and(
          eq(billingRecords.customerId, customerId),
          // Only update non-paid, non-draft records (pending or failed)
          sql`${billingRecords.status} NOT IN ('paid', 'draft')`
        )
      );

    // Recalculate DRAFT invoice to reflect the new tier
    await recalculateDraftInvoice(tx, customerId, clock);

    return {
      success: true,
      newTier,
      chargeAmountUsdCents: 0,
    };
  }

  // 3. Calculate pro-rated charge
  const chargeAmountCents = calculateProRatedUpgradeCharge(
    currentTierPrice,
    newTierPrice,
    clock
  );

  // 4. If charge is $0 (grace period), upgrade immediately without payment
  if (chargeAmountCents === 0) {
    await tx
      .update(serviceInstances)
      .set({
        tier: newTier,
        // Clear any scheduled downgrade since we're upgrading
        scheduledTier: null,
        scheduledTierEffectiveDate: null,
        // Clear any cancellation since user is upgrading
        cancellationScheduledFor: null,
      })
      .where(eq(serviceInstances.instanceId, service.instanceId));

    // Recalculate DRAFT invoice for next billing cycle
    await recalculateDraftInvoice(tx, customerId, clock);

    return {
      success: true,
      newTier,
      chargeAmountUsdCents: 0,
    };
  }

  // 5. Create immediate invoice for upgrade charge
  const invoiceId = await createAndChargeImmediately(
    tx,
    {
      customerId,
      amountUsdCents: chargeAmountCents,
      type: 'charge',
      status: 'pending',
      description: `${serviceType} tier upgrade: ${service.tier} → ${newTier} (pro-rated)`,
      billingPeriodStart: clock.now(),
      billingPeriodEnd: getEndOfMonth(clock),
      dueDate: clock.now(),
      lineItem: {
        itemType: INVOICE_LINE_ITEM_TYPE.TIER_UPGRADE,
        serviceType,
        quantity: 1,
        unitPriceUsdCents: chargeAmountCents,
        amountUsdCents: chargeAmountCents,
      },
    },
    clock
  );

  // 6. Attempt payment
  const paymentResult = await processInvoicePayment(
    tx,
    invoiceId,
    suiService,
    clock
  );

  if (!paymentResult.fullyPaid) {
    // Payment failed - don't upgrade
    return {
      success: false,
      newTier,
      chargeAmountUsdCents: chargeAmountCents,
      invoiceId,
      error: paymentResult.error?.message || 'Payment failed',
    };
  }

  // 7. Payment succeeded - update tier immediately
  await tx
    .update(serviceInstances)
    .set({
      tier: newTier,
      // Clear any scheduled downgrade
      scheduledTier: null,
      scheduledTierEffectiveDate: null,
      // Clear any cancellation
      cancellationScheduledFor: null,
    })
    .where(eq(serviceInstances.instanceId, service.instanceId));

  // 8. Recalculate DRAFT invoice for next billing cycle
  await recalculateDraftInvoice(tx, customerId, clock);

  return {
    success: true,
    newTier,
    chargeAmountUsdCents: chargeAmountCents,
    invoiceId,
  };
}

// ============================================================================
// Two-Phase Commit for Tier Upgrade (Crash-Safe)
// ============================================================================
//
// Route code should call these functions with explicit locking:
//
// // Phase 1: Lock → validate → calculate
// const phase1 = await withCustomerLockForAPI(customerId, 'upgradeTier:phase1', (tx) =>
//   prepareTierUpgradePhase1Locked(tx, customerId, serviceType, newTier, clock)
// );
// if (!phase1.canProceed) return error;
// if (phase1.useSimplePath) { /* use handleTierUpgradeLocked */ }
//
// // Create invoice (commits immediately, NO LOCK)
// const invoiceId = await createUpgradeInvoiceCommitted(customerId, phase1, clock);
//
// // Phase 2: Lock → pay → update tier
// const result = await withCustomerLockForAPI(customerId, 'upgradeTier:phase2', (tx) =>
//   executeTierUpgradePhase2Locked(tx, customerId, serviceType, newTier, phase1.currentTier, invoiceId, suiService, clock)
// );
// ============================================================================

/**
 * Result from Phase 1 of tier upgrade
 */
export interface TierUpgradePhase1Result {
  canProceed: boolean;
  currentTier?: ServiceTier;
  chargeAmountUsdCents: number;
  description?: string;
  serviceType?: ServiceType; // For creating semantic line item
  error?: string;
  // If true, use simple single-transaction path (no charge needed)
  useSimplePath?: boolean;
}

/**
 * Phase 1: Validate and calculate upgrade charge (REQUIRES LOCK)
 *
 * Call via withCustomerLockForAPI in route code.
 * Returns information needed to create the invoice.
 *
 * @param tx Locked transaction from withCustomerLockForAPI
 * @param customerId Customer ID
 * @param serviceType Service type to upgrade
 * @param newTier New tier (must be higher than current)
 * @param clock DBClock for timestamps
 * @returns Phase 1 result with charge info
 */
export async function prepareTierUpgradePhase1Locked(
  tx: LockedTransaction,
  customerId: number,
  serviceType: ServiceType,
  newTier: ServiceTier,
  clock: DBClock
): Promise<TierUpgradePhase1Result> {
  // Get current service
  const [service] = await tx
    .select()
    .from(serviceInstances)
    .where(and(
      eq(serviceInstances.customerId, customerId),
      eq(serviceInstances.serviceType, serviceType)
    ))
    .limit(1);

  if (!service) {
    return {
      canProceed: false,
      chargeAmountUsdCents: 0,
      error: 'Service not found',
    };
  }

  // Block tier changes if cancellation is scheduled
  if (service.cancellationScheduledFor) {
    return {
      canProceed: false,
      chargeAmountUsdCents: 0,
      error: 'Cannot change tier while cancellation is scheduled. Please undo the cancellation first.',
    };
  }

  // Validate upgrade (new tier must be higher priced)
  const currentTierPrice = getTierPriceUsdCents(service.tier);
  const newTierPrice = getTierPriceUsdCents(newTier);

  if (newTierPrice <= currentTierPrice) {
    return {
      canProceed: false,
      chargeAmountUsdCents: 0,
      error: 'New tier must have higher price than current tier. Use downgrade for lower tiers.',
    };
  }

  // If user has never paid, use simple single-transaction path
  if (!service.paidOnce) {
    return {
      canProceed: true,
      currentTier: service.tier,
      chargeAmountUsdCents: 0,
      serviceType,
      useSimplePath: true,
    };
  }

  // Calculate pro-rated charge
  const chargeAmountCents = calculateProRatedUpgradeCharge(
    currentTierPrice,
    newTierPrice,
    clock
  );

  // If charge is $0 (grace period), use simple single-transaction path
  if (chargeAmountCents === 0) {
    return {
      canProceed: true,
      currentTier: service.tier,
      chargeAmountUsdCents: 0,
      serviceType,
      useSimplePath: true,
    };
  }

  return {
    canProceed: true,
    currentTier: service.tier,
    chargeAmountUsdCents: chargeAmountCents,
    serviceType,
    description: `${serviceType} tier upgrade: ${service.tier} → ${newTier} (pro-rated)`,
  };
}

/**
 * Create upgrade invoice (COMMITS IMMEDIATELY, NO LOCK REQUIRED)
 *
 * Called between Phase 1 and Phase 2 locks. The invoice is committed
 * immediately to ensure an audit trail exists before the on-chain charge.
 *
 * @param customerId Customer ID
 * @param phase1Result Result from prepareTierUpgradePhase1Locked
 * @param clock DBClock for timestamps
 * @returns Invoice ID
 */
export async function createUpgradeInvoiceCommitted(
  customerId: number,
  phase1Result: TierUpgradePhase1Result,
  clock: DBClock
): Promise<string> {
  if (!phase1Result.canProceed || !phase1Result.description) {
    throw new Error('Cannot create invoice: Phase 1 did not succeed');
  }

  return await createPendingInvoiceCommitted(
    {
      customerId,
      amountUsdCents: phase1Result.chargeAmountUsdCents,
      type: 'charge',
      description: phase1Result.description,
      billingPeriodStart: clock.now(),
      billingPeriodEnd: getEndOfMonth(clock),
      dueDate: clock.now(),
      lineItem: {
        itemType: INVOICE_LINE_ITEM_TYPE.TIER_UPGRADE,
        serviceType: phase1Result.serviceType,
        quantity: 1,
        unitPriceUsdCents: phase1Result.chargeAmountUsdCents,
        amountUsdCents: phase1Result.chargeAmountUsdCents,
      },
    },
    clock
  );
}

/**
 * Phase 2: Execute payment and update tier (REQUIRES LOCK)
 *
 * Call via withCustomerLockForAPI in route code.
 * Re-validates state, processes payment, and updates the tier if successful.
 *
 * @param tx Locked transaction from withCustomerLockForAPI
 * @param customerId Customer ID
 * @param serviceType Service type to upgrade
 * @param newTier New tier
 * @param expectedCurrentTier Expected current tier (from Phase 1)
 * @param invoiceId Pre-created invoice ID
 * @param suiService Sui service for payment
 * @param clock DBClock for timestamps
 * @returns Upgrade result
 */
export async function executeTierUpgradePhase2Locked(
  tx: LockedTransaction,
  customerId: number,
  serviceType: ServiceType,
  newTier: ServiceTier,
  expectedCurrentTier: ServiceTier,
  invoiceId: string,
  suiService: ISuiService,
  clock: DBClock
): Promise<TierUpgradeResult> {
  // Re-validate that tier hasn't changed since Phase 1
  const [service] = await tx
    .select()
    .from(serviceInstances)
    .where(and(
      eq(serviceInstances.customerId, customerId),
      eq(serviceInstances.serviceType, serviceType)
    ))
    .limit(1);

  if (!service || service.tier !== expectedCurrentTier) {
    // Tier changed between phases - void invoice
    await voidInvoice(tx, invoiceId, 'Tier changed during upgrade - operation cancelled');
    return {
      success: false,
      newTier,
      chargeAmountUsdCents: 0,
      invoiceId,
      error: 'Service tier changed. Please retry the upgrade.',
    };
  }

  if (service.cancellationScheduledFor) {
    await voidInvoice(tx, invoiceId, 'Cancellation scheduled during upgrade - operation cancelled');
    return {
      success: false,
      newTier,
      chargeAmountUsdCents: 0,
      invoiceId,
      error: 'Cannot change tier while cancellation is scheduled.',
    };
  }

  // Process payment on the pre-created invoice
  const paymentResult = await processInvoicePayment(
    tx,
    invoiceId,
    suiService,
    clock
  );

  if (!paymentResult.fullyPaid) {
    // Payment failed - void the invoice (immediate operations don't retry)
    await voidInvoice(tx, invoiceId, paymentResult.error?.message || 'Payment failed');
    return {
      success: false,
      newTier,
      chargeAmountUsdCents: paymentResult.amountPaidCents,
      invoiceId,
      error: paymentResult.error?.message || 'Payment failed',
    };
  }

  // Payment succeeded - update tier immediately
  await tx
    .update(serviceInstances)
    .set({
      tier: newTier,
      scheduledTier: null,
      scheduledTierEffectiveDate: null,
      cancellationScheduledFor: null,
    })
    .where(eq(serviceInstances.instanceId, service.instanceId));

  // Recalculate DRAFT invoice for next billing cycle
  await recalculateDraftInvoice(tx, customerId, clock);

  return {
    success: true,
    newTier,
    chargeAmountUsdCents: paymentResult.amountPaidCents,
    invoiceId,
  };
}

// ============================================================================
// Tier Downgrade (Scheduled Effect)
// ============================================================================

/**
 * Schedule tier downgrade for end of billing period (INTERNAL - REQUIRES LOCK)
 *
 * Use this when you already hold the customer lock via withCustomerLockForAPI().
 * For standalone calls, use scheduleTierDowngrade() which acquires the lock.
 *
 * Per BILLING_DESIGN.md R13.2:
 * - Takes effect at start of next billing period (1st of month)
 * - No immediate charge (customer already paid for current tier)
 * - Reversible before period ends
 * - Last scheduled tier before period end wins
 *
 * @param tx Locked transaction (from withCustomerLockForAPI)
 * @param customerId Customer ID
 * @param serviceType Service type to downgrade
 * @param newTier New tier (must be lower than current)
 * @param clock DBClock for timestamps
 * @returns Downgrade result
 */
export async function scheduleTierDowngradeLocked(
  tx: LockedTransaction,
  customerId: number,
  serviceType: ServiceType,
  newTier: ServiceTier,
  clock: DBClock
): Promise<TierDowngradeResult> {
  // 1. Get current service
  const [service] = await tx
    .select()
    .from(serviceInstances)
    .where(and(
      eq(serviceInstances.customerId, customerId),
      eq(serviceInstances.serviceType, serviceType)
    ))
    .limit(1);

  if (!service) {
    return {
      success: false,
      scheduledTier: newTier,
      effectiveDate: new Date(0),
      error: 'Service not found',
    };
  }

  // 1.5. Block tier changes if cancellation is scheduled
  // User must explicitly undo cancellation first to avoid confusing state transitions
  if (service.cancellationScheduledFor) {
    return {
      success: false,
      scheduledTier: newTier,
      effectiveDate: new Date(0),
      error: 'Cannot change tier while cancellation is scheduled. Please undo the cancellation first.',
    };
  }

  // 2. Validate downgrade (new tier must be lower priced)
  const currentTierPrice = getTierPriceUsdCents(service.tier);
  const newTierPrice = getTierPriceUsdCents(newTier);

  if (newTierPrice >= currentTierPrice) {
    return {
      success: false,
      scheduledTier: newTier,
      effectiveDate: new Date(0),
      error: 'New tier must have lower price than current tier. Use upgrade for higher tiers.',
    };
  }

  // 2.5. If user has never paid, allow immediate tier change (no scheduling needed)
  // This handles the case where user subscribed but hasn't completed payment yet
  if (!service.paidOnce) {
    await tx
      .update(serviceInstances)
      .set({
        tier: newTier,
        // Clear any scheduled changes
        scheduledTier: null,
        scheduledTierEffectiveDate: null,
        cancellationScheduledFor: null,
      })
      .where(eq(serviceInstances.instanceId, service.instanceId));

    // Update pending billing record to reflect the new tier price
    // This ensures reconcilePayments charges the correct amount
    await tx
      .update(billingRecords)
      .set({
        amountUsdCents: newTierPrice,
      })
      .where(
        and(
          eq(billingRecords.customerId, customerId),
          // Only update non-paid, non-draft records (pending or failed)
          sql`${billingRecords.status} NOT IN ('paid', 'draft')`
        )
      );

    // Recalculate DRAFT invoice to reflect the new tier
    await recalculateDraftInvoice(tx, customerId, clock);

    return {
      success: true,
      scheduledTier: newTier,
      effectiveDate: clock.now(), // Effective immediately
    };
  }

  // 3. Calculate effective date (1st of next month)
  const effectiveDate = getFirstOfNextMonth(clock);

  // 4. Schedule the downgrade
  await tx
    .update(serviceInstances)
    .set({
      scheduledTier: newTier,
      scheduledTierEffectiveDate: effectiveDate.toISOString().split('T')[0],
      // Clear any cancellation since user is changing tier
      cancellationScheduledFor: null,
    })
    .where(eq(serviceInstances.instanceId, service.instanceId));

  // 5. Update DRAFT invoice to reflect scheduled change
  await recalculateDraftInvoiceWithScheduledTier(tx, customerId, clock);

  return {
    success: true,
    scheduledTier: newTier,
    effectiveDate,
  };
}

/**
 * Cancel a scheduled tier change (INTERNAL - REQUIRES LOCK)
 *
 * Clears scheduled_tier and scheduled_tier_effective_date.
 * Customer continues at current tier.
 *
 * @param tx Locked transaction (from withCustomerLockForAPI)
 */
export async function cancelScheduledTierChangeLocked(
  tx: LockedTransaction,
  customerId: number,
  serviceType: ServiceType,
  clock: DBClock
): Promise<{ success: boolean; error?: string }> {
  const [service] = await tx
    .select()
    .from(serviceInstances)
    .where(and(
      eq(serviceInstances.customerId, customerId),
      eq(serviceInstances.serviceType, serviceType)
    ))
    .limit(1);

  if (!service) {
    return { success: false, error: 'Service not found' };
  }

  if (!service.scheduledTier) {
    return { success: false, error: 'No tier change scheduled' };
  }

  await tx
    .update(serviceInstances)
    .set({
      scheduledTier: null,
      scheduledTierEffectiveDate: null,
    })
    .where(eq(serviceInstances.instanceId, service.instanceId));

  // Recalculate DRAFT to use current tier
  await recalculateDraftInvoice(tx, customerId, clock);

  return { success: true };
}

// ============================================================================
// Cancellation
// ============================================================================

/**
 * Schedule subscription cancellation for end of billing period (INTERNAL - REQUIRES LOCK)
 *
 * Per BILLING_DESIGN.md R13.3:
 * - Service continues operating until end of billing period
 * - No refund for current period (already paid)
 * - Freely reversible before period ends
 * - Service removed from next month's DRAFT invoice
 *
 * @param tx Locked transaction (from withCustomerLockForAPI)
 * @param customerId Customer ID
 * @param serviceType Service type to cancel
 * @param clock DBClock for timestamps
 * @returns Cancellation result
 */
export async function scheduleCancellationLocked(
  tx: LockedTransaction,
  customerId: number,
  serviceType: ServiceType,
  clock: DBClock
): Promise<CancellationResult> {
  // 1. Get current service
  const [service] = await tx
    .select()
    .from(serviceInstances)
    .where(and(
      eq(serviceInstances.customerId, customerId),
      eq(serviceInstances.serviceType, serviceType)
    ))
    .limit(1);

  if (!service) {
    return {
      success: false,
      effectiveDate: new Date(0),
      error: 'Service not found',
    };
  }

  // 2. Validate service state - can only cancel active subscriptions
  if (service.state === 'not_provisioned' || service.state === 'cancellation_pending') {
    return {
      success: false,
      effectiveDate: new Date(0),
      error: `Cannot cancel service in state: ${service.state}`,
    };
  }

  // 2.5. If user has never paid, allow immediate cancellation (delete service instance)
  // This handles "change of mind" before first payment - no cost to us
  // No cooldown period needed since they never actually used the service
  if (!service.paidOnce) {
    await tx
      .delete(serviceInstances)
      .where(eq(serviceInstances.instanceId, service.instanceId));

    return {
      success: true,
      effectiveDate: clock.now(), // Effective immediately
    };
  }

  // 3. Calculate effective date (end of current billing period = last day of month)
  const effectiveDate = getEndOfMonth(clock);

  // 4. Schedule the cancellation
  await tx
    .update(serviceInstances)
    .set({
      cancellationScheduledFor: effectiveDate.toISOString().split('T')[0],
      // Clear any scheduled tier change since service is being cancelled
      scheduledTier: null,
      scheduledTierEffectiveDate: null,
    })
    .where(eq(serviceInstances.instanceId, service.instanceId));

  // 5. Update DRAFT invoice to remove this service
  await recalculateDraftInvoiceWithCancellation(tx, customerId, clock);

  return {
    success: true,
    effectiveDate,
  };
}

/**
 * Undo a scheduled cancellation (INTERNAL - REQUIRES LOCK)
 *
 * Per BILLING_DESIGN.md R13.4:
 * - No charge (customer already paid for period)
 * - Simply clears cancellation flag
 * - Service re-added to next month's DRAFT invoice
 *
 * @param tx Locked transaction (from withCustomerLockForAPI)
 * @param customerId Customer ID
 * @param serviceType Service type
 * @param clock DBClock for timestamps
 * @returns Undo result
 */
export async function undoCancellationLocked(
  tx: LockedTransaction,
  customerId: number,
  serviceType: ServiceType,
  clock: DBClock
): Promise<UndoCancellationResult> {
  const [service] = await tx
    .select()
    .from(serviceInstances)
    .where(and(
      eq(serviceInstances.customerId, customerId),
      eq(serviceInstances.serviceType, serviceType)
    ))
    .limit(1);

  if (!service) {
    return { success: false, error: 'Service not found' };
  }

  // Cannot undo if already in cancellation_pending state (billing period ended)
  // Check state first since cancellationScheduledFor is cleared when transitioning to cancellation_pending
  if (service.state === 'cancellation_pending') {
    return {
      success: false,
      error: 'Cannot undo cancellation after billing period has ended. Contact support.',
    };
  }

  // Can only undo if cancellation is scheduled
  if (!service.cancellationScheduledFor) {
    return { success: false, error: 'No cancellation scheduled' };
  }

  await tx
    .update(serviceInstances)
    .set({
      cancellationScheduledFor: null,
    })
    .where(eq(serviceInstances.instanceId, service.instanceId));

  // Recalculate DRAFT to re-include this service
  await recalculateDraftInvoice(tx, customerId, clock);

  return { success: true };
}

// ============================================================================
// Anti-Abuse: Re-Provisioning Check
// ============================================================================

/**
 * Check if customer can provision a service
 *
 * Per BILLING_DESIGN.md R13.6:
 * - Block during cancellation_pending state
 * - Block during 7-day cooldown period after deletion
 * - Allows re-subscription after cooldown expires
 *
 * @param db Database instance
 * @param customerId Customer ID
 * @param serviceType Service type to provision
 * @param clock DBClock for timestamps
 * @returns Provision check result
 */
export async function canProvisionService(
  db: Database,
  customerId: number,
  serviceType: ServiceType,
  clock: DBClock
): Promise<CanProvisionResult> {
  const now = clock.now();

  // 1. Check if service already exists
  const [existingService] = await db
    .select()
    .from(serviceInstances)
    .where(and(
      eq(serviceInstances.customerId, customerId),
      eq(serviceInstances.serviceType, serviceType)
    ))
    .limit(1);

  if (existingService) {
    // Check if it's in cancellation_pending state
    if (existingService.state === 'cancellation_pending') {
      return {
        allowed: false,
        reason: 'cancellation_pending',
        availableAt: existingService.cancellationEffectiveAt || undefined,
        message: 'Service is pending deletion. Please wait until the grace period ends.',
      };
    }

    // Service exists and is not in cancellation_pending - already subscribed
    if (existingService.state !== 'not_provisioned') {
      return {
        allowed: false,
        reason: 'already_subscribed',
        message: `Already subscribed to ${serviceType}`,
      };
    }
  }

  // 2. Check cancellation history for cooldown period
  const [recentCancellation] = await db
    .select()
    .from(serviceCancellationHistory)
    .where(and(
      eq(serviceCancellationHistory.customerId, customerId),
      eq(serviceCancellationHistory.serviceType, serviceType),
      gt(serviceCancellationHistory.cooldownExpiresAt, now)
    ))
    .limit(1);

  if (recentCancellation) {
    return {
      allowed: false,
      reason: 'cooldown_period',
      availableAt: recentCancellation.cooldownExpiresAt,
      message: `Re-subscription available after ${recentCancellation.cooldownExpiresAt.toISOString().split('T')[0]}. Contact support for immediate access.`,
    };
  }

  // 3. All checks passed
  return { allowed: true };
}

// ============================================================================
// Key Operation Blocking
// ============================================================================

/**
 * Check if customer can perform key operations (generate/import Seal keys)
 *
 * Key operations are blocked until user has made at least one payment.
 * This prevents abuse where users generate/import keys without paying.
 *
 * @param db Database instance
 * @param customerId Customer ID
 * @param serviceType Service type (only 'seal' supported currently)
 * @returns Whether operation is allowed
 */
export async function canPerformKeyOperation(
  db: Database,
  customerId: number,
  serviceType: ServiceType
): Promise<CanPerformKeyOperationResult> {
  // Get the service instance
  const [service] = await db
    .select()
    .from(serviceInstances)
    .where(and(
      eq(serviceInstances.customerId, customerId),
      eq(serviceInstances.serviceType, serviceType)
    ))
    .limit(1);

  if (!service) {
    return {
      allowed: false,
      reason: 'service_not_found',
      message: 'Service subscription not found. Subscribe first.',
    };
  }

  // Check if service is in an active state
  const activeStates: ServiceState[] = ['enabled', 'disabled'];
  if (!activeStates.includes(service.state as ServiceState)) {
    return {
      allowed: false,
      reason: 'service_not_active',
      message: `Cannot perform key operations while service is in state: ${service.state}`,
    };
  }

  // Check if user has made at least one payment
  if (!service.paidOnce) {
    return {
      allowed: false,
      reason: 'no_payment_yet',
      message: 'Please complete your first payment before generating or importing keys.',
    };
  }

  return { allowed: true };
}

// ============================================================================
// Get Tier Change Options
// ============================================================================

/**
 * Get available tier change options for a service
 *
 * Returns all tiers with pricing information and upgrade/downgrade charges.
 * Used by the "Change Tier" modal.
 *
 * @param db Database instance
 * @param customerId Customer ID
 * @param serviceType Service type
 * @param clock DBClock for timestamps
 * @returns Tier change options
 */
export async function getTierChangeOptions(
  db: Database,
  customerId: number,
  serviceType: ServiceType,
  clock: DBClock
): Promise<TierChangeOptions | null> {
  const [service] = await db
    .select()
    .from(serviceInstances)
    .where(and(
      eq(serviceInstances.customerId, customerId),
      eq(serviceInstances.serviceType, serviceType)
    ))
    .limit(1);

  if (!service) {
    return null;
  }

  const currentTierPrice = getTierPriceUsdCents(service.tier);
  const tiers: ServiceTier[] = ['starter', 'pro', 'enterprise'];

  // Get currently scheduled tier (if any) from the service
  const scheduledTier = service.scheduledTier as ServiceTier | null;
  const scheduledTierEffectiveDate = service.scheduledTierEffectiveDate
    ? new Date(service.scheduledTierEffectiveDate)
    : undefined;

  const availableTiers = tiers.map((tier) => {
    const priceUsdCents = TIER_PRICES_USD_CENTS[tier];
    const isCurrentTier = tier === service.tier;
    const isUpgrade = priceUsdCents > currentTierPrice;
    const isDowngrade = priceUsdCents < currentTierPrice;
    // This tier is scheduled if it matches the currently scheduled downgrade
    const isScheduled = tier === scheduledTier;

    let upgradeChargeCents: number | undefined;
    let effectiveDate: Date | undefined;

    // If user has never paid, all tier changes are immediate with no charge
    if (!service.paidOnce) {
      // No charges, no scheduling - all changes are immediate
      upgradeChargeCents = 0;
      effectiveDate = undefined;
    } else if (isUpgrade) {
      // Calculate pro-rated upgrade charge
      upgradeChargeCents = calculateProRatedUpgradeCharge(
        currentTierPrice,
        priceUsdCents,
        clock
      );
    } else if (isDowngrade) {
      // Downgrade takes effect on 1st of next month
      effectiveDate = getFirstOfNextMonth(clock);
    }

    return {
      tier,
      priceUsdCents,
      upgradeChargeCents,
      effectiveDate,
      isCurrentTier,
      isUpgrade,
      isDowngrade,
      isScheduled,
    };
  });

  return {
    currentTier: service.tier,
    paidOnce: service.paidOnce,
    availableTiers,
    // Scheduled tier change info (downgrade only - upgrades are immediate)
    scheduledTier: scheduledTier ?? undefined,
    scheduledTierEffectiveDate,
    // Cancellation info
    cancellationScheduled: !!service.cancellationScheduledFor,
    cancellationEffectiveDate: service.cancellationScheduledFor
      ? new Date(service.cancellationScheduledFor)
      : undefined,
  };
}

// ============================================================================
// Monthly Billing Integration
// ============================================================================

/**
 * Apply scheduled tier changes at month start
 *
 * Called during monthly billing (1st of month) to apply scheduled downgrades.
 * Per BILLING_DESIGN.md R13.2.
 *
 * @param tx Transaction handle (must have customer lock)
 * @param customerId Customer ID
 * @param clock DBClock for timestamps
 * @returns Number of tier changes applied
 */
export async function applyScheduledTierChanges(
  tx: LockedTransaction,
  customerId: number,
  clock: DBClock
): Promise<number> {
  const today = clock.today();
  const todayStr = today.toISOString().split('T')[0];

  // Find services with scheduled tier changes effective today or earlier
  const servicesWithChanges = await tx
    .select()
    .from(serviceInstances)
    .where(
      and(
        eq(serviceInstances.customerId, customerId),
        isNotNull(serviceInstances.scheduledTier),
        lte(serviceInstances.scheduledTierEffectiveDate, todayStr)
      )
    );

  for (const service of servicesWithChanges) {
    if (service.scheduledTier) {
      await tx
        .update(serviceInstances)
        .set({
          tier: service.scheduledTier,
          scheduledTier: null,
          scheduledTierEffectiveDate: null,
        })
        .where(eq(serviceInstances.instanceId, service.instanceId));
    }
  }

  return servicesWithChanges.length;
}

/**
 * Process scheduled cancellations at month start
 *
 * Called during monthly billing (1st of month) to transition cancelled services
 * to cancellation_pending state.
 * Per BILLING_DESIGN.md R13.5.
 *
 * @param tx Transaction handle (must have customer lock)
 * @param customerId Customer ID
 * @param clock DBClock for timestamps
 * @returns Number of cancellations processed
 */
export async function processScheduledCancellations(
  tx: LockedTransaction,
  customerId: number,
  clock: DBClock
): Promise<number> {
  const today = clock.today();
  const todayStr = today.toISOString().split('T')[0];

  // Find services with scheduled cancellations effective today or earlier
  const cancelledServices = await tx
    .select()
    .from(serviceInstances)
    .where(
      and(
        eq(serviceInstances.customerId, customerId),
        isNotNull(serviceInstances.cancellationScheduledFor),
        lte(serviceInstances.cancellationScheduledFor, todayStr)
      )
    );

  // Calculate cancellation effective date (7 days from now)
  const cancellationEffectiveAt = clock.addDays(7);

  for (const service of cancelledServices) {
    await tx
      .update(serviceInstances)
      .set({
        state: 'cancellation_pending',
        isUserEnabled: false,
        cancellationScheduledFor: null,
        cancellationEffectiveAt,
      })
      .where(eq(serviceInstances.instanceId, service.instanceId));
  }

  return cancelledServices.length;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the end of the current month (last day, 23:59:59.999 UTC)
 */
function getEndOfMonth(clock: DBClock): Date {
  const today = clock.today();
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();

  // Create date for 0th day of next month = last day of current month
  // Then set to end of day
  const lastDay = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));
  return lastDay;
}

/**
 * Get the first day of the next month (00:00:00 UTC)
 */
function getFirstOfNextMonth(clock: DBClock): Date {
  const today = clock.today();
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();

  // Create date for 1st day of next month
  return new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
}

/**
 * Recalculate DRAFT invoice accounting for scheduled tier change
 *
 * Uses scheduled_tier for billing amount if present.
 */
async function recalculateDraftInvoiceWithScheduledTier(
  tx: LockedTransaction,
  customerId: number,
  clock: DBClock
): Promise<void> {
  // Get DRAFT invoice
  const draftId = await getOrCreateDraftInvoice(tx, customerId, clock);

  // Get all services, using scheduled_tier where applicable
  const services = await tx
    .select()
    .from(serviceInstances)
    .where(eq(serviceInstances.customerId, customerId));

  let totalUsdCents = 0;

  for (const service of services) {
    // Skip cancelled services
    if (service.cancellationScheduledFor) {
      continue;
    }

    // Use scheduled tier if present, otherwise current tier
    const effectiveTier = service.scheduledTier || service.tier;
    const tierPriceCents = getTierPriceUsdCents(effectiveTier);
    totalUsdCents += tierPriceCents;
  }

  await updateDraftInvoiceAmount(tx, draftId, totalUsdCents);
}

/**
 * Recalculate DRAFT invoice accounting for scheduled cancellation
 *
 * Excludes services with cancellation_scheduled_for set.
 */
async function recalculateDraftInvoiceWithCancellation(
  tx: LockedTransaction,
  customerId: number,
  clock: DBClock
): Promise<void> {
  // Get DRAFT invoice
  const draftId = await getOrCreateDraftInvoice(tx, customerId, clock);

  // Get all services, excluding cancelled ones
  const services = await tx
    .select()
    .from(serviceInstances)
    .where(eq(serviceInstances.customerId, customerId));

  let totalUsdCents = 0;

  for (const service of services) {
    // Skip cancelled services
    if (service.cancellationScheduledFor) {
      continue;
    }

    // Use scheduled tier if present, otherwise current tier
    const effectiveTier = service.scheduledTier || service.tier;
    const tierPriceCents = getTierPriceUsdCents(effectiveTier);
    totalUsdCents += tierPriceCents;
  }

  await updateDraftInvoiceAmount(tx, draftId, totalUsdCents);
}

// ============================================================================
// Convenience Wrappers (acquire lock internally)
// For testing and internal use. API routes should use withCustomerLockForAPI.
// ============================================================================

/**
 * Handle tier upgrade (convenience wrapper with internal locking)
 */
export async function handleTierUpgrade(
  database: Database,
  customerId: number,
  serviceType: ServiceType,
  newTier: ServiceTier,
  suiService: ISuiService,
  clock: DBClock
): Promise<TierUpgradeResult> {
  return await withCustomerLock(database, customerId, async (tx) => {
    return await handleTierUpgradeLocked(tx, customerId, serviceType, newTier, suiService, clock);
  });
}

/**
 * Schedule tier downgrade (convenience wrapper with internal locking)
 */
export async function scheduleTierDowngrade(
  database: Database,
  customerId: number,
  serviceType: ServiceType,
  newTier: ServiceTier,
  clock: DBClock
): Promise<TierDowngradeResult> {
  return await withCustomerLock(database, customerId, async (tx) => {
    return await scheduleTierDowngradeLocked(tx, customerId, serviceType, newTier, clock);
  });
}

/**
 * Cancel scheduled tier change (convenience wrapper with internal locking)
 */
export async function cancelScheduledTierChange(
  database: Database,
  customerId: number,
  serviceType: ServiceType,
  clock: DBClock
): Promise<{ success: boolean; error?: string }> {
  return await withCustomerLock(database, customerId, async (tx) => {
    return await cancelScheduledTierChangeLocked(tx, customerId, serviceType, clock);
  });
}

/**
 * Schedule cancellation (convenience wrapper with internal locking)
 */
export async function scheduleCancellation(
  database: Database,
  customerId: number,
  serviceType: ServiceType,
  clock: DBClock
): Promise<CancellationResult> {
  return await withCustomerLock(database, customerId, async (tx) => {
    return await scheduleCancellationLocked(tx, customerId, serviceType, clock);
  });
}

/**
 * Undo cancellation (convenience wrapper with internal locking)
 */
export async function undoCancellation(
  database: Database,
  customerId: number,
  serviceType: ServiceType,
  clock: DBClock
): Promise<UndoCancellationResult> {
  return await withCustomerLock(database, customerId, async (tx) => {
    return await undoCancellationLocked(tx, customerId, serviceType, clock);
  });
}
