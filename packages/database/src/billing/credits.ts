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
  const now = clock.now();
  const result: CreditApplicationResult = {
    creditsApplied: [],
    totalAppliedCents: 0,
    remainingInvoiceAmountCents: invoiceAmountCents,
  };

  // If invoice is already paid, nothing to apply
  if (invoiceAmountCents <= 0) {
    return result;
  }

  // Get all available credits, ordered by expiration (oldest first)
  // Skip expired credits (they're kept for audit trail but not used)
  const availableCredits = await tx
    .select()
    .from(customerCredits)
    .where(
      and(
        eq(customerCredits.customerId, customerId),
        gt(customerCredits.remainingAmountUsdCents, 0),
        // Only include non-expired credits
        sql`(${customerCredits.expiresAt} IS NULL OR ${customerCredits.expiresAt} > ${now})`
      )
    )
    .orderBy(
      // Order by: expiring credits first (nulls last = never expiring)
      sql`${customerCredits.expiresAt} NULLS LAST`
    );

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
  reason: string,
  description: string,
  expiresAt: Date | null = null,
  campaignId: string | null = null
): Promise<number> {
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
