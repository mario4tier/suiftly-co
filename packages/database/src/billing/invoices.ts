/**
 * Invoice Management
 *
 * Handles creation and lifecycle of billing invoices (DRAFT, PENDING, PAID, FAILED, VOIDED).
 *
 * See BILLING_DESIGN.md for invoice lifecycle and DRAFT model requirements.
 */

import { eq, and, sql } from 'drizzle-orm';
import type { Database, DatabaseOrTransaction } from '../db';
import type { LockedTransaction } from './locking';
import { billingRecords, customers } from '../schema';
import type { DBClock } from '@suiftly/shared/db-clock';

/**
 * Line item for an invoice
 */
export interface InvoiceLineItem {
  description: string;
  amountUsdCents: number;
  serviceType?: string;
  quantity?: number;
}

/**
 * Parameters for creating an invoice
 */
export interface CreateInvoiceParams {
  customerId: number;
  amountUsdCents: number;
  type: 'charge' | 'credit' | 'deposit' | 'withdraw';
  status: 'draft' | 'pending';
  description: string;
  invoiceNumber?: string;
  billingPeriodStart?: Date;
  billingPeriodEnd?: Date;
  dueDate?: Date;
}

/**
 * Create a new invoice
 *
 * @param tx Transaction handle
 * @param params Invoice parameters
 * @param clock DBClock for timestamps
 * @returns Created invoice ID
 */
export async function createInvoice(
  tx: DatabaseOrTransaction,
  params: CreateInvoiceParams,
  clock: DBClock
): Promise<string> {
  const now = clock.now();
  const periodStart = params.billingPeriodStart || now;
  const periodEnd = params.billingPeriodEnd || clock.addDays(30);

  const [invoice] = await tx
    .insert(billingRecords)
    .values({
      customerId: params.customerId,
      billingPeriodStart: periodStart,
      billingPeriodEnd: periodEnd,
      amountUsdCents: params.amountUsdCents,
      type: params.type,
      status: params.status,
      invoiceNumber: params.invoiceNumber,
      dueDate: params.dueDate,
      createdAt: now,
    })
    .returning({ id: billingRecords.id });

  return invoice.id;
}

/**
 * Get or create DRAFT invoice for a customer
 *
 * Per BILLING_DESIGN.md: "Exactly one DRAFT per customer (or none if no enabled services)"
 *
 * @param tx Transaction handle (must have customer lock)
 * @param customerId Customer ID
 * @param clock DBClock for timestamps
 * @returns Existing or newly created DRAFT invoice ID
 */
export async function getOrCreateDraftInvoice(
  tx: LockedTransaction,
  customerId: number,
  clock: DBClock
): Promise<string> {
  // Check for existing DRAFT
  const [existingDraft] = await tx
    .select()
    .from(billingRecords)
    .where(and(
      eq(billingRecords.customerId, customerId),
      eq(billingRecords.status, 'draft')
    ))
    .limit(1);

  if (existingDraft) {
    return existingDraft.id;
  }

  // Create new DRAFT for next billing period
  const today = clock.today();
  const nextMonth = new Date(today);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1); // 1st of next month

  const periodStart = new Date(Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1, 0)); // Last day of month

  const invoiceNumber = await generateInvoiceNumber(tx, clock);

  return await createInvoice(
    tx,
    {
      customerId,
      amountUsdCents: 0, // Will be calculated by caller
      type: 'charge',
      status: 'draft',
      description: 'Monthly subscription charges',
      invoiceNumber,
      billingPeriodStart: periodStart,
      billingPeriodEnd: periodEnd,
      dueDate: periodStart, // Due on 1st of month
    },
    clock
  );
}

/**
 * Generate invoice number
 *
 * Format: INV-YYYY-MM-NNNN
 * NNNN is sequential within the month
 *
 * @param tx Transaction handle
 * @param clock DBClock for date
 * @returns Invoice number
 */
export async function generateInvoiceNumber(
  tx: DatabaseOrTransaction,
  clock: DBClock
): Promise<string> {
  const today = clock.today();
  const year = today.getUTCFullYear();
  const month = String(today.getUTCMonth() + 1).padStart(2, '0');
  const yearMonth = `${year}-${month}`;

  // Get count of invoices this month
  const pattern = `INV-${yearMonth}-%`;
  const result = await tx
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(billingRecords)
    .where(sql`${billingRecords.invoiceNumber} LIKE ${pattern}`);

  const count = result[0]?.count ?? 0;
  const sequence = String(count + 1).padStart(4, '0');

  return `INV-${yearMonth}-${sequence}`;
}

/**
 * Update DRAFT invoice amount
 *
 * Recalculates and updates the DRAFT invoice total based on enabled services.
 * Called when service configuration changes.
 *
 * @param tx Transaction handle (must have customer lock)
 * @param draftInvoiceId DRAFT invoice ID
 * @param newAmountUsdCents New total amount
 */
export async function updateDraftInvoiceAmount(
  tx: LockedTransaction,
  draftInvoiceId: string,
  newAmountUsdCents: number
): Promise<void> {
  await tx
    .update(billingRecords)
    .set({ amountUsdCents: newAmountUsdCents })
    .where(eq(billingRecords.id, draftInvoiceId));
}

/**
 * Transition DRAFT invoice to PENDING
 *
 * Called on the 1st of the month by billing processor.
 *
 * @param tx Transaction handle
 * @param draftInvoiceId DRAFT invoice ID
 */
export async function transitionDraftToPending(
  tx: DatabaseOrTransaction,
  draftInvoiceId: string
): Promise<void> {
  await tx
    .update(billingRecords)
    .set({ status: 'pending' })
    .where(eq(billingRecords.id, draftInvoiceId));
}

/**
 * Create immediate invoice and attempt payment
 *
 * Used for mid-cycle charges (tier upgrades, add-ons).
 * Creates PENDING invoice and immediately attempts payment.
 *
 * @param tx Transaction handle (must have customer lock)
 * @param params Invoice parameters
 * @param clock DBClock for timestamps
 * @returns Invoice ID
 */
export async function createAndChargeImmediately(
  tx: LockedTransaction,
  params: CreateInvoiceParams,
  clock: DBClock
): Promise<string> {
  // Override status to PENDING (immediate charge)
  const invoiceParams = {
    ...params,
    status: 'pending' as const,
  };

  return await createInvoice(tx, invoiceParams, clock);
}

/**
 * Void an invoice
 *
 * Used for billing errors or corrections.
 *
 * @param tx Transaction handle
 * @param invoiceId Invoice ID to void
 * @param reason Reason for voiding
 */
export async function voidInvoice(
  tx: DatabaseOrTransaction,
  invoiceId: string,
  reason: string
): Promise<void> {
  await tx
    .update(billingRecords)
    .set({
      status: 'voided',
      failureReason: reason,
    })
    .where(eq(billingRecords.id, invoiceId));
}
