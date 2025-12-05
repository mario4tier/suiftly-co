/**
 * Admin Notification System
 *
 * Logs internal errors that require admin attention.
 * Used for billing validation failures, system errors, etc.
 */

import type { Database, DatabaseOrTransaction } from '../db';
import { adminNotifications } from '../schema/admin';

/**
 * Severity levels for admin notifications
 */
export type NotificationSeverity = 'error' | 'warning' | 'info';

/**
 * Parameters for logging an internal error
 */
export interface LogInternalErrorParams {
  severity: NotificationSeverity;
  category: string; // 'billing', 'system', 'security', etc.
  code: string; // Error code
  message: string; // Human-readable message
  details?: any; // Additional context (will be JSON-stringified)
  customerId?: number | string;
  invoiceId?: number;
}

/**
 * Log an internal error to admin_notifications table
 *
 * Call this function whenever validation fails or unexpected errors occur
 * that require admin attention. Errors are also logged to console.
 *
 * @param tx Transaction handle (or db instance)
 * @param params Error details
 * @returns Notification ID
 *
 * @example
 * ```typescript
 * await logInternalError(tx, {
 *   severity: 'error',
 *   category: 'billing',
 *   code: 'DRAFT_AMOUNT_MISMATCH',
 *   message: 'DRAFT invoice amount doesn't match enabled services',
 *   details: { draftAmount: 29, expectedAmount: 9 },
 *   customerId: 12345,
 *   invoiceId: 'uuid-here',
 * });
 * ```
 */
export async function logInternalError(
  tx: DatabaseOrTransaction,
  params: LogInternalErrorParams
): Promise<number> {
  // Log to console for immediate visibility
  const logLevel = params.severity === 'error' ? console.error : console.warn;
  logLevel(`[ADMIN NOTIFICATION] ${params.severity.toUpperCase()}: ${params.code} - ${params.message}`, {
    category: params.category,
    customerId: params.customerId,
    invoiceId: params.invoiceId,
    details: params.details,
  });

  // Store in database
  const [notification] = await tx
    .insert(adminNotifications)
    .values({
      severity: params.severity,
      category: params.category,
      code: params.code,
      message: params.message,
      details: params.details ? JSON.stringify(params.details, null, 2) : null,
      customerId: params.customerId ? String(params.customerId) : null,
      invoiceId: params.invoiceId != null ? String(params.invoiceId) : null,
    })
    .returning({ notificationId: adminNotifications.notificationId });

  return notification.notificationId;
}

/**
 * Log multiple validation issues as admin notifications
 *
 * Convenience function for logging all validation issues from an invoice validation result.
 *
 * @param tx Transaction handle
 * @param invoiceId Invoice ID being validated
 * @param issues Array of validation issues
 * @param customerId Optional customer ID for context
 */
export async function logValidationIssues(
  tx: DatabaseOrTransaction,
  invoiceId: number,
  issues: Array<{ severity: string; code: string; message: string; details?: any }>,
  customerId?: number
): Promise<void> {
  for (const issue of issues) {
    await logInternalError(tx, {
      severity: issue.severity as NotificationSeverity,
      category: 'billing',
      code: issue.code,
      message: issue.message,
      details: issue.details,
      customerId,
      invoiceId,
    });
  }
}
