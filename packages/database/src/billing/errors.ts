/**
 * Billing Error Classes
 *
 * Typed errors for distinguishing validation errors (permanent) from system errors (transient).
 * Used by idempotency logic to determine whether to cache failure results.
 */

/**
 * Validation error - permanent data issue
 *
 * These errors indicate bugs in business logic or data:
 * - DRAFT amount doesn't match services
 * - Negative invoice amounts
 * - Duplicate DRAFT invoices
 *
 * Safe to cache - retrying won't help, data needs manual fix.
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * System error - transient infrastructure issue
 *
 * These errors might resolve on retry:
 * - Database timeouts
 * - Network issues
 * - Temporary service unavailability
 *
 * Should NOT be cached - allow retry in 5 minutes.
 */
export class SystemError extends Error {
  constructor(
    message: string,
    public originalError?: Error
  ) {
    super(message);
    this.name = 'SystemError';
  }
}
