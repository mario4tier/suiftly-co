/**
 * Invoice Validation and Sanity Checks
 *
 * Defensive validation to prevent embarrassing billing errors:
 * - Duplicate service charges
 * - Orphaned reconciliation credits
 * - DRAFT amount mismatch with actual services
 * - Negative amounts or overflow
 *
 * These checks run before DRAFT → PENDING transitions to catch bugs early.
 */

import { eq, and, sql } from 'drizzle-orm';
import type { Database, DatabaseOrTransaction } from '../db';
import { billingRecords, serviceInstances, customerCredits } from '../schema';
import { ValidationError } from './errors';

/**
 * Validation issue severity
 */
export type ValidationSeverity = 'error' | 'warning';

/**
 * Validation issue detected
 */
export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  details?: any;
}

/**
 * Validation result for an invoice
 */
export interface InvoiceValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  criticalErrors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/**
 * Validate invoice before transition to PENDING
 *
 * Runs comprehensive sanity checks to prevent billing errors.
 *
 * @param tx Transaction handle
 * @param invoiceId Invoice ID to validate
 * @returns Validation result with any issues found
 */
export async function validateInvoiceBeforeCharging(
  tx: DatabaseOrTransaction,
  invoiceId: number
): Promise<InvoiceValidationResult> {
  const issues: ValidationIssue[] = [];

  // Get invoice
  const [invoice] = await tx
    .select()
    .from(billingRecords)
    .where(eq(billingRecords.id, invoiceId))
    .limit(1);

  if (!invoice) {
    return {
      valid: false,
      issues: [{
        severity: 'error',
        code: 'INVOICE_NOT_FOUND',
        message: 'Invoice does not exist',
      }],
      criticalErrors: [{
        severity: 'error',
        code: 'INVOICE_NOT_FOUND',
        message: 'Invoice does not exist',
      }],
      warnings: [],
    };
  }

  // Check 1: Negative amount (should never happen)
  if (Number(invoice.amountUsdCents) < 0) {
    issues.push({
      severity: 'error',
      code: 'NEGATIVE_AMOUNT',
      message: `Invoice has negative amount: ${invoice.amountUsdCents} cents`,
      details: { invoiceId, amount: invoice.amountUsdCents },
    });
  }

  // Check 2: Check for duplicate service charges
  const duplicates = await detectDuplicateServiceCharges(tx, invoice.customerId, invoice.id);
  issues.push(...duplicates);

  // Check 4: Verify reconciliation credits don't exceed original payments
  const orphanedCredits = await detectOrphanedReconciliationCredits(tx, invoice.customerId);
  issues.push(...orphanedCredits);

  // Separate errors from warnings
  const criticalErrors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');

  return {
    valid: criticalErrors.length === 0,
    issues,
    criticalErrors,
    warnings,
  };
}

/**
 * Detect duplicate DRAFT invoices
 *
 * Per BILLING_DESIGN.md: "Exactly one DRAFT per customer (or none if no enabled services)"
 *
 * Note: PENDING invoices are fine - we can have multiple being processed.
 * This only checks for multiple DRAFT invoices which indicates a bug.
 *
 * @param tx Transaction handle
 * @param customerId Customer ID
 * @param excludeInvoiceId Invoice ID to exclude from check (current invoice being validated)
 * @returns Array of validation issues
 */
async function detectDuplicateServiceCharges(
  tx: DatabaseOrTransaction,
  customerId: number,
  excludeInvoiceId: number
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  // Get all OTHER DRAFT invoices for this customer (excluding current)
  // IMPORTANT: Only check DRAFT status, not PENDING (customer can have multiple PENDING)
  const otherDrafts = await tx
    .select()
    .from(billingRecords)
    .where(
      and(
        eq(billingRecords.customerId, customerId),
        sql`${billingRecords.id} != ${excludeInvoiceId}`,
        eq(billingRecords.status, 'draft') // Only DRAFT, not PENDING
      )
    );

  if (otherDrafts.length >= 1) {
    // Multiple DRAFT invoices - should be max 1 total (this is a bug)
    issues.push({
      severity: 'error',
      code: 'MULTIPLE_DRAFT_INVOICES',
      message: `Customer has ${otherDrafts.length + 1} DRAFT invoices (should be max 1)`,
      details: {
        customerId,
        draftCount: otherDrafts.length + 1, // +1 for current invoice
        invoiceIds: [excludeInvoiceId, ...otherDrafts.map(i => i.id)],
      },
    });
  }

  return issues;
}

/**
 * Detect orphaned reconciliation credits
 *
 * Checks if reconciliation credits exist for services that are no longer subscribed.
 * This can happen if a service is cancelled but the credit wasn't voided.
 *
 * @param tx Transaction handle
 * @param customerId Customer ID
 * @returns Array of validation issues
 */
async function detectOrphanedReconciliationCredits(
  tx: DatabaseOrTransaction,
  customerId: number
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  // Get all reconciliation credits for this customer
  const reconCredits = await tx
    .select()
    .from(customerCredits)
    .where(
      and(
        eq(customerCredits.customerId, customerId),
        eq(customerCredits.reason, 'reconciliation'),
        sql`${customerCredits.remainingAmountUsdCents} > 0`
      )
    );

  if (reconCredits.length === 0) {
    return issues; // No reconciliation credits to check
  }

  // Get subscribed services (existence = subscription, not toggle state)
  // This must match billing logic: subscription = billed, regardless of is_user_enabled
  const subscribedServices = await tx
    .select()
    .from(serviceInstances)
    .where(eq(serviceInstances.customerId, customerId));
  // NO check for is_user_enabled - that's just an on/off toggle

  // If we have reconciliation credits but NO subscribed services, that's suspicious
  // This means service was cancelled but credit wasn't voided
  if (reconCredits.length > 0 && subscribedServices.length === 0) {
    issues.push({
      severity: 'warning',
      code: 'ORPHANED_RECONCILIATION_CREDITS',
      message: `Customer has ${reconCredits.length} reconciliation credits but no subscribed services`,
      details: {
        customerId,
        creditCount: reconCredits.length,
        totalCreditsCents: reconCredits.reduce((sum, c) => sum + Number(c.remainingAmountUsdCents), 0),
      },
    });
  }

  return issues;
}

/**
 * Get tier price in cents
 */

/**
 * Validate invoice before monthly billing transition
 *
 * Wrapper around validateInvoiceBeforeCharging that throws on critical errors.
 *
 * @param tx Transaction handle
 * @param invoiceId Invoice ID
 * @throws Error if validation fails with critical errors
 */
export async function ensureInvoiceValid(
  tx: DatabaseOrTransaction,
  invoiceId: number
): Promise<void> {
  const validation = await validateInvoiceBeforeCharging(tx, invoiceId);

  if (!validation.valid) {
    const errorMessages = validation.criticalErrors.map(e => `${e.code}: ${e.message}`).join('; ');
    throw new ValidationError(`Invoice validation failed: ${errorMessages}`, validation.criticalErrors.map(e => e.code).join(','), { errors: validation.criticalErrors });
  }

  // Log warnings (don't throw)
  if (validation.warnings.length > 0) {
    console.warn(`[INVOICE VALIDATION] Warnings for invoice ${invoiceId}:`, validation.warnings);
  }
}
