/**
 * Customer-Level Locking
 *
 * Uses PostgreSQL advisory locks to ensure only one operation
 * runs per customer at a time, preventing race conditions.
 *
 * ## Design Pattern: Lock-Aware vs Lock-Internal Functions
 *
 * To prevent accidental nested locking (which causes deadlocks), we use two patterns:
 *
 * 1. **Branded Type**: `LockedTransaction` is a branded `DatabaseOrTransaction` that
 *    indicates the customer lock is already held. Functions that need the lock should
 *    accept `LockedTransaction` to signal they expect to be called within a lock.
 *
 * 2. **Naming Convention**:
 *    - `withCustomerLockForAPI()` - THE entry point for routes (with observability)
 *    - Functions taking `tx: LockedTransaction` - Run inside lock, NEVER call lock again
 *    - Functions taking `tx: DatabaseOrTransaction` - Low-level helpers, lock-agnostic
 *
 * ## Re-entrancy Warning
 *
 * PostgreSQL advisory locks are NOT re-entrant within the same session:
 * ```sql
 * SELECT pg_advisory_xact_lock(123);  -- Acquires lock
 * SELECT pg_advisory_xact_lock(123);  -- DEADLOCKS! (waits for itself)
 * ```
 *
 * NEVER call `withCustomerLockForAPI()` from within a function that already holds the lock.
 * If you need to compose locked operations, have them accept `LockedTransaction`.
 */

import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import { db, type Database, type DatabaseOrTransaction } from './db';
import { adminNotifications } from './schema';

// ============================================================================
// Types
// ============================================================================

/**
 * Branded type indicating the customer lock is held.
 *
 * Functions accepting this type signal:
 * - They expect to be called within `withCustomerLockForAPI()`
 * - They must NEVER call `withCustomerLockForAPI()` themselves (would deadlock)
 *
 * Usage:
 * ```typescript
 * // Good: Function runs inside lock
 * async function updateInvoice(tx: LockedTransaction, invoiceId: string) { ... }
 *
 * // Entry point acquires lock
 * await withCustomerLockForAPI(customerId, 'updateInvoice', async (tx) => {
 *   await updateInvoice(tx, invoiceId);  // tx is LockedTransaction
 * });
 * ```
 */
export type LockedTransaction = DatabaseOrTransaction & { readonly __brand: 'LockedTransaction' };

// ============================================================================
// Constants
// ============================================================================

/**
 * PostgreSQL error code for lock timeout / lock not available
 * Class 55 = Object Not In Prerequisite State
 */
const PG_LOCK_NOT_AVAILABLE = '55P03';

/**
 * Threshold in milliseconds for logging a warning about slow lock acquisition
 */
const LOCK_WARNING_THRESHOLD_MS = 5000; // 5 seconds

/**
 * Lock timeout configured in PostgreSQL
 */
const LOCK_TIMEOUT_MS = 10000; // 10 seconds

// ============================================================================
// Error Detection
// ============================================================================

/**
 * Check if an error is a PostgreSQL lock timeout error
 */
function isLockTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  // Check for PostgreSQL error code
  const pgError = error as { code?: string };
  if (pgError.code === PG_LOCK_NOT_AVAILABLE) {
    return true;
  }

  // Also check message for lock timeout indication
  const errorWithMessage = error as { message?: string };
  if (errorWithMessage.message?.includes('lock timeout') ||
      errorWithMessage.message?.includes('lock_not_available')) {
    return true;
  }

  return false;
}

// ============================================================================
// Admin Notification Logging
// ============================================================================

/**
 * Log a lock contention event to admin notifications
 */
