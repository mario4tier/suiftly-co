/**
 * Credit Application Logic
 *
 * Handles applying customer credits to invoices, including:
 * - Prioritization (oldest expiring first)
 * - Partial credit consumption
 * - Non-rollback guarantee (credits stay applied even if subsequent payments fail)
 *
 * See BILLING_DESIGN.md Section "Multi-Source Payment Flow" for requirements.
 */

import { eq, and, gt, sql, asc } from 'drizzle-orm';
import type { Database, DatabaseOrTransaction } from '../db';
import type { LockedTransaction } from './locking';
import { customerCredits, invoicePayments } from '../schema';
import type { CreditApplicationResult } from './types';
import type { CreditReason } from '../schema/enums';
import type { DBClock } from '@suiftly/shared/db-clock';

/**
 * Apply customer credits to an invoice
 *
 * Credits are applied in order of expiration (oldest expiring first).
 * Credits can be partially consumed. Once applied, credits are NOT rolled back
 * if subsequent payment steps fail.
 *
 * @param tx Transaction handle (must have customer lock)
 * @param customerId Customer ID
 * @param billingRecordId Invoice ID to apply credits to
 * @param invoiceAmountCents Total invoice amount
 * @param clock DBClock for determining current time
 * @returns Details of credits applied
 */
export async function applyCreditsToInvoice(
  tx: LockedTransaction,
  customerId: number,
  billingRecordId: number,
  invoiceAmountCents: number,
  clock: DBClock
): Promise<CreditApplicationResult> {
  const result: CreditApplicationResult = {
    creditsApplied: [],
    totalAppliedCents: 0,
    remainingInvoiceAmountCents: invoiceAmountCents,
  };

  // If invoice is already paid, nothing to apply
  if (invoiceAmountCents <= 0) {
    return result;
  }

  const availableCredits = await getAvailableCreditRows(tx, customerId, clock);

  // Apply credits until invoice is paid or no credits remain
  for (const credit of availableCredits) {
    if (result.remainingInvoiceAmountCents <= 0) {
      break; // Invoice fully paid
    }

    const availableCreditCents = Number(credit.remainingAmountUsdCents);
    const amountToApplyCents = Math.min(
      availableCreditCents,
      result.remainingInvoiceAmountCents
    );

    if (amountToApplyCents <= 0) {
      continue; // Safety check
    }

    // Update credit remaining amount
    const newRemainingCents = availableCreditCents - amountToApplyCents;
    await tx
      .update(customerCredits)
      .set({ remainingAmountUsdCents: newRemainingCents })
      .where(eq(customerCredits.creditId, credit.creditId));

    // Record payment application
    await tx.insert(invoicePayments).values({
      billingRecordId,
      sourceType: 'credit',
      creditId: credit.creditId,
      escrowTransactionId: null,
      amountUsdCents: amountToApplyCents,
    });

    // Track what we applied
    result.creditsApplied.push({
      creditId: credit.creditId,
      amountUsedCents: amountToApplyCents,
      remainingCents: newRemainingCents,
    });

    result.totalAppliedCents += amountToApplyCents;
    result.remainingInvoiceAmountCents -= amountToApplyCents;
  }

  return result;
}

/**
 * Issue a new credit to a customer
 *
 * @param tx Transaction handle
 * @param customerId Customer ID
 * @param amountCents Credit amount in cents
 * @param reason Credit reason ('outage' | 'promo' | 'goodwill' | 'reconciliation')
 * @param description Human-readable description
 * @param expiresAt Optional expiration date (null = never expires)
 * @param campaignId Optional campaign tracking ID
 * @returns Created credit ID
 */
export async function issueCredit(
  tx: DatabaseOrTransaction,
  customerId: number,
  amountCents: number,
  reason: CreditReason,
  description: string,
  expiresAt: Date | null = null,
  campaignId: string | null = null
): Promise<number> {
  if (amountCents <= 0) {
    throw new Error(`issueCredit: amountCents must be positive, got ${amountCents}`);
  }

  const [credit] = await tx
    .insert(customerCredits)
    .values({
      customerId,
      originalAmountUsdCents: amountCents,
      remainingAmountUsdCents: amountCents,
      reason,
      description,
      expiresAt,
      campaignId,
    })
    .returning({ creditId: customerCredits.creditId });

  return credit.creditId;
}

