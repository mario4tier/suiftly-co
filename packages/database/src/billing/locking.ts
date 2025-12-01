/**
 * Customer-Level Locking for Billing Operations
 *
 * Uses PostgreSQL advisory locks to ensure only one billing operation
 * runs per customer at a time, preventing race conditions.
 *
 * See BILLING_DESIGN.md R11 for detailed requirements.
 */

import { sql } from 'drizzle-orm';
import type { Database, DatabaseOrTransaction } from '../db';

/**
 * Execute a function with an exclusive customer lock
 *
 * Acquires a PostgreSQL advisory lock for the customer, executes the function,
 * and automatically releases the lock when done (via transaction commit/rollback).
 *
 * @param db Database instance (must support transactions)
 * @param customerId Customer ID to lock
 * @param fn Function to execute while holding the lock
 * @returns Result from fn
 * @throws Error if lock cannot be acquired within timeout (10 seconds)
 */
export async function withCustomerLock<T>(
  db: Database,
  customerId: number,
  fn: (tx: DatabaseOrTransaction) => Promise<T>
): Promise<T> {
  return await db.transaction(async (tx) => {
    // Set lock timeout to prevent indefinite waiting
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);

    // Acquire exclusive advisory lock for this customer
    // Lock is automatically released when transaction commits or rolls back
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${customerId}::bigint)`);

    // Execute the function with the transaction
    return await fn(tx);
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