async function logLockContention(
  severity: 'warning' | 'error',
  customerId: number,
  operation: string,
  durationMs: number,
  details?: Record<string, unknown>
): Promise<void> {
  try {
    await db.insert(adminNotifications).values({
      severity,
      category: 'lock_contention',
      code: severity === 'error' ? 'LOCK_TIMEOUT' : 'LOCK_SLOW_ACQUISITION',
      message: severity === 'error'
        ? `Lock timeout after ${durationMs}ms for ${operation}`
        : `Slow lock acquisition (${durationMs}ms) for ${operation}`,
      details: JSON.stringify({
        customerId,
        operation,
        durationMs,
        threshold: severity === 'error' ? LOCK_TIMEOUT_MS : LOCK_WARNING_THRESHOLD_MS,
        ...details,
      }),
      customerId: String(customerId),
    });
  } catch (logError) {
    // Don't fail the operation if logging fails - just console log
    console.error('[LOCK_CONTENTION] Failed to log to admin_notifications:', logError);
  }
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Execute a function with an exclusive customer lock
 *
 * THE ONLY locking function routes should use. Provides complete
 * lock lifecycle management with observability and error handling.
 *
 * Features:
 * - Acquires PostgreSQL advisory lock for the customer
 * - 10-second timeout (allows for on-chain operations)
 * - Logs warning if lock acquisition takes >5 seconds
 * - Logs error and returns tRPC TIMEOUT on lock timeout
 * - Records lock contention events to admin_notifications
 *
 * @param customerId Customer ID to lock
 * @param operation Name of the operation (for logging)
 * @param fn Function to execute while holding the lock
 * @param details Optional details for logging
 * @returns Result from fn
 * @throws TRPCError with code 'TIMEOUT' if lock times out (HTTP 408)
 */
export async function withCustomerLockForAPI<T>(
  customerId: number,
  operation: string,
  fn: (tx: LockedTransaction) => Promise<T>,
  details?: Record<string, unknown>
): Promise<T> {
  const startTime = Date.now();

  try {
    // Execute within transaction with advisory lock
    const result = await db.transaction(async (tx) => {
      // Set lock timeout to prevent indefinite waiting
      // 10s allows for on-chain operations (typically 3-5s) plus buffer
      await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);

      // Acquire exclusive advisory lock for this customer
      // Lock is automatically released when transaction commits or rolls back
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${customerId}::bigint)`);

      // Execute the function with the locked transaction
      return await fn(tx as unknown as LockedTransaction);
    });

    const durationMs = Date.now() - startTime;

    // Log warning if lock acquisition was slow (but successful)
    if (durationMs > LOCK_WARNING_THRESHOLD_MS) {
      console.warn(
        `[LOCK_CONTENTION] Slow lock acquisition for customer ${customerId} ` +
        `operation=${operation} duration=${durationMs}ms`
      );
      // Log to admin notifications asynchronously (don't block response)
      logLockContention('warning', customerId, operation, durationMs, details).catch(() => {});
    }

    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;

    if (isLockTimeoutError(error)) {
      // Log error for infrastructure monitoring
      console.error(
        `[LOCK_TIMEOUT] Lock timeout for customer ${customerId} ` +
        `operation=${operation} duration=${durationMs}ms`
      );

      // Log to admin notifications (await to ensure it's recorded before response)
      await logLockContention('error', customerId, operation, durationMs, details);

      // Return tRPC TIMEOUT error (maps to HTTP 408, indicates retryable)
      throw new TRPCError({
        code: 'TIMEOUT',
        message: 'Service temporarily busy. Please try again in a few seconds.',
        cause: error,
      });
    }

    // Re-throw non-lock errors unchanged
    throw error;
  }
}

// ============================================================================
// Low-Level Utilities (for internal use)
// ============================================================================

/**
 * Execute a function with an exclusive customer lock (internal, no observability)
 *
 * NOTE: Prefer withCustomerLockForAPI() for routes. This is for internal
 * operations that don't need tRPC error handling.
 *
 * @param database Database instance
 * @param customerId Customer ID to lock
 * @param fn Function to execute while holding the lock
 * @returns Result from fn
 */
export async function withCustomerLock<T>(
  database: Database,
  customerId: number,
  fn: (tx: LockedTransaction) => Promise<T>
): Promise<T> {
  return await database.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${customerId}::bigint)`);
    return await fn(tx as unknown as LockedTransaction);
  });
}

/**
 * Try to acquire a customer lock without blocking
 *
 * Returns immediately with success/failure. Useful for detecting concurrent operations.
 *
 * @param tx Transaction handle
 * @param customerId Customer ID to lock
 * @returns true if lock acquired, false if already locked by another session
 */
export async function tryCustomerLock(
  tx: DatabaseOrTransaction,
  customerId: number
): Promise<boolean> {
  const result = await tx.execute<{ pg_try_advisory_xact_lock: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(${customerId}::bigint)`
  );

  return result.rows[0]?.pg_try_advisory_xact_lock ?? false;
}

/**
 * TEST HELPER: Cast a transaction to LockedTransaction for testing
 *
 * WARNING: This bypasses the lock safety mechanism. Only use in tests
 * where you're directly testing internal functions that would normally
 * be called from within withCustomerLockForAPI().
 *
 * For production code, always use withCustomerLockForAPI() to properly acquire locks.
 *
 * @param tx Transaction or database handle
 * @returns Same handle cast to LockedTransaction
 */
export function unsafeAsLockedTransaction(tx: DatabaseOrTransaction): LockedTransaction {
  return tx as unknown as LockedTransaction;
}