/**
 * Issue a reconciliation credit for partial-month usage when a deferred payment succeeds.
 *
 * When a subscription charge is deferred (no payment method, 3DS pending), the original
 * handleSubscriptionBillingLocked skips the pro-rata credit because fullyPaid was false.
 * This function issues the credit using the invoice's billingPeriodStart (the subscription date).
 *
 * @param tx Transaction handle (must have customer lock)
 * @param customerId Customer ID
 * @param invoice The paid invoice (must have billingType='immediate' and billingPeriodStart)
 * @param serviceType Service type for credit description (e.g. 'seal')
 */
export async function issueReconciliationCredit(
  tx: DatabaseOrTransaction,
  customerId: number,
  invoice: { billingType: string | null; billingPeriodStart: Date | string | null; amountUsdCents: number | string },
  serviceType: string,
): Promise<void> {
  if (invoice.billingType !== 'immediate' || !invoice.billingPeriodStart) return;

  const monthlyPrice = Number(invoice.amountUsdCents);
  if (monthlyPrice <= 0) return; // Guard against zero/negative invoice amounts

  const subscriptionDate = new Date(invoice.billingPeriodStart);
  const year = subscriptionDate.getUTCFullYear();
  const month = subscriptionDate.getUTCMonth() + 1;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const dayOfMonth = subscriptionDate.getUTCDate();
  const daysUsed = daysInMonth - dayOfMonth + 1; // +1 because subscription day is included
  const daysNotUsed = daysInMonth - daysUsed;

  const reconciliationCreditCents = Math.floor(
    (monthlyPrice * daysNotUsed) / daysInMonth
  );

  if (reconciliationCreditCents > 0) {
    const description = `Partial month credit for ${serviceType} (${daysNotUsed}/${daysInMonth} days unused)`;

    // Idempotency guard: this function may be called from multiple paths
    // (retryPendingInvoice, retryUnpaidInvoices, handleInvoicePaid webhook)
    // for the same invoice. The description is deterministic, so we can
    // check for an existing credit with the same description to prevent duplicates.
    const existing = await tx
      .select({ creditId: customerCredits.creditId })
      .from(customerCredits)
      .where(
        and(
          eq(customerCredits.customerId, customerId),
          eq(customerCredits.reason, 'reconciliation'),
          eq(customerCredits.description, description),
        )
      )
      .limit(1);

    if (existing.length > 0) {
      return; // Credit already issued for this exact scenario
    }

    await issueCredit(
      tx,
      customerId,
      reconciliationCreditCents,
      'reconciliation',
      description,
      null,
    );
  }
}

/**
 * Get all available credit rows for a customer (remaining > 0, not expired).
 * Ordered by expiration date (soonest-expiring first, never-expiring last).
 *
 * Used by: applyCreditsToInvoice (payment), recalculateDraftInvoice (preview).
 */
export async function getAvailableCreditRows(
  tx: DatabaseOrTransaction,
  customerId: number,
  clock: DBClock
) {
  const now = clock.now();
  return tx
    .select()
    .from(customerCredits)
    .where(
      and(
        eq(customerCredits.customerId, customerId),
        gt(customerCredits.remainingAmountUsdCents, 0),
        sql`(${customerCredits.expiresAt} IS NULL OR ${customerCredits.expiresAt} > ${now})`
      )
    )
    .orderBy(sql`${customerCredits.expiresAt} NULLS LAST`);
}

/**
 * Get total available credits for a customer
 *
 * @param tx Transaction handle
 * @param customerId Customer ID
 * @param clock DBClock for determining current time
 * @returns Total available credits in cents (excluding expired)
 */
export async function getAvailableCredits(
  tx: DatabaseOrTransaction,
  customerId: number,
  clock: DBClock
): Promise<number> {
  const now = clock.now();

  const result = await tx
    .select({
      total: sql<number>`COALESCE(SUM(${customerCredits.remainingAmountUsdCents}), 0)`,
    })
    .from(customerCredits)
    .where(
      and(
        eq(customerCredits.customerId, customerId),
        gt(customerCredits.remainingAmountUsdCents, 0),
        sql`(${customerCredits.expiresAt} IS NULL OR ${customerCredits.expiresAt} > ${now})`
      )
    );

  return Number(result[0]?.total ?? 0);
}
